/**
 * Tests for the `POST /documents` upload endpoint (apps/api).
 *
 * Covers:
 *   - text path: text/markdown body → document indexed + runBatchIngest runs
 *   - html/binary path: text/html body → ai.toMarkdown stub called → document indexed
 *   - unsupported content type → 415
 *   - oversize body → 413
 *   - duplicate fingerprint → deduped (no new chunks)
 */
import { env } from "cloudflare:test"
import {
  type BrainBindings,
  type ClerkIdentity,
  type ClerkVerifier,
  GatewayBudgetError,
  ScopedDB,
  ScopedGraph,
  ScopedR2,
  type ScopedServices,
  ScopedVectorize,
  TranscriptionError,
  WikiStore,
} from "@brain/db"
import { AUDIO_MAX_BYTES, MAX_BODY_BYTES, type Principal, WHISPER_MODEL } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src/index"
import { seedMembership, seedOrg } from "./seed"

const env_ = env as unknown as BrainBindings

const TENANT = "uploadOrg"
const TENANT_SLUG = "upload-slug"
const USER = "uploadUser"

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

const makeFakeVectorize = () => {
  const store = new Map<string, { namespace: string | undefined }>()
  const index = {
    upsert: async (vectors: { id: string; namespace?: string }[]) => {
      for (const v of vectors) store.set(v.id, { namespace: v.namespace })
      return { mutationId: "fake", count: vectors.length, ids: vectors.map((v) => v.id) }
    },
    query: async (_values: number[], opts?: { namespace?: string }) => {
      const matches = [...store.entries()]
        .filter(([, v]) => v.namespace === opts?.namespace)
        .map(([id]) => ({ id, score: 0.95 }))
      return { count: matches.length, matches }
    },
  } as unknown as Vectorize
  return index
}

const fakeVectorize = makeFakeVectorize()

/** Track ai.toMarkdown calls to assert binary path routes through it. */
let toMarkdownCallCount = 0
let toMarkdownLastName = ""

/** Canned voice transcript + a toggle to exercise the fail-visibly (throw) path. */
const CANNED_TRANSCRIPT = "This is the transcribed voice memo. needle-voice"
let transcribeShouldThrow = false
/** Toggle: make transcribe() reject with a GatewayBudgetError (exercises the route's 429 mapping). */
let transcribeThrowBudget = false
/** Per-test transcript override so a test can produce a UNIQUE fingerprint (default: the canned one). */
let transcriptOverride: string | null = null

const makeServices = (e: BrainBindings, principal: Principal): ScopedServices => ({
  db: new ScopedDB(drizzle(e.DB), principal),
  vectors: new ScopedVectorize(fakeVectorize, principal),
  entityVectors: new ScopedVectorize(fakeVectorize, principal),
  graph: new ScopedGraph(drizzle(e.DB), principal),
  wiki: new WikiStore(drizzle(e.DB), principal),
  blobs: new ScopedR2(e.BODIES, principal),
  ai: {
    embed: async (texts) => texts.map(() => vec1024()),
    embedForIndex: async (texts) => texts.map(() => vec1024()),
    gen: async (prompt) => `answer:\n${prompt.slice(0, 80)}`,
    genExtract: async () => null,
    rerank: async (_q, candidates, topK) =>
      candidates.map((_c, i) => ({ index: i, score: 0 })).slice(0, topK),
    toMarkdown: async (name: string, _buf: ArrayBuffer): Promise<string> => {
      toMarkdownCallCount++
      toMarkdownLastName = name
      return `# Converted\n\nThis is the extracted markdown from ${name}.`
    },
    transcribe: async (_audio) => {
      // Model the real chokepoint's contract: it rethrows GatewayBudgetError (route → 429) and throws
      // TranscriptionError on other failures (route → 422); a plain Error would misrepresent the taxonomy.
      if (transcribeThrowBudget) throw new GatewayBudgetError()
      if (transcribeShouldThrow) throw new TranscriptionError("whisper down")
      return { text: transcriptOverride ?? CANNED_TRANSCRIPT, neurons: 60 }
    },
  },
})

const fakeVerifier = (identity: ClerkIdentity): ClerkVerifier => ({ verify: async () => identity })

const app = createApp({
  clerkVerifier: fakeVerifier({ userId: USER }),
  makeServices,
  inlineIngest: true,
})

const makeCtx = () => {
  const tasks: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext
  return { ctx, flush: () => Promise.all(tasks) }
}

const headers = (contentType: string): Record<string, string> => ({
  Authorization: "Bearer clerk.fake.jwt",
  "X-Brain-Tenant": TENANT_SLUG,
  "Content-Type": contentType,
})

beforeAll(async () => {
  await seedOrg(TENANT, TENANT_SLUG)
  await seedMembership({ tenantId: TENANT, userId: USER })
})

describe("POST /documents — text path (text/markdown, text/plain)", () => {
  test("indexes a text/markdown body: status=indexed, chunks>0, body in R2", async () => {
    const body = "# Hello Upload\n\nThis document was uploaded via POST /documents. needle123"
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-md-test",
      { method: "POST", headers: headers("text/markdown"), body },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as {
      status: string
      chunkCount: number
      documentId: string
      slug: string
    }
    expect(out.status).toBe("indexed")
    expect(out.chunkCount).toBeGreaterThan(0)
    expect(out.slug).toBe("upload-md-test")

    // Document row exists and is indexed.
    const doc = await env.DB.prepare("SELECT status, content_type FROM documents WHERE id = ?")
      .bind(out.documentId)
      .first<{ status: string; content_type: string }>()
    expect(doc?.status).toBe("indexed")
    expect(doc?.content_type).toBe("text/markdown")

    // Body stored in R2 under the tenant prefix.
    const r2 = await env.BODIES.get(`${TENANT}/documents/${out.documentId}`)
    expect(r2).not.toBeNull()
    expect(await r2?.text()).toContain("needle123")
  })

  test("indexes a text/plain body", async () => {
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-plain-test",
      { method: "POST", headers: headers("text/plain"), body: "Plain text content. needle456" },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string }
    expect(out.status).toBe("indexed")
  })

  test("title query param is stored on the documents row", async () => {
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-titled&title=My+Document",
      { method: "POST", headers: headers("text/markdown"), body: "# Title Test\n\nContent." },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as { documentId: string; status: string }
    expect(out.status).toBe("indexed")
    const doc = await env.DB.prepare("SELECT title FROM documents WHERE id = ?")
      .bind(out.documentId)
      .first<{ title: string | null }>()
    expect(doc?.title).toBe("My Document")
  })
})

describe("POST /documents — binary/HTML path (env.AI.toMarkdown chokepoint)", () => {
  test("text/html body routes through ai.toMarkdown and indexes the result", async () => {
    const before = toMarkdownCallCount
    const htmlBody = "<html><body><h1>Hello</h1><p>HTML content</p></body></html>"
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-html-test",
      {
        method: "POST",
        headers: { ...headers("text/html"), "x-filename": "page.html" },
        body: htmlBody,
      },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string; chunkCount: number }
    expect(out.status).toBe("indexed")
    expect(out.chunkCount).toBeGreaterThan(0)
    // ai.toMarkdown was called exactly once for this request.
    expect(toMarkdownCallCount).toBe(before + 1)
    expect(toMarkdownLastName).toBe("page.html")
  })

  test("application/pdf body routes through ai.toMarkdown (uses fallback filename)", async () => {
    const before = toMarkdownCallCount
    const fakePdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF magic bytes
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-pdf-test",
      { method: "POST", headers: headers("application/pdf"), body: fakePdf },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string }
    expect(out.status).toBe("indexed")
    expect(toMarkdownCallCount).toBe(before + 1)
    // No x-filename header → fallback filename is "upload.pdf"
    expect(toMarkdownLastName).toBe("upload.pdf")
  })
})

describe("POST /documents — audio/voice path (W3.2, transcribe chokepoint)", () => {
  test("audio body: transcript becomes the body, content_type='voice', pipeline runs", async () => {
    transcribeShouldThrow = false
    const audio = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]) // ftyp-ish
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-voice-test",
      { method: "POST", headers: headers("audio/mp4"), body: audio },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string; chunkCount: number; documentId: string }
    expect(out.status).toBe("indexed")
    expect(out.chunkCount).toBeGreaterThan(0)

    // documents row is marked as voice origin.
    const doc = await env.DB.prepare("SELECT status, content_type FROM documents WHERE id = ?")
      .bind(out.documentId)
      .first<{ status: string; content_type: string }>()
    expect(doc?.status).toBe("indexed")
    expect(doc?.content_type).toBe("voice")

    // Body in R2 is the TRANSCRIPT (not the raw audio).
    const body = await env.BODIES.get(`${TENANT}/documents/${out.documentId}`)
    expect(await body?.text()).toContain("needle-voice")

    // Raw audio staged at the derivable provenance key.
    const rawAudio = await env.BODIES.get(`${TENANT}/documents/audio/${out.documentId}`)
    expect(rawAudio).not.toBeNull()

    // Whisper spend attributed with surface='ingest'.
    const spend = await env.DB.prepare(
      "SELECT surface, neurons FROM token_spend WHERE tenant_id = ? AND model = ?",
    )
      .bind(TENANT, WHISPER_MODEL)
      .first<{ surface: string; neurons: number }>()
    expect(spend?.surface).toBe("ingest")
    expect(spend?.neurons).toBeGreaterThan(0)
  })

  test("failed transcription fails visibly: no document row AND no audio blob (422)", async () => {
    transcribeShouldThrow = true
    const countDocs = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM documents WHERE content_type = 'voice'",
        ).first<{ n: number }>()
      )?.n ?? 0
    const countAudio = async () =>
      (await env.BODIES.list({ prefix: `${TENANT}/documents/audio/` })).objects.length

    const docsBefore = await countDocs()
    const audioBefore = await countAudio()
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/documents?slug=upload-voice-fail",
      { method: "POST", headers: headers("audio/mp4"), body: new Uint8Array([1, 2, 3, 4]) },
      env_,
      ctx,
    )
    await flush()
    // A transcription failure is a 422 (fails visibly), not a silent empty doc.
    expect(res.status).toBe(422)
    expect(await countDocs()).toBe(docsBefore)
    // No orphan audio blob (audio is stored only AFTER a committed doc row).
    expect(await countAudio()).toBe(audioBefore)
    transcribeShouldThrow = false
  })

  test("duplicate voice upload: first creates audio, second dedups with no NEW blob", async () => {
    transcribeShouldThrow = false
    // Unique transcript → first upload is a genuine create (not a dup of the earlier success test).
    transcriptOverride = "a unique dedup-test transcript qwerty-dup-marker"
    const countAudio = async () =>
      (await env.BODIES.list({ prefix: `${TENANT}/documents/audio/` })).objects.length
    const audioBody = new Uint8Array([0x64, 0x75, 0x70, 0x65])
    const post = async () => {
      const { ctx, flush } = makeCtx()
      const res = await app.request(
        "/documents?slug=upload-voice-dup",
        { method: "POST", headers: headers("audio/mp4"), body: audioBody },
        env_,
        ctx,
      )
      await flush()
      return res
    }
    try {
      const audioBefore = await countAudio()
      const first = await post()
      expect(first.status).toBe(200)
      expect(((await first.json()) as { status: string }).status).toBe("indexed")
      // Non-vacuity: the create DID write a new audio blob.
      const audioAfterFirst = await countAudio()
      expect(audioAfterFirst).toBe(audioBefore + 1)

      const second = await post()
      expect(second.status).toBe(200)
      expect(((await second.json()) as { status: string }).status).toBe("duplicate")
      // The dedup path returns BEFORE storing audio → count unchanged.
      expect(await countAudio()).toBe(audioAfterFirst)
    } finally {
      transcriptOverride = null
    }
  })

  test("whisper is gated on the monthly cost ceiling (429 before the AI call)", async () => {
    transcribeShouldThrow = false
    // Seed spend over the ceiling for the current window, then expect the pre-check to 429.
    const window = new Date().toISOString().slice(0, 7)
    await env.DB.prepare(
      "INSERT INTO token_spend (id, tenant_id, window, model, surface, neurons) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(`ceiling-${window}`, TENANT, window, "@cf/test/over", "ingest", 1e12)
      .run()
    try {
      const { ctx } = makeCtx()
      const res = await app.request(
        "/documents?slug=upload-voice-ceiling",
        { method: "POST", headers: headers("audio/mp4"), body: new Uint8Array([1, 2, 3, 4]) },
        env_,
        ctx,
      )
      expect(res.status).toBe(429)
    } finally {
      // Clean up so later tests (which share TENANT) are not gated.
      await env.DB.prepare("DELETE FROM token_spend WHERE id = ?").bind(`ceiling-${window}`).run()
    }
  })

  test("a GatewayBudgetError from transcribe() maps to 429 (defense-in-depth behind the pre-check)", async () => {
    transcribeThrowBudget = true
    try {
      const { ctx } = makeCtx()
      const res = await app.request(
        "/documents?slug=upload-voice-budget",
        { method: "POST", headers: headers("audio/mp4"), body: new Uint8Array([1, 2, 3, 4]) },
        env_,
        ctx,
      )
      expect(res.status).toBe(429)
    } finally {
      transcribeThrowBudget = false
    }
  })

  test("oversize audio (> AUDIO_MAX_BYTES) returns 413", async () => {
    const { ctx } = makeCtx()
    const big = new Uint8Array(AUDIO_MAX_BYTES + 1)
    const res = await app.request(
      "/documents",
      { method: "POST", headers: headers("audio/mp4"), body: big },
      env_,
      ctx,
    )
    expect(res.status).toBe(413)
  })

  test("oversized Content-Length header is rejected 413 BEFORE buffering (tiny body)", async () => {
    const { ctx } = makeCtx()
    // A truthful body is tiny, but the declared Content-Length exceeds the audio cap → reject early.
    const res = await app.request(
      "/documents",
      {
        method: "POST",
        headers: { ...headers("audio/mp4"), "content-length": String(AUDIO_MAX_BYTES + 1) },
        body: new Uint8Array([1, 2, 3, 4]),
      },
      env_,
      ctx,
    )
    expect(res.status).toBe(413)
  })
})

describe("POST /documents — error paths", () => {
  test("returns 413 when body exceeds MAX_BODY_BYTES", async () => {
    const { ctx } = makeCtx()
    // Create a buffer just over MAX_BODY_BYTES (8MiB).
    const big = new Uint8Array(MAX_BODY_BYTES + 1)
    const res = await app.request(
      "/documents",
      { method: "POST", headers: headers("text/markdown"), body: big },
      env_,
      ctx,
    )
    expect(res.status).toBe(413)
  })

  test("returns 415 for an unsupported content type", async () => {
    const { ctx } = makeCtx()
    const res = await app.request(
      "/documents",
      {
        method: "POST",
        headers: headers("application/octet-stream"),
        body: "binary",
      },
      env_,
      ctx,
    )
    expect(res.status).toBe(415)
  })

  test("returns duplicate for a repeated identical document", async () => {
    const body = "# Dedup Test\n\nThis exact content should dedup."
    const post = async () => {
      const { ctx, flush } = makeCtx()
      const res = await app.request(
        "/documents?slug=upload-dedup-test",
        { method: "POST", headers: headers("text/markdown"), body },
        env_,
        ctx,
      )
      await flush()
      return res
    }
    const first = await post()
    expect(first.status).toBe(200)
    const second = await post()
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { status: string; deduped: boolean }
    expect(secondBody.status).toBe("duplicate")
    expect(secondBody.deduped).toBe(true)
  })
})

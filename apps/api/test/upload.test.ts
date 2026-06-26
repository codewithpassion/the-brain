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
  ScopedDB,
  ScopedGraph,
  ScopedR2,
  type ScopedServices,
  ScopedVectorize,
} from "@brain/db"
import { MAX_BODY_BYTES, type Principal } from "@brain/shared"
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

const makeServices = (e: BrainBindings, principal: Principal): ScopedServices => ({
  db: new ScopedDB(drizzle(e.DB), principal),
  vectors: new ScopedVectorize(fakeVectorize, principal),
  entityVectors: new ScopedVectorize(fakeVectorize, principal),
  graph: new ScopedGraph(drizzle(e.DB), principal),
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

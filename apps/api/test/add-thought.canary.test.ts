import { env } from "cloudflare:test"
import { type BrainBindings, createScopedServices, ScopedDB } from "@brain/db"
import type { Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext } from "@brain/surface"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { seedMembership, seedOrg } from "./seed"

/**
 * add_thought canary (W3.3) — drives the REAL surface op through the ingest spine over local D1
 * in workerd. Proves a captured thought (1) lands under `brain/thoughts/<yyyy-mm>` tagged
 * `thought`, (2) is FTS-searchable in the author's tenant, and (3) is tenant-isolated (a second
 * tenant's FTS arm never surfaces it).
 */

const env_ = env as unknown as BrainBindings

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

/** Fake Workers AI: bge-m3 embed shape — one 1024-dim row per input text (indexing needs this). */
const fakeAi = {
  run: async (_model: string, inputs: Record<string, unknown>) => ({
    data: ((inputs.text as string[] | undefined) ?? [""]).map(() => vec1024()),
  }),
} as unknown as BrainBindings["AI"]

/** Fake Vectorize: accepts index upserts + returns nothing on query (FTS arm carries the search). */
const fakeVectorize = {
  upsert: async (vectors: { id: string }[]) => ({
    mutationId: "fake",
    count: vectors.length,
    ids: vectors.map((v) => v.id),
  }),
  query: async () => ({ count: 0, matches: [] }),
} as unknown as Vectorize

/** ctx.env WITHOUT BATCH_INGEST so add_thought runs the ingest pipeline INLINE (no workflow). */
const ctxEnv = {
  ...env_,
  CHUNK_INDEX: fakeVectorize,
  ENTITY_INDEX: fakeVectorize,
  AI: fakeAi,
  AI_GATEWAY_ID: "test-gateway",
  BATCH_INGEST: undefined,
} as unknown as SurfaceContext["env"]

const ownerOf = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const principalA = ownerOf("thoughtA", "ownerA")
const principalB = ownerOf("thoughtB", "ownerB")

const ctxFor = (principal: Principal): SurfaceContext => ({
  principal,
  env: ctxEnv,
  waitUntil: () => {},
  surface: "mcp",
})

const catalog = buildCatalog()
const addThoughtOp = catalog.find((o) => o.def.name === "add_thought")
const reprocessOp = catalog.find((o) => o.def.name === "reprocess_document")

beforeAll(async () => {
  await seedOrg("thoughtA", "thought-a")
  await seedMembership({ tenantId: "thoughtA", userId: "ownerA" })
  await seedOrg("thoughtB", "thought-b")
  await seedMembership({ tenantId: "thoughtB", userId: "ownerB" })
})

describe("add_thought canary (W3.3) — real local D1 in workerd", () => {
  test("captures a thought under brain/thoughts, FTS-searchable, tenant-isolated", async () => {
    expect(addThoughtOp).toBeDefined()

    const out = (await addThoughtOp?.invoke(ctxFor(principalA), {
      thought: "remember to ship the qwertyneedle release next sprint",
      tags: ["release"],
    })) as { documentId: string; slug: string; status: string; chunkCount: number }

    expect(out.status).toBe("indexed")
    expect(out.chunkCount).toBeGreaterThan(0)
    expect(out.slug).toMatch(/^thought-/)

    // ── Namespace + tag on the documents row. ────────────────────────────────
    const doc = await env.DB.prepare("SELECT path, tags, content_type FROM documents WHERE id = ?")
      .bind(out.documentId)
      .first<{ path: string; tags: string; content_type: string }>()
    expect(doc?.path).toMatch(/^\/brain\/thoughts\/\d{4}-\d{2}$/)
    expect(JSON.parse(doc?.tags ?? "[]")).toContain("thought")

    // ── FTS-searchable in the author's tenant. ──────────────────────────────
    const sdbA = new ScopedDB(drizzle(env_.DB), principalA)
    const hitsA = await sdbA.ftsChunkIds("qwertyneedle", 10)
    expect(hitsA.length).toBeGreaterThan(0)

    // ── Tenant isolation: tenant B's FTS arm never surfaces A's thought. ─────
    const sdbB = new ScopedDB(drizzle(env_.DB), principalB)
    expect(await sdbB.ftsChunkIds("qwertyneedle", 10)).toEqual([])
  })

  test("repeated identical thought is handled gracefully (kept OR clean duplicate, never an error)", async () => {
    // add_thought uses a time-stamped fingerprint so identical thoughts are normally KEPT as separate
    // docs; the duplicate backstop (mirrors ingest_document) only fires on a genuine (tenant,slug|fp)
    // collision. Either way the op must return the documented shape and never throw.
    const call = () =>
      addThoughtOp?.invoke(ctxFor(principalA), {
        thought: "a repeated identical thought",
      }) as Promise<{
        documentId: string | null
        slug: string
        status: string
      }>
    const first = await call()
    const second = await call()
    for (const r of [first, second]) {
      expect(["indexed", "accepted", "duplicate"]).toContain(r.status)
      expect(typeof r.slug).toBe("string")
    }
  })

  test("reprocess of a voice doc re-ingests the transcript as text (never re-transcribes)", async () => {
    // Seed a voice doc directly: content_type='voice', body = the transcript (already text) in R2.
    const services = createScopedServices(ctxEnv, principalA)
    const docId = crypto.randomUUID()
    const r2Key = `documents/${docId}`
    await services.db.insertDocument({
      id: docId,
      slug: `voice-reprocess-${docId.slice(0, 8)}`,
      fingerprint: `fp-voice-${docId}`,
      contentType: "voice",
      bodyR2Key: r2Key,
      status: "indexed",
    })
    await services.blobs.put(r2Key, "the voice transcript body reprocessmarker text")

    // Reprocess must succeed (maps 'voice' → text/markdown for chunking; no transcribe() call).
    const out = (await reprocessOp?.invoke(ctxFor(principalA), { documentId: docId })) as {
      documentId: string
      status: string
    }
    expect(out.status).toBe("indexed")

    // The origin marker stays 'voice'; the transcript re-chunked (FTS-searchable).
    const doc = await env.DB.prepare("SELECT content_type FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ content_type: string }>()
    expect(doc?.content_type).toBe("voice")
    const sdbA = new ScopedDB(drizzle(env_.DB), principalA)
    expect((await sdbA.ftsChunkIds("reprocessmarker", 10)).length).toBeGreaterThan(0)
  })
})

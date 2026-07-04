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
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src/index"
import { MONTHLY_NEURON_CEILING, monthlyWindow } from "../src/ports"
import { seedMembership, seedOrg } from "./seed"

/**
 * THE Phase-2c end-to-end vertical-slice test (PRD "First vertical slice", §4/§5).
 *
 * Proves the measurable goal over REAL local D1 + R2 inside workerd: a markdown doc POSTed to
 * `/ingest` is fingerprinted → staged in R2 → ingested (extract→chunk→embed→dual-index) →
 * and `think` returns cited evidence over THAT document. The AI + Vectorize seams are
 * DETERMINISTIC stubs (no live binding): `embed`/`embedForIndex` return fixed 1024-dim
 * vectors (one per input text), `gen` echoes the synthesis context, and a fake Vectorize
 * STORES upserts and returns them on query (so the vector arm re-finds the chunk through the
 * mandatory D1 re-check). The REAL `ScopedDB`/`ScopedR2`/`BudgetPort`/`RecallSink` are used —
 * so the budget reads real `token_spend` and the recall write runs off the read path.
 *
 * The two-tenant isolation canary (think.canary.test.ts) stays the security proof; this test
 * is the FUNCTIONAL slice (ingest→think cites the doc; a re-POST dedups with no new chunks).
 */

const env_ = env as unknown as BrainBindings

const TENANT = "sliceOrg"
const TENANT_SLUG = "slice-slug"
const USER = "sliceUser"
const DOC_SLUG = "slice-doc"
const NEEDLE = "sliceneedle"
const BODY = `# Slice Doc\n\nThe quick brown fox jumps over the lazy dog. This paragraph holds the unique ${NEEDLE} marker that the think query will retrieve.`

const slicePrincipal: Principal = {
  tenantId: TENANT,
  userId: USER,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
}

/** A nonzero fixed 1024-dim vector (a zero vector has undefined cosine). */
const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

/** Records every upsert (with the stamped namespace) and returns stored ids on query. */
const makeFakeVectorize = () => {
  const upserts: {
    id: string
    namespace: string | undefined
    metadata: Record<string, unknown> | undefined
  }[] = []
  const store = new Map<string, { namespace: string | undefined }>()
  const index = {
    upsert: async (
      vectors: { id: string; namespace?: string; metadata?: Record<string, unknown> }[],
    ) => {
      for (const v of vectors) {
        upserts.push({ id: v.id, namespace: v.namespace, metadata: v.metadata })
        store.set(v.id, { namespace: v.namespace })
      }
      return { mutationId: "fake", count: vectors.length, ids: vectors.map((v) => v.id) }
    },
    // Surface every id stored UNDER THE QUERY NAMESPACE with a high cosine (≥ COSINE_FLOOR).
    query: async (_values: number[], opts?: { namespace?: string }) => {
      const matches = [...store.entries()]
        .filter(([, v]) => v.namespace === opts?.namespace)
        .map(([id]) => ({ id, score: 0.95 }))
      return { count: matches.length, matches }
    },
  } as unknown as Vectorize
  return { index, upserts }
}

/** Deterministic AI stub: one vector per text; `gen` quotes the synthesis context. */
const aiStub: ScopedServices["ai"] = {
  embed: async (texts) => texts.map(() => vec1024()),
  embedForIndex: async (texts) => texts.map(() => vec1024()),
  gen: async (prompt) => `SYNTHESIS over evidence:\n${prompt.slice(0, 240)}`,
  // KG extraction degrades to a no-op here — the slice exercises ingest→think, not the graph.
  genExtract: async () => null,
  rerank: async (_q, candidates, topK) =>
    candidates.map((_c, index) => ({ index, score: 0 })).slice(0, topK),
  transcribe: async () => ({ text: "stub transcript", neurons: 0 }),
}

const fakeVerifier = (identity: ClerkIdentity): ClerkVerifier => ({ verify: async () => identity })

/** A captured-waitUntil ExecutionContext so off-path D1 writes can be flushed + awaited. */
const makeCtx = () => {
  const tasks: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext
  return { ctx, flush: () => Promise.all(tasks) }
}

const fakeVectorize = makeFakeVectorize()

/** The injected service builder: REAL D1/R2/budget/recall, FAKE Vectorize + AI. */
const makeServices = (e: BrainBindings, principal: Principal): ScopedServices => ({
  db: new ScopedDB(drizzle(e.DB), principal),
  vectors: new ScopedVectorize(fakeVectorize.index, principal),
  entityVectors: new ScopedVectorize(fakeVectorize.index, principal),
  graph: new ScopedGraph(drizzle(e.DB), principal),
  wiki: new WikiStore(drizzle(e.DB), principal),
  blobs: new ScopedR2(e.BODIES, principal),
  ai: aiStub,
})

const app = createApp({
  clerkVerifier: fakeVerifier({ userId: USER }),
  makeServices,
  inlineIngest: true,
})

const headers = (contentType: string): Record<string, string> => ({
  Authorization: "Bearer clerk.fake.jwt",
  "X-Brain-Tenant": TENANT_SLUG,
  "Content-Type": contentType,
})

const ingest = async (): Promise<Response> => {
  const { ctx, flush } = makeCtx()
  const res = await app.request(
    `/ingest?slug=${DOC_SLUG}`,
    { method: "POST", headers: headers("text/markdown"), body: BODY },
    env_,
    ctx,
  )
  await flush()
  return res
}

const countChunks = async (): Promise<number> => {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ?")
    .bind(TENANT)
    .first<{ n: number }>()
  return row?.n ?? 0
}

beforeAll(async () => {
  await seedOrg(TENANT, TENANT_SLUG)
  await seedMembership({ tenantId: TENANT, userId: USER })
})

describe("vertical slice: ingest → think cites the doc (real local D1 + R2)", () => {
  test("POST /ingest indexes the doc: documents/chunks/chunks_fts + vector upsert (namespace=tenant)", async () => {
    const res = await ingest()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; chunkCount: number; documentId: string }
    expect(body.status).toBe("indexed")
    expect(body.chunkCount).toBeGreaterThan(0)

    // documents row finalized to `indexed`, with the preview (body itself lives only in R2).
    const doc = await env.DB.prepare(
      "SELECT status, markdown_preview, body_r2_key FROM documents WHERE id = ?",
    )
      .bind(body.documentId)
      .first<{ status: string; markdown_preview: string; body_r2_key: string }>()
    expect(doc?.status).toBe("indexed")
    expect(doc?.markdown_preview).toContain(NEEDLE)

    // The full body is in R2 under the tenant prefix; D1 holds the preview only (invariant 13).
    const r2 = await env.BODIES.get(`${TENANT}/${doc?.body_r2_key}`)
    expect(await r2?.text()).toContain(NEEDLE)

    // chunks rows landed for the tenant.
    expect(await countChunks()).toBeGreaterThan(0)

    // chunks_fts was populated by the DB triggers off the Drizzle insert (FTS arm works).
    const sdb = new ScopedDB(drizzle(env_.DB), slicePrincipal)
    expect((await sdb.ftsChunkIds(NEEDLE, 10)).length).toBeGreaterThan(0)

    // The vector arm was fed via ScopedVectorize.upsert with namespace = tenantId.
    expect(fakeVectorize.upserts.length).toBeGreaterThan(0)
    expect(fakeVectorize.upserts.every((u) => u.namespace === TENANT)).toBe(true)
    expect(fakeVectorize.upserts.every((u) => u.metadata?.tenant_id === TENANT)).toBe(true)
  })

  test("POST /think returns a cited answer over the ingested document", async () => {
    const { ctx, flush } = makeCtx()
    const res = await app.request(
      "/think",
      {
        method: "POST",
        headers: headers("application/json"),
        body: JSON.stringify({ query: NEEDLE, topK: 12 }),
      },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(200)
    const out = (await res.json()) as {
      answer: string
      evidence: { slug: string }[]
      citations: { slug: string; chunkId: string }[]
    }

    // Synthesis ran, and the evidence + citations come from THIS document's slug.
    expect(out.answer.length).toBeGreaterThan(0)
    expect(out.evidence.length).toBeGreaterThan(0)
    expect(out.evidence.every((e) => e.slug === DOC_SLUG)).toBe(true)
    expect(out.citations.some((c) => c.slug === DOC_SLUG)).toBe(true)
  })

  test("a second identical POST /ingest dedups — no duplicate chunks", async () => {
    const before = await countChunks()
    const res = await ingest()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; deduped?: boolean }
    expect(body.status).toBe("duplicate")
    expect(body.deduped).toBe(true)
    // The re-insert trips a `documents` UNIQUE index (here `ux_documents_tenant_slug`, since
    // this re-POST reuses the slug) → the route catches it and runs no ingest → no new chunks.
    // NOTE: the `(tenant,scope,fingerprint)` index (invariant 15) does NOT fire for null-scope
    // docs (SQLite treats NULLs as distinct), so content-only fingerprint dedup is currently
    // proven only when a scope is set or the slug collides — flagged to the lead (frozen-schema).
    expect(await countChunks()).toBe(before)
  })
})

/**
 * RUN_AI_GATES variant note (NOT required to pass in CI — a VISIBLE skip by default).
 *
 * The slice above proves the wiring against DETERMINISTIC stubs. The SAME route flow runs
 * against REAL Workers AI on a DEPLOYED / remote run (where `env.AI` + the `CHUNK_INDEX`
 * Vectorize V2 index are actually bound — neither has local miniflare emulation):
 *
 *   createApp({ inlineIngest: true })  // NO makeServices override → real createScopedServices
 *
 * Then `POST /ingest` runs bge-m3 `embedForIndex` (asserts 1024d) + a live
 * `CHUNK_INDEX.upsert(namespace=tenantId)`, and `POST /think` runs bge-m3 embed → live
 * Vectorize query → bge-reranker → llama-3.3-70b cited synthesis. The team-lead runs this
 * real measurement separately (it is gated, like the reranker live-shape gate, on
 * `RUN_AI_GATES=1` and a bound `env.AI`).
 */
const RUN_AI_GATES = (env as unknown as { RUN_AI_GATES?: string }).RUN_AI_GATES === "1"
describe.skipIf(!RUN_AI_GATES)("slice against REAL Workers AI (RUN_AI_GATES=1, deployed)", () => {
  test.todo("ingest→think over bge-m3 + bge-reranker + llama-3.3-70b cites the doc (run remote)")
})

describe("BudgetPort 429 pre-check (invariant 16) — real token_spend", () => {
  test("a tenant over the monthly ceiling gets 429 from /think (before any AI call)", async () => {
    const BUDGET_TENANT = "budgetOrg"
    await seedOrg(BUDGET_TENANT, "budget-slug")
    await seedMembership({ tenantId: BUDGET_TENANT, userId: "budgetUser" })
    // Seed spend CLEARLY over the ceiling (so the neuron→USD constant's exact value can't make
    // this fragile).
    await env.DB.prepare(
      "INSERT INTO token_spend (id, tenant_id, window, model, neurons, updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "ts-over",
        BUDGET_TENANT,
        monthlyWindow(),
        "@cf/baai/bge-m3",
        MONTHLY_NEURON_CEILING * 10,
        "2026-06-25T00:00:00.000Z",
      )
      .run()

    const budgetApp = createApp({
      clerkVerifier: fakeVerifier({ userId: "budgetUser" }),
      makeServices,
      inlineIngest: true,
    })
    const { ctx, flush } = makeCtx()
    const res = await budgetApp.request(
      "/think",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer clerk.fake.jwt",
          "X-Brain-Tenant": "budget-slug",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: NEEDLE, topK: 12 }),
      },
      env_,
      ctx,
    )
    await flush()
    expect(res.status).toBe(429)
  })
})

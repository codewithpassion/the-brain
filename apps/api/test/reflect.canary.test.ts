import { env } from "cloudflare:test"
import {
  type BrainBindings,
  type DreamDispatchEnv,
  type DreamReflectServices,
  DreamRunStore,
  dispatchDreamRun,
  runDreamReflection,
  ScopedDB,
  ScopedGraph,
  ScopedR2,
  ScopedVectorize,
  selectReflectionTargets,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { seedChunk, seedDoc } from "./seed"

/**
 * THE Phase-2 reflection canary (v2 W1/D2) — `runDreamReflection` against REAL local D1 + R2 in
 * workerd, reusing the real `think` pipeline with deterministic AI seams. Proves:
 *   - reflection produces a cited, `draft`-trust INSIGHT document (`origin='dream'`, namespace
 *     `/brain/insights/…`, tag 'insight'), ingested through the normal spine, tenant-isolated;
 *   - ANTI-LOOP (D-i2): `origin='dream'` docs are never targets;
 *   - per-arm quotas surface BOTH entity and namespace targets (no starvation);
 *   - a scope-limited principal never reflects over out-of-scope entities/namespaces (isolation);
 *   - pre-think dedup skips a target whose insight already exists;
 *   - a tiny neuron budget pauses (resumable) and a same-day re-run is a no-op.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const vec1024 = (): number[] => new Array(1024).fill(0)

const systemAdmin = (tenantId: string, allowedScopes: "*" | string[] = "*"): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes,
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const fakeIndex = (matches: { id: string; score: number }[]) =>
  ({
    query: async () => ({ count: matches.length, matches }),
    upsert: async () => ({ mutationId: "m" }),
  }) as unknown as Vectorize

const reflectServices = (
  tenantId: string,
  matches: { id: string; score: number }[],
): DreamReflectServices => {
  const p = systemAdmin(tenantId)
  const rawDb = raw()
  return {
    db: new ScopedDB(rawDb, p),
    vectors: new ScopedVectorize(fakeIndex(matches), p),
    entityVectors: new ScopedVectorize(fakeIndex([]), p),
    graph: new ScopedGraph(rawDb, p),
    blobs: new ScopedR2(env_.BODIES, p),
    ai: {
      embed: async () => [vec1024()],
      embedForIndex: async (texts: string[]) => texts.map(() => vec1024()),
      gen: async () =>
        "Pricing is $99/mo, recently reduced from $129. Open question: the enterprise tier. [cited]",
      genExtract: async () => null,
      rerank: async (_q: string, c: { text: string }[], k: number) =>
        c.map((_x, i) => ({ index: i, score: 0 })).slice(0, k),
      transcribe: async () => ({ text: "stub transcript", neurons: 0 }),
    },
    raw: rawDb,
    runs: new DreamRunStore(rawDb, p),
    principal: p,
  }
}

const count = async (sql: string, binds: unknown[]): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

const STAMP = "2026-06-25T00:00:00.000Z"

const seedEntity = async (opts: {
  id: string
  tenantId: string
  name: string
  scope?: string | null
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
                           mention_count, scope, visibility, created_at, updated_at)
     VALUES (?, ?, 'concept', ?, '[]', '', '[]', 0, ?, 'world', ?, ?)`,
  )
    .bind(opts.id, opts.tenantId, opts.name, opts.scope ?? null, STAMP, STAMP)
    .run()
}

const seedMention = async (opts: {
  id: string
  tenantId: string
  entityId: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entity_mentions (id, tenant_id, entity_id, source_kind, source_id, created_at)
     VALUES (?, ?, ?, 'session', ?, ?)`,
  )
    .bind(opts.id, opts.tenantId, opts.entityId, `sess-${opts.id}`, STAMP)
    .run()
}

beforeAll(async () => {
  // rA — three themed docs under one namespace + a dream-origin decoy doc.
  for (const n of ["a", "b", "c"]) {
    await seedDoc({
      id: `rA-doc-${n}`,
      tenantId: "rA",
      slug: `pricing-${n}`,
      path: "/brain/topics/pricing",
    })
    await seedChunk({
      id: `rA-c-${n}`,
      tenantId: "rA",
      documentId: `rA-doc-${n}`,
      content: `pricing note ${n}: the price is $99/mo`,
    })
  }
  await seedDoc({
    id: "rA-decoy",
    tenantId: "rA",
    slug: "decoy-insight",
    path: "/brain/topics/decoy",
    origin: "dream",
  })

  // rB — colliding namespace, isolation assertion.
  await seedDoc({ id: "rB-doc", tenantId: "rB", slug: "pricing-b", path: "/brain/topics/pricing" })
  await seedChunk({
    id: "rB-c",
    tenantId: "rB",
    documentId: "rB-doc",
    content: "pricing note: only rB",
  })

  // rQ — two namespaces + two entities (per-arm quota test).
  await seedDoc({ id: "rQ-d1", tenantId: "rQ", slug: "rq-1", path: "/topics/one" })
  await seedDoc({ id: "rQ-d2", tenantId: "rQ", slug: "rq-2", path: "/topics/two" })
  await seedEntity({ id: "rQ-e1", tenantId: "rQ", name: "Entity One" })
  await seedEntity({ id: "rQ-e2", tenantId: "rQ", name: "Entity Two" })
  await seedMention({ id: "rQ-m1", tenantId: "rQ", entityId: "rQ-e1" })
  await seedMention({ id: "rQ-m2", tenantId: "rQ", entityId: "rQ-e2" })

  // rS — scope isolation: a 'secret'-scoped namespace + entity.
  await seedDoc({
    id: "rS-doc",
    tenantId: "rS",
    slug: "rs-secret",
    path: "/secret/ns",
    scope: "secret",
  })
  await seedEntity({ id: "rS-e", tenantId: "rS", name: "Secret Entity", scope: "secret" })
  await seedMention({ id: "rS-m", tenantId: "rS", entityId: "rS-e" })

  // rD — pre-think dedup: a themed namespace + a PRE-EXISTING insight at its insight path.
  await seedDoc({ id: "rD-doc", tenantId: "rD", slug: "rd-1", path: "/topics/dedup" })
  await seedChunk({ id: "rD-c", tenantId: "rD", documentId: "rD-doc", content: "dedup theme note" })
  await seedDoc({
    id: "rD-insight",
    tenantId: "rD",
    slug: "rd-existing-insight",
    path: "/brain/insights/topics-dedup",
    origin: "dream",
  })

  // rP — budget-pause: two namespaces → two targets, with a chunk so synthesis spends neurons.
  await seedDoc({ id: "rP-d1", tenantId: "rP", slug: "rp-1", path: "/p/one" })
  await seedDoc({ id: "rP-d2", tenantId: "rP", slug: "rp-2", path: "/p/two" })
  await seedChunk({ id: "rP-c", tenantId: "rP", documentId: "rP-d1", content: "p theme evidence" })
})

describe("dream reflection canary (D2) — real local D1 + R2 in workerd", () => {
  test("produces a cited, draft-trust insight document (origin='dream'), tenant-isolated", async () => {
    const result = await runDreamReflection(
      reflectServices("rA", [
        { id: "rA-c-a", score: 0.95 },
        { id: "rB-c", score: 0.97 }, // adversarial cross-tenant id — dropped by the D1 re-check
      ]),
      { runId: "reflect-rA-1" },
    )
    expect(result.status).toBe("success")
    expect(result.insightDocumentIds.length).toBeGreaterThanOrEqual(1)
    const insightId = result.insightDocumentIds[0] ?? ""

    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='rA' AND origin='dream' AND path LIKE '/brain/insights/%'",
        [],
      ),
    ).toBeGreaterThanOrEqual(1)
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE tenant_id='rA' AND document_id=?", [
        insightId,
      ]),
    ).toBeGreaterThan(0)

    // Cited: the body carries a real source slug.
    const obj = await new ScopedR2(env_.BODIES, systemAdmin("rA")).get(`documents/${insightId}`)
    const body = obj === null ? "" : await obj.text()
    expect(body).toContain("## Sources")
    expect(body).toMatch(/pricing-[abc]/)

    // D-i1: an explicit draft-trust policy row exists (never reads above draft).
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_use_policy WHERE tenant_id='rA' AND target_id=? AND trust_grade='draft'",
        [insightId],
      ),
    ).toBe(1)

    // Isolation: tenant rB got NO insight from tenant rA's run.
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='rB' AND origin='dream'",
        [],
      ),
    ).toBe(0)
  })

  test("anti-loop: origin='dream' docs (incl. insights) are never reflection targets", async () => {
    const targets = await selectReflectionTargets(raw(), systemAdmin("rA"), {
      since: null,
      limit: 20,
    })
    expect(targets.some((t) => t.label === "/brain/topics/pricing")).toBe(true)
    expect(targets.every((t) => t.label !== "/brain/topics/decoy")).toBe(true)
    expect(targets.every((t) => !t.label.startsWith("/brain/insights"))).toBe(true)
  })

  test("per-arm quotas surface BOTH entity and namespace targets (no starvation)", async () => {
    const targets = await selectReflectionTargets(raw(), systemAdmin("rQ"), {
      since: null,
      limit: 3,
    })
    expect(targets.some((t) => t.key.startsWith("e:"))).toBe(true)
    expect(targets.some((t) => t.key.startsWith("n:"))).toBe(true)
  })

  test("isolation: a scope-limited principal never reflects over out-of-scope memory", async () => {
    const full = await selectReflectionTargets(raw(), systemAdmin("rS", "*"), {
      since: null,
      limit: 20,
    })
    // Full scope sees the 'secret'-scoped namespace AND entity.
    expect(full.some((t) => t.label === "/secret/ns")).toBe(true)
    expect(full.some((t) => t.label === "Secret Entity")).toBe(true)
    // A principal limited to 'public' sees NEITHER.
    const limited = await selectReflectionTargets(raw(), systemAdmin("rS", ["public"]), {
      since: null,
      limit: 20,
    })
    expect(limited.some((t) => t.label === "/secret/ns")).toBe(false)
    expect(limited.some((t) => t.label === "Secret Entity")).toBe(false)
  })

  test("pre-think dedup: a target whose insight already exists is skipped (no new insight)", async () => {
    const before = await count(
      "SELECT count(*) AS n FROM documents WHERE tenant_id='rD' AND origin='dream'",
      [],
    )
    const result = await runDreamReflection(reflectServices("rD", [{ id: "rD-c", score: 0.95 }]), {
      runId: "reflect-rD-1",
    })
    expect(result.stats.skipped).toBeGreaterThanOrEqual(1)
    expect(result.insightDocumentIds).toHaveLength(0)
    // No NEW insight doc was created (the pre-seeded one is untouched).
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='rD' AND origin='dream'",
        [],
      ),
    ).toBe(before)
  })

  test("a tiny neuron budget pauses (resumable); resume completes; same-day re-run no-ops", async () => {
    const stop = await runDreamReflection(reflectServices("rP", [{ id: "rP-c", score: 0.9 }]), {
      runId: "reflect-rP-1",
      maxNeurons: 0.001,
    })
    expect(stop.status).toBe("paused")
    expect(stop.targetsRemaining).toBeGreaterThan(0)

    const resume = await runDreamReflection(reflectServices("rP", [{ id: "rP-c", score: 0.9 }]), {
      runId: "reflect-rP-1",
    })
    expect(resume.resumed).toBe(true)
    expect(resume.status).toBe("success")
    expect(resume.targetsRemaining).toBe(0)

    const noop = await runDreamReflection(reflectServices("rP", [{ id: "rP-c", score: 0.9 }]), {
      runId: "reflect-rP-1",
    })
    expect(noop.noop).toBe(true)
  })

  test("a same-day re-run of a completed reflection is a no-op", async () => {
    const again = await runDreamReflection(reflectServices("rA", [{ id: "rA-c-a", score: 0.95 }]), {
      runId: "reflect-rA-1",
    })
    expect(again.noop).toBe(true)
    expect(again.insightDocumentIds).toHaveLength(0)
  })

  test("dispatchDreamRun(kind='all') inline runs both groups → both run rows, worst-of status", async () => {
    // Force the INLINE path (the test harness provides a DREAM workflow binding, which would
    // otherwise dispatch): rebuild the env without DREAM. Empty tenant → consolidation (0 clusters)
    // + reflection (0 targets) both succeed with no AI call.
    const inlineEnv = {
      DB: env_.DB,
      BODIES: env_.BODIES,
      CHUNK_INDEX: env_.CHUNK_INDEX,
      ENTITY_INDEX: env_.ENTITY_INDEX,
      AI: env_.AI,
      AI_GATEWAY_ID: env_.AI_GATEWAY_ID ?? "test",
    } as unknown as DreamDispatchEnv
    const result = await dispatchDreamRun(inlineEnv, systemAdmin("rDisp"), "all")
    expect(result.status).toBe("success") // worst-of([success, success])
    expect(
      await count(
        "SELECT count(*) AS n FROM dream_runs WHERE tenant_id='rDisp' AND kind='consolidation'",
        [],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM dream_runs WHERE tenant_id='rDisp' AND kind='reflection'",
        [],
      ),
    ).toBe(1)
    // The reflection row id is the consolidation run id + '-reflection' (shared plan derivation).
    expect(
      await count("SELECT count(*) AS n FROM dream_runs WHERE id=?", [
        `${result.runId}-reflection`,
      ]),
    ).toBe(1)
  })
})

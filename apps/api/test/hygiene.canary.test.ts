import { env } from "cloudflare:test"
import {
  type BrainBindings,
  DIGEST_SLUG,
  type DreamDigestServices,
  type DreamHygieneServices,
  DreamRunStore,
  MemoryStore,
  runDreamDigest,
  runDreamHygiene,
  ScopedDB,
  SessionStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"

/**
 * THE Dream memory-hygiene canary (v2 W1/D5) — runs `runDreamHygiene` against REAL local D1 in
 * workerd (LLM-free; no stubs needed beyond seeding). Proves:
 *   (a) a backdated, unrecalled, uncorroborated fact DECAYS (confidence ×0.9);
 *   (b) below the floor it SOFT-expires (`valid_until` set) and vanishes from recall (reversible);
 *   (c) a frequently-recalled fact's notability RISES (low→high at ≥5, low→medium at ≥2);
 *   (d) a recently-recalled fact is NOT decayed (the recall trace protects it);
 *   (e) a corroborated fact (a sibling with the same entity_slug+kind) is NOT decayed;
 *   (f) a fact newer than the unrecalled window is NOT decayed;
 *   (g) hygiene NEVER touches another tenant's facts;
 *   (h) the decayed counts + a world-only sample land in the digest (fed from the hygiene run stats).
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const OLD = "2020-01-01T00:00:00.000Z" // safely older than now − 30d

const admin = (tenantId: string): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const hygieneServices = (tenantId: string): DreamHygieneServices => {
  const p = admin(tenantId)
  const rawDb = raw()
  return { db: new ScopedDB(rawDb, p), runs: new DreamRunStore(rawDb, p), principal: p }
}

/** Digest bundle with a gen stub that DEGRADES (→ null) so the deterministic fallback body renders. */
const digestServices = (tenantId: string): DreamDigestServices => {
  const p = admin(tenantId)
  const rawDb = raw()
  return {
    db: new ScopedDB(rawDb, p),
    raw: rawDb,
    ai: { gen: async () => null },
    memory: new MemoryStore(rawDb, p),
    runs: new DreamRunStore(rawDb, p),
    principal: p,
  }
}

/** Insert a fact with full control over the hygiene-relevant columns; returns its id. */
const seedFact = async (opts: {
  tenantId: string
  fact: string
  kind?: string
  entitySlug?: string | null
  visibility?: string
  notability?: string
  confidence?: number
  createdAt?: string
  sourceSessionId?: string | null
  userId?: string | null
}): Promise<number> => {
  const res = await env_.DB.prepare(
    `INSERT INTO facts (tenant_id, user_id, entity_slug, fact, kind, visibility, notability, confidence,
                        valid_from, source, source_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mcp:extract_facts', ?, ?) RETURNING id`,
  )
    .bind(
      opts.tenantId,
      opts.userId ?? null,
      opts.entitySlug ?? null,
      opts.fact,
      opts.kind ?? "fact",
      opts.visibility ?? "world",
      opts.notability ?? "medium",
      opts.confidence ?? 1.0,
      opts.createdAt ?? OLD,
      opts.sourceSessionId ?? null,
      opts.createdAt ?? OLD,
    )
    .first<{ id: number }>()
  if (!res) throw new Error("seedFact: no id")
  return res.id
}

/** Insert `n` recall traces targeting a fact (target_id = String(factId)), stamped now. */
const seedTraces = async (tenantId: string, factId: number, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await env_.DB.prepare(
      `INSERT INTO memory_recall_traces (id, tenant_id, user_id, query, target_id, score, client_id, at)
       VALUES (?, ?, 'system', 'q', ?, 1.0, 'test', ?)`,
    )
      .bind(`tr-${tenantId}-${factId}-${i}`, tenantId, String(factId), Date.now())
      .run()
  }
}

const num = async (sql: string, binds: unknown[]): Promise<number | null> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ v: number }>()
  return res?.v ?? null
}
const str = async (sql: string, binds: unknown[]): Promise<string | null> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ v: string | null }>()
  return res?.v ?? null
}

const ids: Record<string, number> = {}

beforeAll(async () => {
  // (a) decay step-down
  ids.decay = await seedFact({
    tenantId: "hg1",
    fact: "hg1 lone stale fact",
    entitySlug: "hg1-e",
    confidence: 1.0,
  })
  // (b) soft-expire: 0.32 × 0.9 = 0.288 < 0.30 in ONE run
  ids.soft = await seedFact({
    tenantId: "hg2",
    fact: "hg2 barely-above-floor",
    entitySlug: "hg2-e",
    confidence: 0.32,
  })
  // (c) boost: low + ≥5 recalls → high; low + 2 recalls → medium
  ids.high = await seedFact({
    tenantId: "hg3",
    fact: "hg3 hot fact",
    entitySlug: "hg3-h",
    notability: "low",
    confidence: 1.0,
  })
  ids.med = await seedFact({
    tenantId: "hg3",
    fact: "hg3 warm fact",
    entitySlug: "hg3-m",
    notability: "low",
    confidence: 1.0,
  })
  await seedTraces("hg3", ids.high, 5)
  await seedTraces("hg3", ids.med, 2)
  // (d) recalled → protected from decay
  ids.recalled = await seedFact({
    tenantId: "hg4",
    fact: "hg4 recalled fact",
    entitySlug: "hg4-e",
    confidence: 1.0,
  })
  await seedTraces("hg4", ids.recalled, 1)
  // (e) corroborated pair → protected
  ids.corrA = await seedFact({
    tenantId: "hg5",
    fact: "hg5 A",
    entitySlug: "shared",
    kind: "fact",
    confidence: 1.0,
  })
  ids.corrB = await seedFact({
    tenantId: "hg5",
    fact: "hg5 B",
    entitySlug: "shared",
    kind: "fact",
    confidence: 1.0,
  })
  // (f) fresh fact (created now) → protected
  ids.fresh = await seedFact({
    tenantId: "hg6",
    fact: "hg6 fresh",
    entitySlug: "hg6-e",
    confidence: 1.0,
    createdAt: new Date().toISOString(),
  })
  // (e2) a sibling that is CONSOLIDATED must NOT count as a corroborator → the lone live fact decays.
  ids.uncorrX = await seedFact({
    tenantId: "hg7",
    fact: "hg7 X",
    entitySlug: "hg7-e",
    kind: "fact",
    confidence: 1.0,
  })
  ids.consY = await seedFact({
    tenantId: "hg7",
    fact: "hg7 Y (consolidated)",
    entitySlug: "hg7-e",
    kind: "fact",
    confidence: 1.0,
  })
  await env_.DB.prepare("UPDATE facts SET consolidated_into = ? WHERE id = ?")
    .bind(ids.uncorrX, ids.consY)
    .run()

  // (g) cross-tenant victim (would decay if the sweep leaked)
  ids.other = await seedFact({
    tenantId: "hgB",
    fact: "hgB stale",
    entitySlug: "hgB-e",
    confidence: 1.0,
  })
  // (h) digest section
  ids.dg = await seedFact({
    tenantId: "hgd",
    fact: "hgd decayed fact",
    entitySlug: "hgd-e",
    confidence: 0.32,
    visibility: "world",
  })
  // (i) session-scope reveal: a soft-expired fact still surfaces in a SESSION-scoped recall.
  ids.sess = await seedFact({
    tenantId: "hgS",
    fact: "hgS session fact",
    entitySlug: "hgS-e",
    confidence: 0.32,
    sourceSessionId: "sess-1",
  })
  // (j) failure-resume: a decayable fact + a prior 'failure' run row (nothing committed).
  ids.fail = await seedFact({
    tenantId: "hgF",
    fact: "hgF fact",
    entitySlug: "hgF-e",
    confidence: 1.0,
  })
  await env_.DB.prepare(
    `INSERT INTO dream_runs (id, tenant_id, kind, status, cursor, stats, attempts, created_at, updated_at)
     VALUES ('hyg-hgF', 'hgF', 'hygiene', 'failure', NULL, '{}', 1, ?, ?)`,
  )
    .bind(OLD, OLD)
    .run()
  // (k) revive round-trip (user_id matches the reviving principal — author path).
  ids.rev = await seedFact({
    tenantId: "hgR",
    fact: "hgR fact",
    entitySlug: "hgR-e",
    confidence: 0.32,
    userId: "system",
  })
  // (m) admin revives ANOTHER user's decayed fact (revive is broader than forget: restorative).
  ids.revOther = await seedFact({
    tenantId: "hgRA",
    fact: "hgRA other-user fact",
    entitySlug: "hgRA-e",
    confidence: 0.32,
    userId: "someoneElse",
  })
})

describe("dream hygiene canary (D5) — real local D1 in workerd", () => {
  test("(a) a backdated unrecalled uncorroborated fact decays ×0.9", async () => {
    const r = await runDreamHygiene(hygieneServices("hg1"), { runId: "hyg-hg1" })
    expect(r.status).toBe("success")
    expect(r.stats.factsDecayed).toBeGreaterThanOrEqual(1)
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.decay])).toBeCloseTo(
      0.9,
      5,
    )
  })

  test("(b) below the floor it soft-expires (valid_until set) and vanishes from recall", async () => {
    const r = await runDreamHygiene(hygieneServices("hg2"), { runId: "hyg-hg2" })
    expect(r.stats.factsSoftExpired).toBeGreaterThanOrEqual(1)
    expect(await str("SELECT valid_until AS v FROM facts WHERE id=?", [ids.soft])).not.toBeNull()
    // expired_at is NOT set — soft, reversible, distinct from hard-forget.
    expect(await str("SELECT expired_at AS v FROM facts WHERE id=?", [ids.soft])).toBeNull()
    // Recall no longer surfaces it (the wired notSoftExpired gate).
    const recalled = await new SessionStore(raw(), admin("hg2")).recall({
      entitySlug: "hg2-e",
      limit: 50,
    })
    expect(recalled.some((f) => f.id === ids.soft)).toBe(false)
  })

  test("(c) frequently-recalled facts get a notability boost (raise-only)", async () => {
    const r = await runDreamHygiene(hygieneServices("hg3"), { runId: "hyg-hg3" })
    expect(r.stats.factsBoosted).toBe(2)
    expect(await str("SELECT notability AS v FROM facts WHERE id=?", [ids.high])).toBe("high")
    expect(await str("SELECT notability AS v FROM facts WHERE id=?", [ids.med])).toBe("medium")
  })

  test("(d) a recently-recalled fact is NOT decayed", async () => {
    await runDreamHygiene(hygieneServices("hg4"), { runId: "hyg-hg4" })
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.recalled])).toBeCloseTo(
      1.0,
      5,
    )
  })

  test("(e) a corroborated fact (sibling same entity_slug+kind) is NOT decayed", async () => {
    await runDreamHygiene(hygieneServices("hg5"), { runId: "hyg-hg5" })
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.corrA])).toBeCloseTo(
      1.0,
      5,
    )
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.corrB])).toBeCloseTo(
      1.0,
      5,
    )
  })

  test("(e2) a CONSOLIDATED sibling does not corroborate → the lone live fact decays", async () => {
    const r = await runDreamHygiene(hygieneServices("hg7"), { runId: "hyg-hg7" })
    expect(r.stats.factsDecayed).toBeGreaterThanOrEqual(1)
    // X decays (its only same-slug+kind sibling Y is consolidated, so not a live corroborator).
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.uncorrX])).toBeCloseTo(
      0.9,
      5,
    )
  })

  test("(f) a fact newer than the unrecalled window is NOT decayed", async () => {
    await runDreamHygiene(hygieneServices("hg6"), { runId: "hyg-hg6" })
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.fresh])).toBeCloseTo(
      1.0,
      5,
    )
  })

  test("(g) hygiene never touches another tenant's facts", async () => {
    // A sweep for hg1 (has its own facts) must leave hgB's decayable fact untouched.
    await runDreamHygiene(hygieneServices("hg1"), { runId: "hyg-hg1-again" })
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.other])).toBeCloseTo(
      1.0,
      5,
    )
    expect(await str("SELECT valid_until AS v FROM facts WHERE id=?", [ids.other])).toBeNull()
  })

  test("(h) decayed counts + a world-only sample land in the digest", async () => {
    await runDreamHygiene(hygieneServices("hgd"), { runId: "hyg-hgd-base-hygiene" })
    // Digest reads the `<base>-hygiene` run stats; base = hyg-hgd-base.
    await runDreamDigest(digestServices("hgd"), { runId: "hyg-hgd-base" })
    const body = (await new MemoryStore(raw(), admin("hgd")).getMemory(DIGEST_SLUG))?.body ?? ""
    expect(body).toContain("decayed")
    expect(body).toContain("hgd decayed fact") // the world-only soft-expired sample
  })

  test("(i) a SESSION-scoped recall reveals a soft-expired fact (lineage, not loss)", async () => {
    await runDreamHygiene(hygieneServices("hgS"), { runId: "hyg-hgS" })
    const store = new SessionStore(raw(), admin("hgS"))
    // Default entity recall hides it…
    const hidden = await store.recall({ entitySlug: "hgS-e", limit: 50 })
    expect(hidden.some((f) => f.id === ids.sess)).toBe(false)
    // …but a session-scoped recall (get_session_context path) still surfaces it.
    const sessionScoped = await store.recall({ sessionId: "sess-1", limit: 50 })
    expect(sessionScoped.some((f) => f.id === ids.sess)).toBe(true)
  })

  test("(j) a failure-resume applies decay exactly ONCE", async () => {
    // A prior 'failure' run (claimable) with the fact still at 1.0 → the batch never committed.
    const r = await runDreamHygiene(hygieneServices("hgF"), { runId: "hyg-hgF" })
    expect(r.resumed).toBe(true)
    expect(r.status).toBe("success")
    // Applied once (0.9), not twice (0.81) — the id-first single batch + FSM success no-op.
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.fail])).toBeCloseTo(
      0.9,
      5,
    )
  })

  test("(k) revive_fact round-trip: decay → discover via includeSoftExpired → revive → recallable", async () => {
    await runDreamHygiene(hygieneServices("hgR"), { runId: "hyg-hgR" })
    const store = new SessionStore(raw(), admin("hgR"))
    // Hidden by default…
    expect(
      (await store.recall({ entitySlug: "hgR-e", limit: 50 })).some((f) => f.id === ids.rev),
    ).toBe(false)
    // …discoverable via includeSoftExpired (validUntil surfaced)…
    const discovered = await store.recall({
      entitySlug: "hgR-e",
      includeSoftExpired: true,
      limit: 50,
    })
    const found = discovered.find((f) => f.id === ids.rev)
    expect(found?.validUntil).not.toBeNull()
    // …revive restores it (confidence + clears valid_until) → recallable again.
    await store.reviveFact(ids.rev as number, 0.8)
    const revived = await store.recall({ entitySlug: "hgR-e", limit: 50 })
    expect(revived.some((f) => f.id === ids.rev)).toBe(true)
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.rev])).toBeCloseTo(0.8, 5)
    expect(await str("SELECT valid_until AS v FROM facts WHERE id=?", [ids.rev])).toBeNull()
  })

  test("(l) the hygiene audit diff carries ids + prior confidence", async () => {
    // hg1 decayed in (a); its audit row records the reversibility sample.
    const diffStr = await str(
      "SELECT diff AS v FROM memory_audit WHERE tenant_id='hg1' AND action='dream.hygiene' LIMIT 1",
      [],
    )
    expect(diffStr).not.toBeNull()
    const diff = JSON.parse(diffStr ?? "{}")
    expect(diff.decayed).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(diff.decaySample)).toBe(true)
    expect(diff.decaySample[0]).toHaveProperty("id")
    expect(diff.decaySample[0]).toHaveProperty("priorConfidence")
  })

  test("(m) an admin revives ANOTHER user's decayed fact (revive is broader than forget)", async () => {
    await runDreamHygiene(hygieneServices("hgRA"), { runId: "hyg-hgRA" })
    // The fact is authored by 'someoneElse'; the admin principal (userId 'system', role 'admin') revives it.
    expect(
      await str("SELECT valid_until AS v FROM facts WHERE id=?", [ids.revOther]),
    ).not.toBeNull()
    await new SessionStore(raw(), admin("hgRA")).reviveFact(ids.revOther as number, 0.7)
    expect(await str("SELECT valid_until AS v FROM facts WHERE id=?", [ids.revOther])).toBeNull()
    expect(await num("SELECT confidence AS v FROM facts WHERE id=?", [ids.revOther])).toBeCloseTo(
      0.7,
      5,
    )
  })
})

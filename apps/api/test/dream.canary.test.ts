import { env } from "cloudflare:test"
import {
  type BrainBindings,
  DreamRunStore,
  type DreamServices,
  runDreamConsolidation,
  ScopedDB,
  SessionStore,
  selectClusters,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { seedFact } from "./seed"

/**
 * THE Dream-engine canary (v2 W1/D1) — runs `runDreamConsolidation` against REAL local D1 inside
 * workerd, with a stubbed `genExtract` (canned verdicts) so it is offline-deterministic (same
 * pattern as graph.canary's KG stub). Proves the D-i1..D-i5 invariants + the review-round fixes:
 *   (a) consolidation NEVER crosses tenants; contradiction → memory_review 'unreviewed'/'dream';
 *   (b) a budget stop yields status 'paused' + resumable; a resume completes;
 *   (c) same-day re-run no-ops ONLY on 'success'; a lost claim (status 'running') no-ops;
 *   (d) a merged cluster of >90 facts applies fully (chunked link UPDATE);
 *   (e) is_dream_generated=1 facts are NEVER re-selected (anti-loop D-i2);
 *   (f) recall hides consolidated by default; includeSuperseded reveals; SESSION-scoped recall
 *       still returns a session's own facts even after consolidation (get_session_context invariant);
 *   (g) a low-confidence merge is downgraded to a human review;
 *   (h) residual (no-entity) clusters never mix kinds.
 *
 * NOTE: the run principal is a system admin with `userId:'system'` and no teams, so its visibility
 * gate collapses to WORLD facts only — Phase-1 consolidation operates on world facts (seeds are all
 * `world`). Team/private consolidation is out of scope.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)

const systemAdmin = (tenantId: string): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

/** Canned verdicts keyed off the entity name in the rendered judge prompt. */
const fakeGenExtract = async (prompt: string): Promise<string | null> => {
  if (prompt.includes("lowconf"))
    return JSON.stringify({
      action: "merge",
      mergedText: "low",
      confidence: 0.4,
      rationale: "unsure",
    })
  if (prompt.includes("bulk"))
    return JSON.stringify({
      action: "merge",
      mergedText: "bulk consolidated",
      confidence: 0.95,
      rationale: "dupes",
    })
  if (prompt.includes("pricing"))
    return JSON.stringify({
      action: "merge",
      mergedText: "Pricing is $99/mo (consolidated).",
      confidence: 0.95,
      rationale: "same decision",
    })
  if (prompt.includes("deadline"))
    return JSON.stringify({ action: "contradict", confidence: 0.9, rationale: "dates disagree" })
  return JSON.stringify({ action: "keep", confidence: 0.5, rationale: "distinct" })
}

/** Deterministic embed: identical text → identical unit vector; different text → orthogonal. */
const embedStub = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    let h = 0
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
    const v = new Array(1024).fill(0)
    v[h % 1024] = 1
    return v
  })

/** A DreamServices bundle over real local D1 + stubbed AI (no Vectorize/AI binding needed). */
const dreamServices = (tenantId: string): DreamServices => {
  const p = systemAdmin(tenantId)
  const rawDb = raw()
  return {
    db: new ScopedDB(rawDb, p),
    raw: rawDb,
    runs: new DreamRunStore(rawDb, p),
    ai: { embed: embedStub, genExtract: fakeGenExtract },
    principal: p,
  }
}

const count = async (sql: string, binds: unknown[]): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

/** Plant a duplicate cluster (3 facts) + a contradiction cluster (2 facts) for a tenant. */
const seedClusters = async (tenantId: string): Promise<void> => {
  await seedFact({ tenantId, entitySlug: "pricing", kind: "belief", fact: "We charge $99/mo." })
  await seedFact({
    tenantId,
    entitySlug: "pricing",
    kind: "belief",
    fact: "Our price is $99 monthly.",
  })
  await seedFact({ tenantId, entitySlug: "pricing", kind: "belief", fact: "Monthly price: $99." })
  await seedFact({
    tenantId,
    entitySlug: "deadline",
    kind: "fact",
    fact: "The deadline is Friday.",
  })
  await seedFact({
    tenantId,
    entitySlug: "deadline",
    kind: "fact",
    fact: "The deadline is Monday.",
  })
}

beforeAll(async () => {
  await seedClusters("dA")
  await seedClusters("dB")
  await seedClusters("dC") // budget / resume scenario
  await seedFact({ tenantId: "dD", entitySlug: "pricing", kind: "belief", fact: "One $99 fact." })
  await seedFact({
    tenantId: "dD",
    entitySlug: "pricing",
    kind: "belief",
    fact: "Another $99 fact.",
  })
  await seedFact({ tenantId: "dE", entitySlug: "lowconf", kind: "fact", fact: "maybe a" })
  await seedFact({ tenantId: "dE", entitySlug: "lowconf", kind: "fact", fact: "maybe b" })
  // dF: residual (no entity_slug) facts spanning two kinds, identical text (would co-cluster if kind
  // were not in the group key).
  await seedFact({ tenantId: "dF", entitySlug: null, kind: "fact", fact: "residual dup" })
  await seedFact({ tenantId: "dF", entitySlug: null, kind: "fact", fact: "residual dup" })
  await seedFact({ tenantId: "dF", entitySlug: null, kind: "belief", fact: "residual dup" })
  await seedFact({ tenantId: "dF", entitySlug: null, kind: "belief", fact: "residual dup" })
  // dG: a big single-entity cluster (>90) to exercise the chunked link UPDATE.
  for (let i = 0; i < 95; i++) {
    await seedFact({ tenantId: "dG", entitySlug: "bulk", kind: "fact", fact: `bulk dup ${i}` })
  }
  // dH: a cluster the claim-loser test leaves untouched.
  await seedFact({ tenantId: "dH", entitySlug: "pricing", kind: "belief", fact: "dH a" })
  await seedFact({ tenantId: "dH", entitySlug: "pricing", kind: "belief", fact: "dH b" })
  // dS: a session-scoped cluster (recall-invariant test).
  await seedFact({
    tenantId: "dS",
    entitySlug: "pricing",
    kind: "belief",
    fact: "sess a",
    sourceSessionId: "sess-1",
  })
  await seedFact({
    tenantId: "dS",
    entitySlug: "pricing",
    kind: "belief",
    fact: "sess b",
    sourceSessionId: "sess-1",
  })
})

describe("dream consolidation canary (D-i1..D-i5) — real local D1 in workerd", () => {
  test("(a) consolidates within a tenant, files the contradiction, NEVER crosses tenants", async () => {
    const result = await runDreamConsolidation(dreamServices("dA"), { runId: "dream-dA-1" })
    expect(result.status).toBe("success")
    expect(result.stats.merged).toBe(1)
    expect(result.stats.contradictions).toBe(1)

    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dA' AND is_dream_generated=1 AND source='dream:consolidation'",
        [],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dA' AND entity_slug='pricing' AND consolidated_into IS NOT NULL",
        [],
      ),
    ).toBe(3)
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_review WHERE tenant_id='dA' AND status='unreviewed' AND reviewer='dream'",
        [],
      ),
    ).toBe(1)

    // dB untouched.
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dB' AND is_dream_generated=1",
        [],
      ),
    ).toBe(0)
    expect(await count("SELECT count(*) AS n FROM memory_review WHERE tenant_id='dB'", [])).toBe(0)
  })

  test("(e) dream-generated + consolidated facts are never re-selected (anti-loop)", async () => {
    const clusters = await selectClusters(raw(), systemAdmin("dA"), { embed: embedStub })
    expect(clusters.some((c) => c.entitySlug === "pricing")).toBe(false)
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dA' AND is_dream_generated=1",
        [],
      ),
    ).toBe(1)
  })

  test("(f) recall hides consolidated by default; reveals with flag; SESSION recall keeps them", async () => {
    await runDreamConsolidation(dreamServices("dS"), { runId: "dream-dS-1" })
    const store = new SessionStore(raw(), systemAdmin("dS"))

    // Default entity recall hides the 2 consolidated inputs (only the dream fact remains).
    const hidden = await store.recall({ entitySlug: "pricing", limit: 50 })
    expect(hidden.every((f) => f.consolidatedInto === null)).toBe(true)
    expect(hidden.some((f) => f.fact === "Pricing is $99/mo (consolidated).")).toBe(true)

    // includeSuperseded reveals the consolidated originals.
    const revealed = await store.recall({
      entitySlug: "pricing",
      includeSuperseded: true,
      limit: 50,
    })
    expect(revealed.filter((f) => f.consolidatedInto !== null).length).toBe(2)

    // SESSION-scoped recall (get_session_context path) still returns the session's own 2 facts,
    // even though they are now consolidated — lineage, not loss.
    const sessionFacts = await store.recall({ sessionId: "sess-1", limit: 50 })
    expect(sessionFacts.length).toBe(2)
    expect(sessionFacts.every((f) => f.consolidatedInto !== null)).toBe(true)
  })

  test("(b) a budget stop yields status 'paused' + resumable; a resume completes", async () => {
    const stop = await runDreamConsolidation(dreamServices("dC"), {
      runId: "dream-dC-resume",
      maxNeurons: 0.001, // trips after the first cluster
    })
    expect(stop.status).toBe("paused")
    expect(stop.clustersRemaining).toBeGreaterThan(0)
    const store = new DreamRunStore(raw(), systemAdmin("dC"))
    expect((await store.get("dream-dC-resume"))?.status).toBe("paused")

    const resume = await runDreamConsolidation(dreamServices("dC"), { runId: "dream-dC-resume" })
    expect(resume.resumed).toBe(true)
    expect(resume.status).toBe("success")
    expect(resume.clustersRemaining).toBe(0)
    expect((await store.get("dream-dC-resume"))?.cursor).toBeNull()
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dC' AND is_dream_generated=1",
        [],
      ),
    ).toBe(1)
    expect(await count("SELECT count(*) AS n FROM memory_review WHERE tenant_id='dC'", [])).toBe(1)
  })

  test("(c) same-day re-run no-ops only on success; a lost claim (running) no-ops", async () => {
    // same-day success no-op:
    const first = await runDreamConsolidation(dreamServices("dD"))
    expect(first.noop).toBe(false)
    const afterFirst = await count(
      "SELECT count(*) AS n FROM facts WHERE tenant_id='dD' AND is_dream_generated=1",
      [],
    )
    const second = await runDreamConsolidation(dreamServices("dD"))
    expect(second.noop).toBe(true)
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dD' AND is_dream_generated=1",
        [],
      ),
    ).toBe(afterFirst)

    // lost claim: a run row already 'running' is not claimable → no-op, no work done.
    const store = new DreamRunStore(raw(), systemAdmin("dH"))
    await store.createRun({ id: "dream-dH-1", kind: "consolidation" })
    expect(await store.claim("dream-dH-1", "queued")).toBe(true) // now 'running'
    const contended = await runDreamConsolidation(dreamServices("dH"), { runId: "dream-dH-1" })
    expect(contended.noop).toBe(true)
    expect(contended.status).toBe("running")
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dH' AND is_dream_generated=1",
        [],
      ),
    ).toBe(0)
  })

  test("(d) a merged cluster of >90 facts applies fully (chunked link UPDATE)", async () => {
    const result = await runDreamConsolidation(dreamServices("dG"), { runId: "dream-dG-1" })
    expect(result.stats.merged).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dG' AND is_dream_generated=1",
        [],
      ),
    ).toBe(1)
    // all 95 inputs got their consolidated_into pointer (the ≤90-id chunking applied every row).
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dG' AND entity_slug='bulk' AND consolidated_into IS NOT NULL",
        [],
      ),
    ).toBe(95)
  })

  test("(g) a low-confidence merge is downgraded to a human review, not applied", async () => {
    const result = await runDreamConsolidation(dreamServices("dE"), { runId: "dream-dE-1" })
    expect(result.stats.merged).toBe(0)
    expect(result.stats.contradictions).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM facts WHERE tenant_id='dE' AND is_dream_generated=1",
        [],
      ),
    ).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_review WHERE tenant_id='dE' AND reviewer='dream'",
        [],
      ),
    ).toBe(1)
  })

  test("(h) residual (no-entity) clusters never mix kinds", async () => {
    const clusters = await selectClusters(raw(), systemAdmin("dF"), { embed: embedStub })
    const residual = clusters.filter((c) => c.entitySlug === null)
    expect(residual.length).toBe(2) // one per kind, not one mixed cluster of 4
    for (const cluster of residual) {
      const kinds = new Set(cluster.facts.map((f) => f.kind))
      expect(kinds.size).toBe(1)
    }
  })
})

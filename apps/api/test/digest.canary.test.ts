import { env } from "cloudflare:test"
import {
  type BrainBindings,
  createDreamDigestServices,
  DIGEST_SLUG,
  type DreamDigestServices,
  DreamRunStore,
  GovernanceStore,
  MemoryStore,
  runDreamDigest,
  ScopedDB,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { seedFact } from "./seed"

/**
 * THE Phase-3 digest + contradiction-resolution canary (v2 W1/D3), hardened per the security
 * review. Real local D1 in workerd. Proves: digest write→memory_get (tenant-isolated), version
 * growth on changed data, gen-degrade fallback, nothing-happened no-op (no gen spend / no version),
 * stable system ownership across cron→user runs, world-only fact visibility (no private text), and
 * the resolveContradiction guards (bad review, non-dream row, bad keepFactId, read-only), keep
 * (expire ALL losers) + dismiss semantics, and redaction in list_pending_reviews.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)

const admin = (tenantId: string, overrides: Partial<Principal> = {}): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
  ...overrides,
})

const digestServices = (
  tenantId: string,
  gen: (p: string, s?: string) => Promise<string | null> = async () => "LLM digest summary.",
): DreamDigestServices => {
  const p = admin(tenantId)
  const rawDb = raw()
  return {
    db: new ScopedDB(rawDb, p),
    raw: rawDb,
    ai: { gen },
    memory: new MemoryStore(rawDb, p),
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

const digestBody = async (tenantId: string): Promise<string> =>
  (await new MemoryStore(raw(), admin(tenantId)).getMemory(DIGEST_SLUG))?.body ?? ""

/** Seed a memory_review row with a shared-contract contradiction note. */
const seedReview = async (opts: {
  id: string
  tenantId: string
  factIds: number[]
  reviewer?: string
  status?: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO memory_review (id, tenant_id, target_id, status, reviewer, reviewed_at, note)
     VALUES (?, ?, ?, ?, ?, '2026-06-25T00:00:00.000Z', ?)`,
  )
    .bind(
      opts.id,
      opts.tenantId,
      String(opts.factIds[0]),
      opts.status ?? "unreviewed",
      opts.reviewer ?? "dream",
      JSON.stringify({ kind: "contradiction", factIds: opts.factIds, rationale: "dates disagree" }),
    )
    .run()
}

beforeAll(async () => {
  await seedFact({ tenantId: "dgA", fact: "digest fact one" })
  await seedFact({ tenantId: "dgA", fact: "digest fact two" })
})

describe("dream digest + resolve canary (D3) — real local D1 in workerd", () => {
  test("writes agent/digest/daily, readable, tenant-isolated", async () => {
    const result = await runDreamDigest(digestServices("dgA"), { runId: "dg-a-1" })
    expect(result.status).toBe("success")
    expect((await digestBody("dgA")).length).toBeGreaterThan(0)
    expect(await new MemoryStore(raw(), admin("dgB")).getMemory(DIGEST_SLUG)).toBeNull()
  })

  test("a second run over CHANGED data appends a new version", async () => {
    const store = new MemoryStore(raw(), admin("dgV"))
    await seedFact({ tenantId: "dgV", fact: "v1 fact" })
    const svc = digestServices("dgV", async () => null) // fallback → body is a pure fn of data+date
    await runDreamDigest(svc, { runId: "dg-v-1", now: "2026-07-01T00:00:00.000Z" })
    const v1 = (await store.getMemory(DIGEST_SLUG))?.version ?? 0
    await runDreamDigest(svc, { runId: "dg-v-1", now: "2026-07-02T00:00:00.000Z" })
    const v2 = (await store.getMemory(DIGEST_SLUG))?.version ?? 0
    expect(v2).toBeGreaterThan(v1)
  })

  test("gen-degrade still writes the deterministic fallback digest", async () => {
    await seedFact({ tenantId: "dgD", fact: "degrade fact" })
    const result = await runDreamDigest(
      digestServices("dgD", async () => null),
      { runId: "dg-d-1" },
    )
    expect(result.degraded).toBe(true)
    expect(await digestBody("dgD")).toContain("# Daily digest")
  })

  test("nothing-happened run: no gen spend, static body, no version growth", async () => {
    // dgN has no facts/docs. gen would MUTATE the body, so a spy proves it is never called.
    let genCalls = 0
    const svc = digestServices("dgN", async () => {
      genCalls++
      return "should not be called"
    })
    await runDreamDigest(svc, { runId: "dg-n-1", now: "2026-07-01T00:00:00.000Z" })
    await runDreamDigest(svc, { runId: "dg-n-1", now: "2026-07-05T00:00:00.000Z" }) // different date
    expect(genCalls).toBe(0)
    // Static body is date-independent → the second run is a no-op → version stays 1.
    expect((await new MemoryStore(raw(), admin("dgN")).getMemory(DIGEST_SLUG))?.version).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM token_spend WHERE tenant_id='dgN' AND surface='dream'",
        [],
      ),
    ).toBe(0)
  })

  test("cron→user runs are ownership-stable (system principal both times)", async () => {
    await seedFact({ tenantId: "dgO", fact: "ownership fact" })
    // Different dispatchers (a system-ish admin, then a restricted member) → digest forces 'system'.
    await runDreamDigest(createDreamDigestServices(env_, admin("dgO")), { runId: "dg-o-1" })
    await expect(
      runDreamDigest(
        createDreamDigestServices(
          env_,
          admin("dgO", { userId: "userB", role: "member", allowedScopes: ["x"] }),
        ),
        { runId: "dg-o-1" },
      ),
    ).resolves.toMatchObject({ status: "success" })
  })

  test("digest never contains a private fact's text (world-only, even under a user principal)", async () => {
    await seedFact({ tenantId: "dgP", fact: "public pricing info", visibility: "world" })
    await seedFact({
      tenantId: "dgP",
      fact: "SECRETXYZ salary",
      visibility: "private",
      userId: "someoneElse",
    })
    // A user principal dispatched it, but the digest runs as system (world-only).
    await runDreamDigest(
      createDreamDigestServices(env_, admin("dgP", { userId: "u", role: "member" })),
      {
        runId: "dg-p-1",
      },
    )
    const body = await digestBody("dgP")
    expect(body).toContain("public pricing info")
    expect(body).not.toContain("SECRETXYZ")
  })

  test("resolveContradiction: 'keep' expires ALL losers; guards reject bad input", async () => {
    const f1 = await seedFact({ tenantId: "dgR", fact: "deadline Friday" })
    const f2 = await seedFact({ tenantId: "dgR", fact: "deadline Monday" })
    const f3 = await seedFact({ tenantId: "dgR", fact: "deadline Tuesday" })
    await seedReview({ id: "rev-dgR", tenantId: "dgR", factIds: [f1, f2, f3] })
    const gov = new GovernanceStore(raw(), admin("dgR"))

    // Guards (teaching errors).
    await expect(gov.resolveContradiction("nope", { action: "dismiss" })).rejects.toThrow()
    await expect(
      gov.resolveContradiction("rev-dgR", { action: "keep", keepFactId: 999999 }),
    ).rejects.toThrow() // keepFactId not in the contradiction
    const readOnly = new GovernanceStore(raw(), admin("dgR", { readOnly: true }))
    await expect(
      readOnly.resolveContradiction("rev-dgR", { action: "keep", keepFactId: f1 }),
    ).rejects.toThrow()

    expect((await gov.listPendingDreamReviews()).length).toBe(1) // still pending after the failures

    // Keep f1 → f2 AND f3 expired, f1 active, review resolved, audited.
    await gov.resolveContradiction("rev-dgR", { action: "keep", keepFactId: f1 })
    expect(
      await count("SELECT count(*) AS n FROM facts WHERE id IN (?,?) AND expired_at IS NOT NULL", [
        f2,
        f3,
      ]),
    ).toBe(2)
    expect(
      await count("SELECT count(*) AS n FROM facts WHERE id=? AND expired_at IS NULL", [f1]),
    ).toBe(1)
    expect((await gov.listPendingDreamReviews()).length).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_audit WHERE tenant_id='dgR' AND action='dream.contradiction.resolve'",
        [],
      ),
    ).toBe(1)
  })

  test("'dismiss' leaves all facts active; a human-promotion row is untouchable", async () => {
    const f1 = await seedFact({ tenantId: "dgH", fact: "h one" })
    const f2 = await seedFact({ tenantId: "dgH", fact: "h two" })
    await seedReview({ id: "rev-dgH", tenantId: "dgH", factIds: [f1, f2] })
    // A HUMAN review row (reviewer != 'dream') must be rejected by the op.
    await seedReview({ id: "rev-human", tenantId: "dgH", factIds: [f1], reviewer: "alice" })
    const gov = new GovernanceStore(raw(), admin("dgH"))

    await gov.resolveContradiction("rev-dgH", { action: "dismiss" })
    expect(
      await count("SELECT count(*) AS n FROM facts WHERE id IN (?,?) AND expired_at IS NULL", [
        f1,
        f2,
      ]),
    ).toBe(2)
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_review WHERE id='rev-dgH' AND status='rejected'",
        [],
      ),
    ).toBe(1)

    await expect(gov.resolveContradiction("rev-human", { action: "dismiss" })).rejects.toThrow()
    expect(
      await count(
        "SELECT count(*) AS n FROM memory_review WHERE id='rev-human' AND status='unreviewed'",
        [],
      ),
    ).toBe(1)
  })

  test("list_pending_reviews redacts facts the caller cannot see", async () => {
    const pub = await seedFact({ tenantId: "dgE", fact: "team-visible fact", visibility: "world" })
    const priv = await seedFact({
      tenantId: "dgE",
      fact: "PRIVATEXYZ",
      visibility: "private",
      userId: "ownerX",
    })
    await seedReview({ id: "rev-dgE", tenantId: "dgE", factIds: [pub, priv] })
    // A member who is NOT ownerX: sees only the world fact, the private one is redacted.
    const gov = new GovernanceStore(raw(), admin("dgE", { userId: "viewer", role: "member" }))
    const reviews = await gov.listPendingDreamReviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.facts.map((f) => f.id)).toEqual([pub])
    expect(reviews[0]?.redactedCount).toBe(1)
    expect(JSON.stringify(reviews[0])).not.toContain("PRIVATEXYZ")
  })
})

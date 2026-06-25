import { env } from "cloudflare:test"
import {
  type BrainBindings,
  findIdleSessions,
  GovernanceStore,
  idleCutoff,
  ScopedDB,
  type SessionServices,
  SessionStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { handleRecall } from "../src/sessions"
import { seedFact, seedMembership, seedOrg } from "./seed"

/**
 * THE Phase-5 session + hot-memory isolation canary (converts the Phase-1 `[P5]` recall-trace
 * `test.todo`). Runs against REAL local D1 inside workerd — the same harness as the Phase-1
 * isolation suite. Every canary is NON-VACUOUS: both tenants are seeded with COLLIDING content,
 * the leak path is shown to surface the would-be-foreign row for the OWNING principal first, then
 * proven absent for the foreign one. Drop-don't-error throughout (no existence leak, no throw).
 *
 * Proves for the session/hot-memory surfaces what the Phase-1 suite proved for chunks:
 *   - cross-tenant recall isolation (tenant B never recalls tenant A's promoted facts);
 *   - intra-tenant visibility (user B never recalls user A's `private` promoted fact);
 *   - session-turn isolation (a colliding `source_session_id` across tenants never crosses);
 *   - recall-trace isolation + the OFF-read-path `waitUntil` dispatch (the [P5] todo).
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "sA",
  userId: "uA",
  teamIds: [],
  role: "member",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
  ...overrides,
})

beforeAll(async () => {
  await seedOrg("sA", "sA")
  await seedMembership({ tenantId: "sA", userId: "uA", role: "member" })
  await seedMembership({ tenantId: "sA", userId: "uOther", role: "member" })
  await seedOrg("sB", "sB")
  await seedMembership({ tenantId: "sB", userId: "uB", role: "member" })
})

describe("session/hot-memory isolation canary (real local D1 in workerd)", () => {
  test("cross-tenant recall: tenant B never recalls tenant A's promoted facts (colliding content)", async () => {
    const storeA = new SessionStore(raw(), principal({ tenantId: "sA", userId: "uA" }))
    const storeB = new SessionStore(raw(), principal({ tenantId: "sB", userId: "uB" }))
    // COLLIDING content across tenants — the whole point of the non-vacuous canary.
    await storeA.replacePromotedFacts("promo-A", [
      { fact: "colliding needle fact", kind: "fact", visibility: "world" },
    ])
    await storeB.replacePromotedFacts("promo-B", [
      { fact: "colliding needle fact", kind: "fact", visibility: "world" },
    ])

    // Non-vacuous: each tenant DOES recall its OWN colliding fact...
    const aOwn = await storeA.recall({ sessionId: "promo-A" })
    const bOwn = await storeB.recall({ sessionId: "promo-B" })
    expect(aOwn.map((f) => f.fact)).toEqual(["colliding needle fact"])
    expect(bOwn.map((f) => f.fact)).toEqual(["colliding needle fact"])

    // ...but neither recalls the OTHER tenant's session facts (tenant_id gate).
    expect(await storeA.recall({ sessionId: "promo-B" })).toHaveLength(0)
    expect(await storeB.recall({ sessionId: "promo-A" })).toHaveLength(0)
  })

  test("intra-tenant visibility: user B never recalls user A's PRIVATE promoted fact", async () => {
    const storeA = new SessionStore(raw(), principal({ tenantId: "sA", userId: "uA" }))
    await storeA.replacePromotedFacts("promo-priv", [
      { fact: "uA private promoted secret", kind: "belief", visibility: "private" },
    ])
    // The AUTHOR recalls it (non-vacuous)...
    const authorView = await storeA.recall({ sessionId: "promo-priv" })
    expect(authorView.map((f) => f.fact)).toEqual(["uA private promoted secret"])
    // ...a different user in the SAME tenant does not (visibility predicate, drop-don't-error).
    const otherUser = new SessionStore(raw(), principal({ tenantId: "sA", userId: "uOther" }))
    expect(await otherUser.recall({ sessionId: "promo-priv" })).toHaveLength(0)
  })

  test("session-turn isolation: a colliding source_session_id across tenants never crosses", async () => {
    const storeA = new SessionStore(raw(), principal({ tenantId: "sA", userId: "uA" }))
    const storeB = new SessionStore(raw(), principal({ tenantId: "sB", userId: "uB" }))
    // SAME client + source_session_id in BOTH tenants (the unique index is per-tenant).
    const a = await storeA.captureTurn({
      sessionId: "dup-sid",
      role: "user",
      content: "A turn",
      client: "claude-code",
    })
    const b = await storeB.captureTurn({
      sessionId: "dup-sid",
      role: "user",
      content: "B turn",
      client: "claude-code",
    })
    expect(a.brainSessionId).not.toBe(b.brainSessionId)

    // Tenant B can read its own session, never tenant A's.
    expect(await storeB.getSession(a.brainSessionId)).toBeNull()
    const bTurns = await storeB.recentTurns(b.brainSessionId)
    expect(bTurns.map((t) => t.content)).toEqual(["B turn"]) // never "A turn"

    // INTRA-tenant: a different user in tenant A cannot read A's session turns either (invariant 8).
    const otherInA = new SessionStore(raw(), principal({ tenantId: "sA", userId: "uOther" }))
    expect(await otherInA.getSession(a.brainSessionId)).toBeNull()
    expect(await otherInA.recentTurns(a.brainSessionId)).toHaveLength(0)
  })

  test("recall-trace isolation + OFF-read-path dispatch ([P5]): traces are tenant-scoped, written via waitUntil", async () => {
    // Seed a recallable WORLD fact in each tenant (colliding content again).
    await seedFact({ tenantId: "sA", userId: "uA", visibility: "world", fact: "trace needle" })
    await seedFact({ tenantId: "sB", userId: "uB", visibility: "world", fact: "trace needle" })

    const servicesA = {
      db: new ScopedDB(raw(), principal({ tenantId: "sA", userId: "uA" })),
      sessions: new SessionStore(raw(), principal({ tenantId: "sA", userId: "uA" })),
    } as unknown as SessionServices

    // The handler dispatches the durable trace write OFF the read path via waitUntil.
    const dispatched: Promise<unknown>[] = []
    const out = await handleRecall(
      servicesA,
      { grep: "trace needle" },
      (p) => dispatched.push(p),
      "claude-code",
    )
    expect(out.facts.length).toBeGreaterThan(0) // non-vacuous: tenant A recalled its own fact
    expect(dispatched).toHaveLength(1) // the trace append was dispatched, NOT inline-awaited
    await Promise.all(dispatched) // settle the off-path write

    // The trace landed under tenant A only; tenant B has none.
    const aTraces = await env_.DB.prepare(
      "SELECT count(*) AS n FROM memory_recall_traces WHERE tenant_id = 'sA' AND query = 'trace needle'",
    ).first<{ n: number }>()
    const bTraces = await env_.DB.prepare(
      "SELECT count(*) AS n FROM memory_recall_traces WHERE tenant_id = 'sB'",
    ).first<{ n: number }>()
    expect(aTraces?.n).toBeGreaterThan(0)
    expect(bTraces?.n).toBe(0)
  })

  test("idle-promotion sweep keys on last_activity_at (NOT ended_at) — invariant 21", async () => {
    // A STALE open session whose Stop-hook never fired (ended_at NULL) + a FRESH open one.
    const stale = idleCutoff(60) // 60 minutes ago, well past the 30-min threshold
    const fresh = new Date().toISOString()
    await env_.DB.prepare(
      `INSERT INTO sessions (id, tenant_id, user_id, client, status, started_at, last_activity_at, ended_at)
       VALUES ('idle-stale','sA','uA','claude-code','open',?,?,NULL)`,
    )
      .bind(stale, stale)
      .run()
    await env_.DB.prepare(
      `INSERT INTO sessions (id, tenant_id, user_id, client, status, started_at, last_activity_at, ended_at)
       VALUES ('idle-fresh','sA','uA','claude-code','open',?,?,NULL)`,
    )
      .bind(fresh, fresh)
      .run()

    const idle = await findIdleSessions(env_, 30, 100)
    const ids = idle.map((s) => s.id)
    // The stale session (idle past the threshold, ended_at NULL) IS swept; the fresh one is not.
    expect(ids).toContain("idle-stale")
    expect(ids).not.toContain("idle-fresh")
  })

  test("break-glass over facts fails closed for a non-admin, even against private content", async () => {
    await seedFact({ tenantId: "sA", userId: "uA", visibility: "private", fact: "bg secret" })
    const member = new GovernanceStore(
      raw(),
      principal({ tenantId: "sA", userId: "uOther", role: "member" }),
      async () => undefined,
    )
    // A non-admin is rejected before any private row is read (fail-closed).
    await expect(member.breakGlassFacts([1], "snoop")).rejects.toThrow(/owner or admin/)
  })
})

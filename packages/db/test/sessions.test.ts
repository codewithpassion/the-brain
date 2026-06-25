import { describe, expect, test } from "bun:test"
import { SessionStore } from "../src/sessions/store"
import { insertFact, makeDb, principal, withBatch } from "./helpers"

/**
 * Sessions + hot-memory writeback/recall (PRD §8). Against a REAL bun:sqlite DB; `withBatch`
 * maps `commitBatch` to a synchronous all-or-nothing transaction (same semantics as D1 `db.batch`).
 *
 * Proves the load-bearing invariants:
 *   - 21: `capture_turn` REFRESHES `last_activity_at` (the idle-sweep key) on every turn.
 *   - 21: re-finalize is a CLEAN REPLACE — the prior promoted set is soft-expired (lineage kept),
 *     never appended/duplicated.
 *   -  9: agent writeback CANNOT produce `instruction` (no arg exists; no use_policy row → the
 *     `trust_grade` default is `evidence`).
 *   -  8: recall ANDs the shared `visibilityPredicate` — user B never recalls user A's `private` fact.
 */

const rowCount = (sqlite: ReturnType<typeof makeDb>["sqlite"], sql: string): number =>
  (sqlite.query(sql).get() as { n: number }).n

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("captureTurn (invariant 21) — refreshes last_activity_at, the idle-sweep key", () => {
  test("a second capture bumps turn_count AND advances last_activity_at", async () => {
    const { sqlite, db } = makeDb()
    const store = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))

    const first = await store.captureTurn({
      sessionId: "cc-1",
      role: "user",
      content: "hello",
      client: "claude-code",
    })
    const la1 = (
      sqlite
        .query("SELECT last_activity_at AS la FROM sessions WHERE id = ?")
        .get(first.brainSessionId) as {
        la: string
      }
    ).la

    await sleep(8)
    const second = await store.captureTurn({
      sessionId: "cc-1",
      role: "assistant",
      content: "hi there",
      client: "claude-code",
    })
    // Same brain session (idempotent upsert by source_session_id), next ordinal.
    expect(second.brainSessionId).toBe(first.brainSessionId)
    expect(second.idx).toBe(1)

    const row = sqlite
      .query("SELECT turn_count AS tc, last_activity_at AS la, status FROM sessions WHERE id = ?")
      .get(first.brainSessionId) as { tc: number; la: string; status: string }
    expect(row.tc).toBe(2)
    expect(row.status).toBe("open") // never closed by a capture
    expect(row.la > la1).toBe(true) // refreshed — NOT left at creation time
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM session_turns")).toBe(2)
  })

  test("a turn longer than TURN_INLINE_MAX is offloaded (content NULL, r2_offset set)", async () => {
    const { sqlite, db } = makeDb()
    const store = new SessionStore(withBatch(db), principal({ tenantId: "t1" }))
    const big = "x".repeat(3000)
    const res = await store.captureTurn({
      sessionId: "cc-big",
      role: "user",
      content: big,
      client: "claude-code",
    })
    expect(res.offloaded).toBe(true)
    const turn = sqlite
      .query("SELECT content, r2_offset AS off FROM session_turns LIMIT 1")
      .get() as { content: string | null; off: string | null }
    expect(turn.content).toBeNull()
    expect(turn.off).toContain("#turn-0")
  })
})

describe("replacePromotedFacts (invariant 21) — clean replace, not append", () => {
  test("re-finalize soft-expires the prior promoted set and inserts the fresh one", async () => {
    const { sqlite, db } = makeDb()
    const store = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))

    await store.replacePromotedFacts("sess-1", [
      { fact: "A likes tea", kind: "preference" },
      { fact: "B shipped v1", kind: "event" },
    ])
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM facts WHERE source_session_id = 'sess-1' AND expired_at IS NULL",
      ),
    ).toBe(2)

    // Re-promote an edited transcript: a DIFFERENT set for the SAME session.
    await store.replacePromotedFacts("sess-1", [{ fact: "A now likes coffee", kind: "preference" }])

    // The prior 2 are soft-expired (lineage preserved, not hard-deleted); 1 fresh active fact.
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM facts WHERE source_session_id = 'sess-1' AND expired_at IS NULL",
      ),
    ).toBe(1)
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM facts WHERE source_session_id = 'sess-1' AND expired_at IS NOT NULL",
      ),
    ).toBe(2)
    // Total rows = 3 (no duplicate append of the unchanged-key fact).
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM facts WHERE source_session_id = 'sess-1'"),
    ).toBe(3)
  })

  test("in-batch dedupe collapses duplicate (entity,kind,fact) — handled by the caller's dedupeFacts", async () => {
    // The store inserts what it is given; promote.ts dedupes. Here we prove the store does NOT
    // double-write when handed a clean set, and stamps source:'session:promote'.
    const { sqlite, db } = makeDb()
    const store = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))
    const ids = await store.replacePromotedFacts("sess-2", [{ fact: "only one", kind: "fact" }])
    expect(ids).toHaveLength(1)
    const row = sqlite.query("SELECT source, user_id FROM facts WHERE id = ?").get(ids[0] ?? 0) as {
      source: string
      user_id: string
    }
    expect(row.source).toBe("session:promote")
    expect(row.user_id).toBe("userA") // authorship forced from the Principal
  })
})

describe("invariant 9 — agent writeback can NOT produce instruction", () => {
  test("promote writes NO instruction use_policy row; provenance is agent_inferred", async () => {
    const { sqlite, db } = makeDb()
    const store = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))
    const ids = await store.replacePromotedFacts("sess-3", [
      { fact: "agent inferred this", kind: "belief" },
    ])

    // No instruction-grade sidecar exists for a promoted fact (default trust is evidence).
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM memory_use_policy WHERE trust_grade = 'instruction'",
      ),
    ).toBe(0)
    // Provenance records the agent_inferred origin + the session lineage.
    const prov = sqlite
      .query("SELECT origin, session_id AS sid FROM memory_provenance WHERE target_id = ?")
      .get(String(ids[0])) as { origin: string; sid: string }
    expect(prov.origin).toBe("agent_inferred")
    expect(prov.sid).toBe("sess-3")
  })
})

describe("intra-tenant authorship gate (invariant 8) — sessions/turns/forget are author-scoped", () => {
  test("a non-author in the SAME tenant cannot read another user's session or turns", async () => {
    const { db } = makeDb()
    const storeA = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))
    const created = await storeA.captureTurn({
      sessionId: "owned-by-A",
      role: "user",
      content: "A private turn",
      client: "claude-code",
    })
    // The author reads it (non-vacuous)...
    expect(await storeA.getSession(created.brainSessionId)).not.toBeNull()
    expect(await storeA.recentTurns(created.brainSessionId)).toHaveLength(1)
    // ...a different user in the SAME tenant gets nothing (drop-don't-error).
    const storeB = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userB" }))
    expect(await storeB.getSession(created.brainSessionId)).toBeNull()
    expect(await storeB.recentTurns(created.brainSessionId)).toHaveLength(0)
  })

  test("a teammate CAN read a team session; a non-teammate cannot", async () => {
    const { db } = makeDb()
    const author = new SessionStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "userA", teamIds: ["team1"] }),
    )
    const created = await author.captureTurn({
      sessionId: "team-sess",
      role: "user",
      content: "team turn",
      client: "claude-code",
      teamId: "team1",
    })
    const teammate = new SessionStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "userC", teamIds: ["team1"] }),
    )
    const outsider = new SessionStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "userD", teamIds: ["team2"] }),
    )
    expect(await teammate.getSession(created.brainSessionId)).not.toBeNull()
    expect(await outsider.getSession(created.brainSessionId)).toBeNull()
  })

  test("forgetFact is a no-op for a non-author's fact (the gate matches nothing)", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      userId: "userA",
      visibility: "private",
      fact: "A owns this",
    })
    const storeB = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userB" }))
    await storeB.forgetFact(factId)
    // The fact is UNTOUCHED — B is not the author (no throw, just no match).
    const row = sqlite.query("SELECT expired_at FROM facts WHERE id = ?").get(factId) as {
      expired_at: string | null
    }
    expect(row.expired_at).toBeNull()
    // The author CAN forget it.
    const storeA = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))
    await storeA.forgetFact(factId)
    const after = sqlite.query("SELECT expired_at FROM facts WHERE id = ?").get(factId) as {
      expired_at: string | null
    }
    expect(after.expired_at).not.toBeNull()
  })
})

describe("recall (invariant 8) — visibility predicate drops other users' private facts", () => {
  test("user B never recalls user A's private fact; world + own private are returned", async () => {
    const { sqlite, db } = makeDb()
    // A's PRIVATE fact, a WORLD fact, and B's PRIVATE fact — all same tenant.
    insertFact(sqlite, { tenantId: "t1", userId: "userA", visibility: "private", fact: "A secret" })
    insertFact(sqlite, {
      tenantId: "t1",
      userId: "userA",
      visibility: "world",
      fact: "shared world fact",
    })
    insertFact(sqlite, { tenantId: "t1", userId: "userB", visibility: "private", fact: "B secret" })

    const storeB = new SessionStore(withBatch(db), principal({ tenantId: "t1", userId: "userB" }))
    const recalled = await storeB.recall({ limit: 50 })
    const texts = recalled.map((f) => f.fact).sort()
    // B sees the world fact + B's own private; NEVER A's private.
    expect(texts).toEqual(["B secret", "shared world fact"])
  })
})

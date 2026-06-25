import { describe, expect, test } from "bun:test"
import { GovernanceStore } from "../src/governance/store"
import type { BreakGlassEvent } from "../src/scoped/db"
import { insertFact, makeDb, principal, withBatch } from "./helpers"

/**
 * Governance (PRD §7.5/§7.6). Against a REAL bun:sqlite DB with the D1-shaped `withBatch` shim.
 *
 * Proves:
 *   -  9 / LOCKED authority: `memoryReview` is the ONLY path to `instruction`; a `member` may
 *      promote WITHIN its own `allowedScopes`, owner/admin anywhere, readonly never, and a
 *      restricted member cannot promote a tenant-global (null-scope) or out-of-grant fact.
 *   -  8 / break-glass: fact break-glass fails CLOSED for non-admins AND when no audit sink is
 *      configured; an admin read with a sink returns other users' private facts AND fires the audit.
 */

const rowCount = (sqlite: ReturnType<typeof makeDb>["sqlite"], sql: string): number =>
  (sqlite.query(sql).get() as { n: number }).n

describe("memoryReview (invariant 9 + LOCKED authority) — the ONLY path to instruction", () => {
  test("owner promotes a tenant-global fact → instruction use_policy row + review + audit", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      scope: null,
      visibility: "world",
      fact: "global truth",
    })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "ownerA", role: "owner" }),
    )

    await gov.memoryReview(factId, { status: "confirmed" })

    const policy = sqlite
      .query("SELECT trust_grade AS tg FROM memory_use_policy WHERE target_id = ?")
      .get(String(factId)) as { tg: string }
    expect(policy.tg).toBe("instruction")
    expect(
      rowCount(
        sqlite,
        `SELECT count(*) AS n FROM memory_review WHERE target_id = '${factId}' AND status = 'confirmed'`,
      ),
    ).toBe(1)
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_audit WHERE action = 'usePolicy.promote'"),
    ).toBe(1)
  })

  test("member promotes a fact WITHIN its allowedScopes → succeeds", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      scope: "clientA",
      visibility: "team",
      fact: "in scope",
    })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "memA", role: "member", allowedScopes: ["clientA"] }),
    )
    await gov.memoryReview(factId, { status: "confirmed" })
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM memory_use_policy WHERE trust_grade = 'instruction'",
      ),
    ).toBe(1)
  })

  test("member promoting an OUT-OF-GRANT scope is rejected; nothing is written", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      scope: "clientB",
      visibility: "team",
      fact: "other client",
    })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "memA", role: "member", allowedScopes: ["clientA"] }),
    )
    await expect(gov.memoryReview(factId, { status: "confirmed" })).rejects.toThrow(/allowedScopes/)
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM memory_use_policy")).toBe(0)
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM memory_review")).toBe(0)
  })

  test("restricted member promoting a tenant-global (null-scope) fact is rejected", async () => {
    const { db, sqlite } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      scope: null,
      visibility: "world",
      fact: "global",
    })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "memA", role: "member", allowedScopes: ["clientA"] }),
    )
    await expect(gov.memoryReview(factId, { status: "confirmed" })).rejects.toThrow(/tenant-global/)
  })

  test("readonly principal can NOT promote", async () => {
    const { db, sqlite } = makeDb()
    const factId = insertFact(sqlite, { tenantId: "t1", scope: null, fact: "x" })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", role: "readonly", readOnly: true }),
    )
    await expect(gov.memoryReview(factId, { status: "confirmed" })).rejects.toThrow(/read-only/)
  })

  test("a REJECTED review records the review WITHOUT promoting", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      scope: null,
      visibility: "world",
      fact: "maybe",
    })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "ownerA", role: "owner" }),
    )
    await gov.memoryReview(factId, { status: "rejected" })
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM memory_use_policy")).toBe(0)
    expect(
      rowCount(sqlite, `SELECT count(*) AS n FROM memory_review WHERE status = 'rejected'`),
    ).toBe(1)
  })
})

describe("break-glass facts (invariant 8) — fails closed, audited", () => {
  test("a non-admin (member) is rejected and reads NO private content", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      userId: "userA",
      visibility: "private",
      fact: "A secret",
    })
    const audited: BreakGlassEvent[] = []
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "memB", role: "member" }),
      async (e) => {
        audited.push(e)
      },
    )
    await expect(gov.breakGlassFacts([factId], "investigate")).rejects.toThrow(/owner or admin/)
    expect(audited).toHaveLength(0) // fails closed BEFORE any read or audit
  })

  test("an admin WITHOUT an audit sink fails closed (no unaudited break-glass)", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      userId: "userA",
      visibility: "private",
      fact: "A secret",
    })
    const gov = new GovernanceStore(withBatch(db), principal({ tenantId: "t1", role: "admin" }))
    await expect(gov.breakGlassFacts([factId], "investigate")).rejects.toThrow(/no audit sink/)
  })

  test("an admin WITH a sink reads another user's private fact AND fires the audit", async () => {
    const { sqlite, db } = makeDb()
    const factId = insertFact(sqlite, {
      tenantId: "t1",
      userId: "userA",
      visibility: "private",
      fact: "A secret",
    })
    const audited: BreakGlassEvent[] = []
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", userId: "adminX", role: "admin" }),
      async (e) => {
        audited.push(e)
      },
    )
    const rows = await gov.breakGlassFacts([factId], "compliance review")
    // The private fact IS returned (visibility arm dropped)...
    expect(rows.map((r) => r.fact)).toEqual(["A secret"])
    // ...and the read was audited (the sink fired exactly once, BEFORE the read).
    expect(audited).toHaveLength(1)
    expect(audited[0]?.actorUserId).toBe("adminX")
    expect(audited[0]?.targetIds).toEqual([String(factId)])
  })

  test("break-glass NEVER bypasses tenant_id — another tenant's private fact is not returned", async () => {
    const { sqlite, db } = makeDb()
    const mine = insertFact(sqlite, {
      tenantId: "t1",
      userId: "userA",
      visibility: "private",
      fact: "t1 secret",
    })
    const theirs = insertFact(sqlite, {
      tenantId: "t2",
      userId: "userA",
      visibility: "private",
      fact: "t2 secret",
    })
    const gov = new GovernanceStore(
      withBatch(db),
      principal({ tenantId: "t1", role: "admin" }),
      async () => undefined,
    )
    const rows = await gov.breakGlassFacts([mine, theirs], "x")
    expect(rows.map((r) => r.fact)).toEqual(["t1 secret"]) // t2's row never crosses the boundary
  })
})

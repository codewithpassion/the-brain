import { describe, expect, test } from "bun:test"
import { ScopedDB } from "../src/scoped/db"
import { insertChunk, insertDoc, insertFact, makeDb, principal } from "./helpers"

/**
 * The security core (invariants 1, 3, 4, 8): the D1 re-check must SILENTLY DROP every id
 * that is cross-tenant / out-of-scope / out-of-visibility / soft-deleted — no throw, no
 * existence leak. Each chunk has a matching `documents` row so the inner JOIN never drops
 * an id for the wrong reason; the only thing that removes an id is a real predicate.
 */
describe("ScopedDB re-check drops (invariant 3)", () => {
  test("a mixed id batch returns ONLY the valid id, silently, without throwing", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertDoc(sqlite, { id: "d2", tenantId: "t2", slug: "doc-2" })

    insertChunk(sqlite, {
      id: "c-valid",
      tenantId: "t1",
      documentId: "d1",
      scope: "clientA",
      visibility: "world",
    })
    insertChunk(sqlite, {
      id: "c-cross",
      tenantId: "t2", // cross-tenant
      documentId: "d2",
      scope: "clientA",
      visibility: "world",
    })
    insertChunk(sqlite, {
      id: "c-vis",
      tenantId: "t1",
      documentId: "d1",
      scope: "clientA",
      visibility: "private", // authored by someone else
      userId: "userB",
    })
    insertChunk(sqlite, {
      id: "c-del",
      tenantId: "t1",
      documentId: "d1",
      scope: "clientA",
      visibility: "world",
      deletedAt: "2026-06-25T00:00:00.000Z", // soft-deleted
    })
    insertChunk(sqlite, {
      id: "c-scope",
      tenantId: "t1",
      documentId: "d1",
      scope: "clientB", // out of grant
      visibility: "world",
    })

    const sdb = new ScopedDB(db, principal({ allowedScopes: ["clientA"], userId: "userA" }))
    const ids = ["c-valid", "c-cross", "c-vis", "c-del", "c-scope"]

    const rows = await sdb.getChunksByIds(ids)
    expect(rows.map((r) => r.id)).toEqual(["c-valid"])
    // drop-don't-error: the cross-tenant / hidden ids are simply absent, never thrown.
    expect(rows).toHaveLength(1)
    // trust_grade defaults to 'evidence' via the LEFT-JOIN (invariant 6).
    expect(rows[0]?.trustGrade).toBe("evidence")
  })

  test("hydrateChunks keys surviving rows by id (and drops the rest)", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertChunk(sqlite, { id: "ok", tenantId: "t1", documentId: "d1", visibility: "world" })

    const sdb = new ScopedDB(db, principal())
    const map = await sdb.hydrateChunks(["ok", "ghost"])
    expect(map.has("ok")).toBe(true)
    expect(map.has("ghost")).toBe(false)
  })
})

describe("visibilityPredicate (invariant 8)", () => {
  test("private→author only, team→members only, world→all in tenant", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertChunk(sqlite, { id: "world", tenantId: "t1", documentId: "d1", visibility: "world" })
    insertChunk(sqlite, {
      id: "priv-A",
      tenantId: "t1",
      documentId: "d1",
      visibility: "private",
      userId: "userA",
    })
    insertChunk(sqlite, {
      id: "priv-B",
      tenantId: "t1",
      documentId: "d1",
      visibility: "private",
      userId: "userB",
    })
    insertChunk(sqlite, {
      id: "team-X",
      tenantId: "t1",
      documentId: "d1",
      visibility: "team",
      teamId: "teamX",
    })
    insertChunk(sqlite, {
      id: "team-Y",
      tenantId: "t1",
      documentId: "d1",
      visibility: "team",
      teamId: "teamY",
    })

    const all = ["world", "priv-A", "priv-B", "team-X", "team-Y"]
    const userA = new ScopedDB(db, principal({ userId: "userA", teamIds: ["teamX"] }))
    const seen = (await userA.getChunksByIds(all)).map((r) => r.id).sort()
    expect(seen).toEqual(["priv-A", "team-X", "world"])
  })

  test("a user with no teams sees no team rows", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertChunk(sqlite, {
      id: "team-X",
      tenantId: "t1",
      documentId: "d1",
      visibility: "team",
      teamId: "teamX",
    })
    const sdb = new ScopedDB(db, principal({ userId: "userA", teamIds: [] }))
    expect(await sdb.getChunksByIds(["team-X"])).toHaveLength(0)
  })
})

describe("scopePredicate (invariant 5)", () => {
  test("a restricted grant excludes out-of-scope rows; '*' sees all tenant scopes", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertChunk(sqlite, { id: "a", tenantId: "t1", documentId: "d1", scope: "clientA" })
    insertChunk(sqlite, { id: "b", tenantId: "t1", documentId: "d1", scope: "clientB" })
    insertChunk(sqlite, { id: "n", tenantId: "t1", documentId: "d1", scope: null })

    const restricted = new ScopedDB(db, principal({ allowedScopes: ["clientA"] }))
    expect((await restricted.getChunksByIds(["a", "b", "n"])).map((r) => r.id)).toEqual(["a"])

    const wildcard = new ScopedDB(db, principal({ allowedScopes: "*" }))
    expect((await wildcard.getChunksByIds(["a", "b", "n"])).map((r) => r.id).sort()).toEqual([
      "a",
      "b",
      "n",
    ])
  })
})

describe("FTS arm JOIN-back (invariant 4)", () => {
  test("MATCH is tenant-scoped on the base table — no cross-tenant leak", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertDoc(sqlite, { id: "d2", tenantId: "t2", slug: "doc-2" })
    // Same colliding MATCH term across two tenants.
    insertChunk(sqlite, {
      id: "t1-hit",
      tenantId: "t1",
      documentId: "d1",
      content: "shared needle term",
    })
    insertChunk(sqlite, {
      id: "t2-hit",
      tenantId: "t2",
      documentId: "d2",
      content: "shared needle term",
    })

    const sdb = new ScopedDB(db, principal({ tenantId: "t1" }))
    const ids = await sdb.ftsChunkIds("needle", 10)
    expect(ids).toEqual(["t1-hit"])

    // And the hydrate re-check of a cross-tenant id from a hostile arm still drops it.
    expect(await sdb.getChunksByIds(["t2-hit"])).toHaveLength(0)
  })

  test("soft-deleted rows never surface from the FTS arm", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertChunk(sqlite, {
      id: "gone",
      tenantId: "t1",
      documentId: "d1",
      content: "shared needle term",
      deletedAt: "2026-06-25T00:00:00.000Z",
    })
    const sdb = new ScopedDB(db, principal({ tenantId: "t1" }))
    expect(await sdb.ftsChunkIds("needle", 10)).toEqual([])
  })
})

describe("FTS arm JOIN-back by id, not rowid (invariants 4, 8)", () => {
  test("facts MATCH re-checks tenant + visibility on the base table (joined by id)", async () => {
    const { sqlite, db } = makeDb()
    const fWorld = insertFact(sqlite, {
      tenantId: "t1",
      visibility: "world",
      fact: "shared needle fact",
    })
    insertFact(sqlite, { tenantId: "t2", visibility: "world", fact: "shared needle fact" }) // cross-tenant
    insertFact(sqlite, {
      tenantId: "t1",
      visibility: "private",
      userId: "userB", // someone else's private fact
      fact: "shared needle fact",
    })
    insertFact(sqlite, {
      tenantId: "t1",
      visibility: "world",
      fact: "shared needle fact",
      expiredAt: "2026-06-25T00:00:00.000Z", // superseded/expired
    })

    const sdb = new ScopedDB(db, principal({ tenantId: "t1", userId: "userA", teamIds: [] }))
    const ids = await sdb.ftsFactIds("needle", 10)
    expect(ids).toEqual([fWorld])
  })

  test("a team fact is visible only to members of that team", async () => {
    const { sqlite, db } = makeDb()
    const fTeamX = insertFact(sqlite, {
      tenantId: "t1",
      visibility: "team",
      teamId: "teamX",
      fact: "team needle fact",
    })
    insertFact(sqlite, {
      tenantId: "t1",
      visibility: "team",
      teamId: "teamY",
      fact: "team needle fact",
    })

    const member = new ScopedDB(db, principal({ tenantId: "t1", teamIds: ["teamX"] }))
    expect(await member.ftsFactIds("needle", 10)).toEqual([fTeamX])

    const outsider = new ScopedDB(db, principal({ tenantId: "t1", teamIds: [] }))
    expect(await outsider.ftsFactIds("needle", 10)).toEqual([])
  })
})

describe("breakGlass (invariant 8)", () => {
  test("non-admin is denied (fail-closed); missing audit sink is denied", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertChunk(sqlite, {
      id: "priv-B",
      tenantId: "t1",
      documentId: "d1",
      visibility: "private",
      userId: "userB",
    })

    const member = new ScopedDB(db, principal({ role: "member" }), async () => {})
    await expect(member.breakGlass(["priv-B"], "investigation")).rejects.toThrow()

    const adminNoSink = new ScopedDB(db, principal({ role: "admin" }))
    await expect(adminNoSink.breakGlass(["priv-B"], "investigation")).rejects.toThrow()
  })

  test("admin with a sink reads across visibility, is audited, never crosses tenant", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertDoc(sqlite, { id: "d2", tenantId: "t2", slug: "doc-2" })
    insertChunk(sqlite, {
      id: "priv-B",
      tenantId: "t1",
      documentId: "d1",
      visibility: "private",
      userId: "userB",
    })
    insertChunk(sqlite, {
      id: "cross",
      tenantId: "t2",
      documentId: "d2",
      visibility: "world",
    })

    const events: string[] = []
    const admin = new ScopedDB(db, principal({ role: "admin", userId: "userA" }), async (e) => {
      events.push(e.reason)
    })
    const rows = await admin.breakGlass(["priv-B", "cross"], "incident-42")
    // sees the private row it normally couldn't, but the cross-tenant id is still dropped.
    expect(rows.map((r) => r.id)).toEqual(["priv-B"])
    expect(events).toEqual(["incident-42"])
  })
})

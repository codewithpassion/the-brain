import { describe, expect, test } from "bun:test"
import { exportOkfBundle, importOkfBundle, parseDocument } from "../src/memory/okf"
import { setMemory } from "../src/memory/ops"
import { MemoryStore } from "../src/memory/store"
import { makeDb, principal, withBatch } from "./helpers"

/**
 * OKF-compatible agent memory on the pages layer (docs/okf-memory-plan.md). Exercises the
 * MemoryStore chokepoint against a REAL bun:sqlite DB (every migration applied), proving:
 * versioning + forward-only rollback, the load-by-path model, OKF round-trip, and the
 * tenant/scope/visibility isolation + in-batch audit discipline.
 */

type PrincipalOpts = Parameters<typeof principal>[0]

/** A fresh DB + a MemoryStore for `opts`. Returns the raw `sqlite` for row-count assertions. */
const build = (opts: PrincipalOpts = {}) => {
  const { sqlite, db } = makeDb()
  return { sqlite, db, store: new MemoryStore(withBatch(db), principal(opts)) }
}

/** A second MemoryStore over the SAME underlying connection (for cross-principal isolation). */
const storeOver = (db: ReturnType<typeof makeDb>["db"], opts: PrincipalOpts) =>
  new MemoryStore(withBatch(db), principal(opts))

const fm = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "note",
  ...extra,
})

const rowCount = (sqlite: ReturnType<typeof makeDb>["sqlite"], sql: string): number =>
  (sqlite.query(sql).get() as { n: number }).n

describe("memory_set — create, update, versioning", () => {
  test("create then get returns the body + parsed frontmatter at version 1", async () => {
    const { store } = build()
    const res = await store.upsertMemory({
      slug: "agent/planner/prefs",
      frontmatter: fm({ title: "Prefs", tags: ["a"] }),
      body: "be concise",
    })
    expect(res).toMatchObject({ slug: "agent/planner/prefs", version: 1, changed: true })

    const got = await store.getMemory("agent/planner/prefs")
    expect(got?.body).toBe("be concise")
    expect(got?.version).toBe(1)
    expect(got?.type).toBe("note")
    expect(got?.title).toBe("Prefs")
    expect(got?.frontmatter.tags).toEqual(["a"])
  })

  test("type is required and must be non-empty (OKF)", async () => {
    const { store } = build()
    expect(
      store.upsertMemory({ slug: "x", frontmatter: { title: "no type" }, body: "b" }),
    ).rejects.toThrow(/type is required/)
  })

  test("update appends a revision; an unchanged write is a no-op", async () => {
    const { store } = build()
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v1" })
    const v2 = await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v2" })
    expect(v2).toMatchObject({ version: 2, changed: true })
    expect((await store.getMemory("s"))?.body).toBe("v2")

    const noop = await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v2" })
    expect(noop).toMatchObject({ version: 2, changed: false })

    const history = await store.getMemoryHistory("s")
    expect(history.map((r) => r.version)).toEqual([2, 1]) // newest-first; the no-op wrote nothing
  })

  test("the real op path is a no-op for identical content despite a fresh timestamp", async () => {
    // setMemory injects a fresh OKF `timestamp` every call; skip-unchanged must still fire.
    const { store } = build()
    const req = { slug: "s", type: "note", body: "same", title: "T" }
    await setMemory(store, req, "2026-01-01T00:00:00.000Z")
    const second = await setMemory(store, req, "2026-06-28T00:00:00.000Z")
    expect(second.changed).toBe(false)
    expect((await store.getMemoryHistory("s")).length).toBe(1) // no no-op revision
  })
})

describe("memory load-by-path model", () => {
  test("list returns direct children by default, the whole subtree with prefix", async () => {
    const { store } = build()
    await store.upsertMemory({ slug: "agent/a", frontmatter: fm(), body: "1" })
    await store.upsertMemory({ slug: "agent/b", frontmatter: fm(), body: "2" })
    await store.upsertMemory({ slug: "agent/deep/c", frontmatter: fm(), body: "3" })
    await store.upsertMemory({ slug: "other/x", frontmatter: fm(), body: "4" })

    const direct = await store.listMemory({ path: "agent" })
    expect(direct.map((m) => m.slug)).toEqual(["agent/a", "agent/b"]) // NOT agent/deep/c

    const subtree = await store.listMemory({ path: "agent", prefix: true })
    expect(subtree.map((m) => m.slug)).toEqual(["agent/a", "agent/b", "agent/deep/c"])

    expect((await store.listMemory({})).length).toBe(4)
  })
})

describe("memory_rollback — forward-only", () => {
  test("rollback to v1 restores its content as a NEW version; history is retained", async () => {
    const { store } = build()
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v1" })
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v2" })
    const v1 = (await store.getMemoryHistory("s")).find((r) => r.version === 1)
    if (v1 === undefined) throw new Error("v1 missing")

    const rolled = await store.revertMemory("s", v1.revisionId)
    expect(rolled).toMatchObject({ version: 3, revertedFrom: 1 })

    expect((await store.getMemory("s"))?.body).toBe("v1") // live content == v1
    const after = await store.getMemoryHistory("s")
    expect(after.map((r) => r.version)).toEqual([3, 2, 1])
    expect(after[0]?.reason).toBe("revert:1")
  })

  test("rollback to a foreign revision id is rejected", async () => {
    const { store } = build()
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v1" })
    expect(store.revertMemory("s", 99999)).rejects.toThrow(/revision .* not found/)
  })
})

describe("memory_forget — soft-delete, resurrect, history retained", () => {
  test("forget hides the item but keeps history; re-set resurrects it", async () => {
    const { store } = build()
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v1" })
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v2" })

    expect(await store.forgetMemory("s")).toMatchObject({ forgotten: true })
    expect(await store.getMemory("s")).toBeNull()
    expect((await store.getMemoryHistory("s")).length).toBe(2) // history retained

    // Re-set the same slug — must resurrect (not collide on the unique-slug index).
    const res = await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v3" })
    expect(res).toMatchObject({ version: 3, changed: true })
    expect((await store.getMemory("s"))?.body).toBe("v3")
  })
})

describe("tags + links reconcile from the concept", () => {
  test("frontmatter.tags land in tags; in-body links resolve to doc_links", async () => {
    const { sqlite, store } = build()
    await store.upsertMemory({ slug: "target", frontmatter: fm(), body: "I am the target" })
    await store.upsertMemory({
      slug: "source",
      frontmatter: fm({ tags: ["x", "y", "x"] }),
      body: "see [[target]] and [doc](/missing.md)",
    })

    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM tags WHERE page_id=(SELECT id FROM pages WHERE slug='source')",
      ),
    ).toBe(2) // de-duped x,y
    // only the existing 'target' resolves; 'missing' is silently skipped
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM doc_links WHERE link_source='okf'")).toBe(1)
  })
})

describe("isolation + audit (invariants 1, 8, 10)", () => {
  test("a memory item is invisible across tenants", async () => {
    const { db } = build({ tenantId: "t1", userId: "u1" })
    const t1 = storeOver(db, { tenantId: "t1", userId: "u1" })
    await t1.upsertMemory({ slug: "s", frontmatter: fm(), body: "secret" })

    const t2 = storeOver(db, { tenantId: "t2", userId: "u2" })
    expect(await t2.getMemory("s")).toBeNull()
    expect(await t2.getMemoryHistory("s")).toEqual([])
    expect(await t2.forgetMemory("s")).toMatchObject({ forgotten: false })
  })

  test("a private item is invisible to another user in the same tenant", async () => {
    const { db } = build()
    const author = storeOver(db, { tenantId: "t1", userId: "u1" })
    await author.upsertMemory({ slug: "s", frontmatter: fm(), body: "mine", visibility: "private" })
    const other = storeOver(db, { tenantId: "t1", userId: "u2" })
    expect(await other.getMemory("s")).toBeNull()
  })

  test("scope outside the grant is rejected on write", async () => {
    const { store } = build({ tenantId: "t1", userId: "u1", allowedScopes: ["alpha"] })
    expect(
      store.upsertMemory({ slug: "s", frontmatter: fm(), body: "b", scope: "beta" }),
    ).rejects.toThrow(/not in this principal's allowedScopes/)
  })

  test("every mutation writes a memory_audit row", async () => {
    const { sqlite, store } = build()
    await store.upsertMemory({ slug: "s", frontmatter: fm(), body: "v1" })
    const h = await store.getMemoryHistory("s")
    await store.revertMemory("s", h[0]?.revisionId ?? 0)
    await store.forgetMemory("s")
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM memory_audit WHERE action='page.set'")).toBe(
      1,
    )
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_audit WHERE action='page.revert'"),
    ).toBe(1)
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_audit WHERE action='page.forget'"),
    ).toBe(1)
  })
})

describe("OKF round-trip", () => {
  test("export a subtree then import into a clean tenant yields identical concepts", async () => {
    const author = build({ tenantId: "t1", userId: "u1" }).store
    await author.upsertMemory({
      slug: "kb/orders",
      frontmatter: fm({ title: "Orders", tags: ["sales"], custom_key: "kept" }),
      body: "One row per order.\n\nSee [[kb/customers]].",
    })
    await author.upsertMemory({
      slug: "kb/customers",
      frontmatter: fm({ title: "Customers" }),
      body: "One row per customer.",
    })

    const bundle = await exportOkfBundle(author, { path: "kb", prefix: true })
    expect(bundle.okfVersion).toBe("0.1")
    expect(bundle.count).toBe(2)
    const names = bundle.files.map((f) => f.path)
    expect(names).toContain("index.md")
    expect(names).toContain("log.md")
    expect(names).toContain("kb/orders.md")
    const index = bundle.files.find((f) => f.path === "index.md")
    expect(parseDocument(index?.content ?? "").frontmatter.okf_version).toBe("0.1")

    // Import into a fresh tenant.
    const importer = build({ tenantId: "t2", userId: "u2" }).store
    const result = await importOkfBundle(importer, bundle.files)
    expect(result.imported).toBe(2)
    expect(result.skipped).toContain("index.md")
    expect(result.skipped).toContain("log.md")

    const orders = await importer.getMemory("kb/orders")
    expect(orders?.title).toBe("Orders")
    expect(orders?.body).toBe("One row per order.\n\nSee [[kb/customers]].")
    expect(orders?.frontmatter.custom_key).toBe("kept") // unknown key preserved (OKF rule)
  })
})

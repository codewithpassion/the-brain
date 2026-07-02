import type { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { DOC_GRAPH } from "@brain/shared"
import type { drizzle } from "drizzle-orm/bun-sqlite"
import { addTagOp } from "../src/graph/ops"
import { ScopedGraph } from "../src/graph/scoped-graph"
import { makeDb, principal, withBatch } from "./helpers"

/**
 * W4.4 — the mutating doc-graph curation surface (`add_link` / `add_tag` / `add_timeline_entry`).
 * Proves each write resolves its target through the SAME visibility gate as the reads, is
 * idempotent, writes an in-batch `memory_audit` row, rejects a read-only principal, and cannot
 * reach another tenant's page.
 */

const STAMP = "2026-06-25T00:00:00.000Z"

const insertPage = (
  sqlite: Database,
  row: { id: string; tenantId: string; slug: string; visibility?: string },
): void => {
  sqlite.run(
    `INSERT INTO pages
       (id, tenant_id, slug, type, title, visibility, compiled_truth, frontmatter, created_at, updated_at)
     VALUES (?, ?, ?, 'note', ?, ?, '', '{}', ?, ?)`,
    [row.id, row.tenantId, row.slug, row.id, row.visibility ?? "world", STAMP, STAMP],
  )
}

const auditActions = (sqlite: Database): string[] =>
  (sqlite.query(`SELECT action FROM memory_audit`).all() as { action: string }[]).map(
    (r) => r.action,
  )

describe("ScopedGraph doc-graph writes (W4.4)", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>
  const p = principal({ tenantId: "t1", userId: "userA" })

  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = withBatch(made.db)
    insertPage(sqlite, { id: "pg-a", tenantId: "t1", slug: "page-a" })
    insertPage(sqlite, { id: "pg-b", tenantId: "t1", slug: "page-b" })
  })

  test("add_link resolves both endpoints by slug and shows in get_links, audited", async () => {
    const graph = new ScopedGraph(db, p)
    const out = await graph.addLink({
      from: "page-a",
      to: "page-b",
      linkType: "relates",
      context: "x",
    })
    expect(out).toMatchObject({ fromId: "pg-a", toId: "pg-b", linkType: "relates" })

    const links = await graph.getLinks("pg-a")
    expect(links.map((l) => l.toId)).toContain("pg-b")
    expect(auditActions(sqlite)).toContain("graph.link.add")
  })

  test("add_tag attaches a tag (idempotent) and shows in get_tags, audited", async () => {
    const graph = new ScopedGraph(db, p)
    await graph.addTag({ target: "page-a", tag: "important" })
    await graph.addTag({ target: "page-a", tag: "important" }) // idempotent — no duplicate row
    const tags = await graph.getTags("pg-a")
    expect(tags).toEqual(["important"])
    expect(auditActions(sqlite)).toContain("graph.tag.add")
  })

  test("add_timeline_entry appends a dated entry (idempotent) and shows in get_timeline", async () => {
    const graph = new ScopedGraph(db, p)
    await graph.addTimelineEntry({ target: "page-a", date: "2026-01-01", summary: "launched" })
    await graph.addTimelineEntry({ target: "page-a", date: "2026-01-01", summary: "launched" })
    const entries = await graph.getTimeline("pg-a")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ date: "2026-01-01", summary: "launched" })
    expect(auditActions(sqlite)).toContain("graph.timeline.add")
  })

  test("a non-existent / invisible target throws (drop-don't-write)", async () => {
    const graph = new ScopedGraph(db, p)
    await expect(graph.addTag({ target: "no-such-page", tag: "x" })).rejects.toThrow(/not found/)
  })

  test("a read-only principal is rejected before any write (batchWithAudit backstop)", async () => {
    const ro = new ScopedGraph(db, principal({ tenantId: "t1", readOnly: true }))
    await expect(ro.addTag({ target: "page-a", tag: "x" })).rejects.toThrow(/read-only/)
    expect(auditActions(sqlite)).not.toContain("graph.tag.add")
  })

  test("cannot tag another tenant's page (resolveNodeId is tenant-scoped)", async () => {
    insertPage(sqlite, { id: "pg-x", tenantId: "t2", slug: "other-tenant-page" })
    const graph = new ScopedGraph(db, p) // tenant t1
    await expect(graph.addTag({ target: "other-tenant-page", tag: "x" })).rejects.toThrow(
      /not found/,
    )
    // and the t2 page has no tag written
    const t2tags = sqlite.query(`SELECT tag FROM tags WHERE tenant_id = 't2'`).all()
    expect(t2tags).toHaveLength(0)
  })

  test("bound op handler routes through ScopedGraph (add_tag op is write, resolves by slug)", async () => {
    const graph = new ScopedGraph(db, p)
    const out = await addTagOp.handler(
      { deps: { graph, entityVectors: null as never, ai: null as never }, principal: p },
      { target: "page-a", tag: "viahandler" },
    )
    expect(out).toEqual({ pageId: "pg-a", tag: "viahandler" })
    expect(addTagOp.def.capability).toBe("write")
    expect(addTagOp.def.readOnly).toBe(false)
    // sanity: the resolved node really was gated as DOC_GRAPH (slug lookup succeeded)
    expect(await graph.resolveNodeId(DOC_GRAPH, "page-a")).toBe("pg-a")
  })

  test("add_timeline_entry is idempotent: a second identical add returns the SAME id (W4.5 fix)", async () => {
    const graph = new ScopedGraph(db, p)
    const first = await graph.addTimelineEntry({
      target: "page-a",
      date: "2026-02-02",
      summary: "ship",
    })
    const second = await graph.addTimelineEntry({
      target: "page-a",
      date: "2026-02-02",
      summary: "ship",
    })
    expect(second.id).toBe(first.id) // never a fresh minted-but-unwritten id
    expect(await graph.getTimeline("pg-a")).toHaveLength(1) // still one row
  })

  test("add_link on the idempotent conflict path returns the PERSISTED context (W4.5 fix)", async () => {
    const graph = new ScopedGraph(db, p)
    const first = await graph.addLink({
      from: "page-a",
      to: "page-b",
      linkType: "rel",
      context: "original",
    })
    expect(first.context).toBe("original")
    // a second add with a DIFFERENT context is a no-op on the dedup key → returns the STORED context
    const second = await graph.addLink({
      from: "page-a",
      to: "page-b",
      linkType: "rel",
      context: "changed",
    })
    expect(second.context).toBe("original") // honest: stored value wins, input didn't overwrite
    expect(await graph.getLinks("pg-a")).toHaveLength(1)
  })

  test("clearExtractionForFamily clears child-part mentions + GCs orphaned entities (W4.5)", async () => {
    const graph = new ScopedGraph(db, p)
    const base = {
      kind: "concept",
      aliases: [] as string[],
      description: "",
      scope: null,
      visibility: "world",
      teamId: null,
    }
    // An entity mentioned ONLY by a CHILD part's chunk (child UUID prefix) — the root's `root:%`
    // sweep would NOT catch `child-uuid:0`, which is exactly the leak this fix closes.
    const solo = await graph.upsertEntity({
      ...base,
      name: "OnlyInChild",
      chunkIds: ["child-uuid:0"],
    })
    await graph.mention(solo, "chunk", "child-uuid:0")
    await graph.mention(solo, "document", "child-uuid")
    // A shared entity mentioned by an unrelated live doc — must SURVIVE the family clear.
    const shared = await graph.upsertEntity({ ...base, name: "Shared", chunkIds: ["other:0"] })
    await graph.mention(shared, "chunk", "other:0")

    await graph.clearExtractionForFamily(["root", "child-uuid"])

    const n = (q: string): number => (sqlite.query(q).get() as { n: number }).n
    // the child-only entity's mentions are gone AND it is GC'd
    expect(n(`SELECT count(*) AS n FROM entity_mentions WHERE source_id LIKE 'child-uuid%'`)).toBe(
      0,
    )
    expect(n(`SELECT count(*) AS n FROM entities WHERE canonical_name = 'OnlyInChild'`)).toBe(0)
    // the shared entity survives (still mentioned elsewhere)
    expect(n(`SELECT count(*) AS n FROM entities WHERE canonical_name = 'Shared'`)).toBe(1)
  })
})

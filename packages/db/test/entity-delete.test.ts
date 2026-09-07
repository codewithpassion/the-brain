import type { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import type { drizzle } from "drizzle-orm/bun-sqlite"
import { ScopedGraph } from "../src/graph/scoped-graph"
import { WikiStore } from "../src/wiki/store"
import { makeDb, principal, withBatch } from "./helpers"

/**
 * `delete_entity` / `merge_entities` store-level contract: a soft-deleted entity vanishes from every
 * read but keeps its UNIQUE key slot and REVIVES on re-extraction; hard delete destroys the rows;
 * `nameMatch` filters listings; the wiki lane names `delete_entity` when a slug is an entity page.
 */

const STAMP = "2026-09-07T00:00:00.000Z"

const insertEntity = (
  sqlite: Database,
  row: { id: string; name: string; kind?: string; tenantId?: string },
): void => {
  sqlite.run(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, mention_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [row.id, row.tenantId ?? "t1", row.kind ?? "person", row.name, STAMP, STAMP],
  )
}
const insertRelation = (sqlite: Database, id: string, from: string, to: string): void => {
  sqlite.run(
    `INSERT INTO entity_relations (id, tenant_id, from_entity_id, to_entity_id, kind, created_at, updated_at)
     VALUES (?, 't1', ?, ?, 'knows', ?, ?)`,
    [id, from, to, STAMP, STAMP],
  )
}
const insertMention = (sqlite: Database, id: string, entityId: string, sourceId: string): void => {
  sqlite.run(
    `INSERT INTO entity_mentions (id, tenant_id, entity_id, source_kind, source_id, created_at)
     VALUES (?, 't1', ?, 'chunk', ?, ?)`,
    [id, entityId, sourceId, STAMP],
  )
}
const count = (sqlite: Database, sql: string): number =>
  (sqlite.query(sql).get() as { n: number }).n

describe("delete_entity store contract", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>
  const p = principal({ tenantId: "t1", userId: "userA", capabilities: ["read", "write"] })

  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = withBatch(made.db)
    insertEntity(sqlite, { id: "e-speaker0", name: "Speaker 0" })
    insertEntity(sqlite, { id: "e-zoe", name: "Zoe Smith" })
    insertEntity(sqlite, { id: "e-other", name: "Speaker 1", tenantId: "t2" })
    insertRelation(sqlite, "r1", "e-speaker0", "e-zoe")
    insertMention(sqlite, "m1", "e-speaker0", "doc-1:0")
    insertMention(sqlite, "m2", "e-zoe", "doc-1:0")
  })

  test("soft delete hides the entity, drops its edges, keeps its mentions, and audits", async () => {
    const graph = new ScopedGraph(db, p)
    const out = await graph.softDeleteEntity("e-speaker0")
    expect(out.relationsDropped).toBe(1)
    const names = (await graph.listEntities({ kind: "person" })).map((e) => e.canonicalName)
    expect(names).toEqual(["Zoe Smith"])
    expect(count(sqlite, `SELECT COUNT(*) n FROM entity_relations`)).toBe(0)
    expect(
      count(sqlite, `SELECT COUNT(*) n FROM entity_mentions WHERE entity_id='e-speaker0'`),
    ).toBe(1)
    expect(
      count(
        sqlite,
        `SELECT COUNT(*) n FROM entities WHERE id='e-speaker0' AND deleted_at IS NOT NULL`,
      ),
    ).toBe(1)
    expect(count(sqlite, `SELECT COUNT(*) n FROM memory_audit WHERE action='entity.delete'`)).toBe(
      1,
    )
  })

  test("a re-extracted key still resolves the deleted row and revives it (no unique-index collision)", async () => {
    const graph = new ScopedGraph(db, p)
    await graph.softDeleteEntity("e-speaker0")
    const hit = await graph.findEntityByKey("speaker 0", "person", null)
    expect(hit?.id).toBe("e-speaker0")
    await graph.mergeEntityInto("e-speaker0", {
      name: "Speaker 0",
      kind: "person",
      aliases: [],
      description: "",
      chunkIds: ["doc-2:0"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    const names = (await graph.listEntities({ kind: "person" })).map((e) => e.canonicalName)
    expect(names.sort()).toEqual(["Speaker 0", "Zoe Smith"])
  })

  test("hard delete destroys the row, its mentions and edges", async () => {
    const graph = new ScopedGraph(db, p)
    const out = await graph.hardDeleteEntity("e-speaker0")
    expect(out).toEqual({ relationsDropped: 1, mentionsDropped: 1 })
    expect(count(sqlite, `SELECT COUNT(*) n FROM entities WHERE id='e-speaker0'`)).toBe(0)
    expect(
      count(sqlite, `SELECT COUNT(*) n FROM entity_mentions WHERE entity_id='e-speaker0'`),
    ).toBe(0)
    expect(
      count(sqlite, `SELECT COUNT(*) n FROM memory_audit WHERE action='entity.delete.hard'`),
    ).toBe(1)
    // The other entity's mention survives.
    expect(count(sqlite, `SELECT COUNT(*) n FROM entity_mentions`)).toBe(1)
  })

  test("cannot reach another tenant's entity", async () => {
    const graph = new ScopedGraph(db, p)
    await graph.softDeleteEntity("e-other")
    expect(
      count(sqlite, `SELECT COUNT(*) n FROM entities WHERE id='e-other' AND deleted_at IS NULL`),
    ).toBe(1)
    expect(await graph.getEntityForMerge("e-other")).toBeNull()
  })

  test("read-only principals are refused", async () => {
    const graph = new ScopedGraph(db, principal({ readOnly: true }))
    await expect(graph.softDeleteEntity("e-speaker0")).rejects.toThrow(/read-only/)
    await expect(graph.hardDeleteEntity("e-speaker0")).rejects.toThrow(/read-only/)
  })

  test("listEntities nameMatch is a case-insensitive substring filter", async () => {
    const graph = new ScopedGraph(db, p)
    expect((await graph.listEntities({ nameMatch: "SPEAKER" })).map((e) => e.id)).toEqual([
      "e-speaker0",
    ])
    expect((await graph.listEntities({ nameMatch: "smith" })).map((e) => e.id)).toEqual(["e-zoe"])
    expect(await graph.listEntities({ nameMatch: "nobody" })).toEqual([])
  })

  test("wiki_delete_page on an entity page names delete_entity and the entity id", async () => {
    sqlite.run(
      `INSERT INTO pages (id, tenant_id, slug, type, title, visibility, compiled_truth, frontmatter, ingested_via, entity_id, created_at, updated_at)
       VALUES ('pg-e', 't1', 'entities/person/speaker-0', 'entity', 'Speaker 0', 'world', '', '{}', 'entity', 'e-speaker0', ?, ?)`,
      [STAMP, STAMP],
    )
    const wiki = new WikiStore(db, p)
    await expect(wiki.deletePage("entities/person/speaker-0")).rejects.toThrow(
      /entity page.*entityId e-speaker0.*delete_entity/,
    )
    // The entity-side delete removes the minted page instead.
    const page = await wiki.deleteEntityPage("e-speaker0")
    expect(page).toEqual({ pageId: "pg-e", slug: "entities/person/speaker-0", title: "Speaker 0" })
    expect(
      count(sqlite, `SELECT COUNT(*) n FROM pages WHERE id='pg-e' AND deleted_at IS NOT NULL`),
    ).toBe(1)
    expect(await wiki.deleteEntityPage("e-speaker0")).toEqual({
      pageId: null,
      slug: null,
      title: null,
    })
  })
})

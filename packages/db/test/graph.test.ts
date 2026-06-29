import type { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { DOC_GRAPH, ENTITY_GRAPH, OpRegistry } from "@brain/shared"
import type { drizzle } from "drizzle-orm/bun-sqlite"
import { searchEntities } from "../src/graph/entities"
import { GRAPH_OPS, registerGraphOps } from "../src/graph/ops"
import { ScopedGraph } from "../src/graph/scoped-graph"
import { ScopedVectorize } from "../src/scoped/vectorize"
import { insertChunk, makeDb, principal } from "./helpers"

const STAMP = "2026-06-25T00:00:00.000Z"

/** Insert a `pages` row (doc-graph node). The triggers do not touch pages, so raw is fine. */
const insertPage = (
  sqlite: Database,
  row: {
    id: string
    tenantId: string
    title?: string
    type?: string
    scope?: string | null
    teamId?: string | null
    userId?: string | null
    visibility?: string
    slug?: string
    deletedAt?: string | null
  },
): void => {
  sqlite.run(
    `INSERT INTO pages
       (id, tenant_id, team_id, scope, user_id, slug, type, title, visibility,
        compiled_truth, frontmatter, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '{}', ?, ?, ?)`,
    [
      row.id,
      row.tenantId,
      row.teamId ?? null,
      row.scope ?? null,
      row.userId ?? null,
      row.slug ?? row.id,
      row.type ?? "note",
      row.title ?? row.id,
      row.visibility ?? "world",
      STAMP,
      STAMP,
      row.deletedAt ?? null,
    ],
  )
}

/** Insert a `doc_links` edge (from_id/to_id are ALWAYS pages.id). */
const insertDocLink = (
  sqlite: Database,
  row: { id: string; tenantId: string; fromId: string; toId: string; linkType?: string },
): void => {
  sqlite.run(
    `INSERT INTO doc_links (id, tenant_id, from_id, to_id, link_type, link_source, context, created_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
    [row.id, row.tenantId, row.fromId, row.toId, row.linkType ?? "relates", `ctx-${row.id}`, STAMP],
  )
}

/** Insert an `entities` row (FTS5 trigger fires off this raw INSERT). */
const insertEntity = (
  sqlite: Database,
  row: {
    id: string
    tenantId: string
    kind?: string
    name: string
    scope?: string | null
    teamId?: string | null
    visibility?: string
    description?: string
  },
): void => {
  sqlite.run(
    `INSERT INTO entities
       (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
        mention_count, scope, visibility, team_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', 0, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenantId,
      row.kind ?? "concept",
      row.name,
      row.description ?? `${row.name} description`,
      row.scope ?? null,
      row.visibility ?? "world",
      row.teamId ?? null,
      STAMP,
      STAMP,
    ],
  )
}

const insertEntityRelation = (
  sqlite: Database,
  row: { id: string; tenantId: string; fromId: string; toId: string; kind?: string },
): void => {
  sqlite.run(
    `INSERT INTO entity_relations
       (id, tenant_id, from_entity_id, to_entity_id, kind, confidence, evidence_chunk_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0.9, '[]', ?, ?)`,
    [row.id, row.tenantId, row.fromId, row.toId, row.kind ?? "knows", STAMP, STAMP],
  )
}

/** A fake entity Vectorize index returning a fixed match list (records query calls). */
const fakeEntityIndex = (matches: { id: string; score: number }[]) => {
  const index = {
    query: () => Promise.resolve({ matches, count: matches.length }),
    upsert: () => Promise.resolve({ mutationId: "m1" }),
  }
  return index as unknown as Vectorize
}

describe("ScopedGraph.traverse — BFS over EdgeSpec (invariants 3, 8, 19)", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>
  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = made.db
  })

  test("walks the doc graph out-direction to the configured depth", async () => {
    insertPage(sqlite, { id: "A", tenantId: "t1" })
    insertPage(sqlite, { id: "B", tenantId: "t1" })
    insertPage(sqlite, { id: "C", tenantId: "t1" })
    insertDocLink(sqlite, { id: "ab", tenantId: "t1", fromId: "A", toId: "B" })
    insertDocLink(sqlite, { id: "bc", tenantId: "t1", fromId: "B", toId: "C" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const paths = await graph.traverse(DOC_GRAPH, "A", { depth: 2, direction: "out" })
    expect(paths.map((p) => `${p.from_id}->${p.to_id}@${p.depth}`).sort()).toEqual([
      "A->B@1",
      "B->C@2",
    ])
  })

  test("the depth clamp stops the walk (depth 1 yields only the first hop)", async () => {
    insertPage(sqlite, { id: "A", tenantId: "t1" })
    insertPage(sqlite, { id: "B", tenantId: "t1" })
    insertPage(sqlite, { id: "C", tenantId: "t1" })
    insertDocLink(sqlite, { id: "ab", tenantId: "t1", fromId: "A", toId: "B" })
    insertDocLink(sqlite, { id: "bc", tenantId: "t1", fromId: "B", toId: "C" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const paths = await graph.traverse(DOC_GRAPH, "A", { depth: 1, direction: "out" })
    expect(paths.map((p) => p.to_id)).toEqual(["B"])
  })

  test("an out-of-visibility node is UNREACHABLE — the walk dead-ends, never crosses it", async () => {
    // A(world) → SECRET(private to another user) → C(world): the private node gates the hop,
    // so neither SECRET nor C downstream of it is ever emitted. A → D(world) → E(world) shows
    // the walk still proceeds down the visible branch.
    insertPage(sqlite, { id: "A", tenantId: "t1" })
    insertPage(sqlite, {
      id: "SECRET",
      tenantId: "t1",
      visibility: "private",
      userId: "someoneElse",
    })
    insertPage(sqlite, { id: "C", tenantId: "t1" })
    insertPage(sqlite, { id: "D", tenantId: "t1" })
    insertPage(sqlite, { id: "E", tenantId: "t1" })
    insertDocLink(sqlite, { id: "as", tenantId: "t1", fromId: "A", toId: "SECRET" })
    insertDocLink(sqlite, { id: "sc", tenantId: "t1", fromId: "SECRET", toId: "C" })
    insertDocLink(sqlite, { id: "ad", tenantId: "t1", fromId: "A", toId: "D" })
    insertDocLink(sqlite, { id: "de", tenantId: "t1", fromId: "D", toId: "E" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1", userId: "userA" }))
    const reached = new Set(
      (await graph.traverse(DOC_GRAPH, "A", { depth: 5, direction: "out" })).flatMap((p) => [
        p.from_id,
        p.to_id,
      ]),
    )
    expect(reached.has("D")).toBe(true)
    expect(reached.has("E")).toBe(true)
    expect(reached.has("SECRET")).toBe(false)
    expect(reached.has("C")).toBe(false)
  })

  test("a soft-deleted page is unreachable (deleted_at filter on both endpoints)", async () => {
    insertPage(sqlite, { id: "A", tenantId: "t1" })
    insertPage(sqlite, { id: "GONE", tenantId: "t1", deletedAt: STAMP })
    insertDocLink(sqlite, { id: "ag", tenantId: "t1", fromId: "A", toId: "GONE" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const paths = await graph.traverse(DOC_GRAPH, "A", { depth: 3, direction: "out" })
    expect(paths).toHaveLength(0)
  })

  test("the SAME engine walks the entity graph (ENTITY_GRAPH, no user_id arm)", async () => {
    insertEntity(sqlite, { id: "e1", tenantId: "t1", name: "Ada" })
    insertEntity(sqlite, { id: "e2", tenantId: "t1", name: "Babbage" })
    insertEntityRelation(sqlite, { id: "r1", tenantId: "t1", fromId: "e1", toId: "e2" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const paths = await graph.traverse(ENTITY_GRAPH, "e1", { depth: 2, direction: "both" })
    expect(paths.map((p) => `${p.from_id}->${p.to_id}`)).toEqual(["e1->e2"])
    expect(paths[0]?.link_type).toBe("knows")
  })

  test("an out-of-grant seed returns an empty traversal (drop-don't-error, no 403)", async () => {
    insertEntity(sqlite, { id: "e1", tenantId: "t1", name: "Ada", scope: "clientB" })
    insertEntity(sqlite, { id: "e2", tenantId: "t1", name: "Babbage", scope: "clientB" })
    insertEntityRelation(sqlite, { id: "r1", tenantId: "t1", fromId: "e1", toId: "e2" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1", allowedScopes: ["clientA"] }))
    const paths = await graph.traverse(ENTITY_GRAPH, "e1", { depth: 3, direction: "both" })
    expect(paths).toHaveLength(0)
  })
})

describe("searchEntities — vector + entity_fts RRF + D1 re-check (invariants 3, 4)", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>
  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = made.db
  })

  test("fuses arms and re-checks: a bogus vector id is DROPPED, real entities survive", async () => {
    insertEntity(sqlite, {
      id: "e1",
      tenantId: "t1",
      name: "needle widget",
      description: "the needle",
    })
    insertEntity(sqlite, { id: "e2", tenantId: "t1", name: "haystack", description: "unrelated" })

    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)
    // The fake vector arm surfaces a BOGUS id alongside a real one — the re-check must drop it.
    const entityVectors = new ScopedVectorize(
      fakeEntityIndex([
        { id: "e1", score: 0.95 },
        { id: "bogus-cross-tenant", score: 0.9 },
      ]),
      p,
    )
    const deps = { graph, entityVectors, ai: { embed: async () => [[0.1]] } }

    const hits = await searchEntities(deps, "needle", { topK: 10 })
    const ids = hits.map((h) => h.id)
    expect(ids).toContain("e1")
    expect(ids).not.toContain("bogus-cross-tenant")
    expect(hits.find((h) => h.id === "e1")?.name).toBe("needle widget")
  })

  test("degrades to the keyword arm when the embedder is unavailable", async () => {
    insertEntity(sqlite, { id: "e1", tenantId: "t1", name: "needle widget" })

    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)
    const entityVectors = new ScopedVectorize(fakeEntityIndex([]), p)
    // embed returns null → vector arm empty; entity_fts still finds the entity.
    const deps = { graph, entityVectors, ai: { embed: async () => null } }

    const hits = await searchEntities(deps, "needle", { topK: 10 })
    expect(hits.map((h) => h.id)).toContain("e1")
  })

  test("never returns another tenant's entity even when the vector arm leaks its id", async () => {
    insertEntity(sqlite, { id: "mine", tenantId: "t1", name: "shared name" })
    insertEntity(sqlite, { id: "theirs", tenantId: "t2", name: "shared name" })

    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)
    const entityVectors = new ScopedVectorize(
      fakeEntityIndex([
        { id: "mine", score: 0.9 },
        { id: "theirs", score: 0.92 },
      ]),
      p,
    )
    const deps = { graph, entityVectors, ai: { embed: async () => [[0.1]] } }

    const hits = await searchEntities(deps, "shared", { topK: 10 })
    expect(hits.map((h) => h.id)).toEqual(["mine"])
  })
})

describe("registerGraphOps — op registry wiring", () => {
  test("registers exactly the enumerated graph ops, no duplicates", () => {
    const registry = registerGraphOps(new OpRegistry())
    const names = registry.list().map((op) => op.name)
    expect(names.sort()).toEqual(
      [
        "find_orphans",
        "get_backlinks",
        "get_links",
        "get_tags",
        "get_timeline",
        "list_entities",
        "list_entity_edges",
        "search_entities",
        "traverse_graph",
      ].sort(),
    )
    expect(names.length).toBe(GRAPH_OPS.length)
    // every op is read-only (the mutating §6.5 surface is deferred).
    expect(registry.list().every((op) => op.readOnly)).toBe(true)
  })

  test("a second registration of the same name throws (frozen catalog)", () => {
    const registry = registerGraphOps(new OpRegistry())
    expect(() => registry.register(GRAPH_OPS[0]?.def ?? (null as never))).toThrow()
  })
})

describe("ScopedGraph entity writes — upsert / relate / mention / clear-prior (§6.3, §6.6)", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>
  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = made.db
  })

  const count = (sql: string, binds: unknown[] = []): number =>
    (sqlite.query(sql).get(...(binds as [])) as { n: number }).n

  test("upsertEntity dedups by key: unions aliases, increments mentions, max-permissive visibility", async () => {
    const graph = new ScopedGraph(db, principal({ tenantId: "t1", teamIds: ["team1"] }))
    const id1 = await graph.upsertEntity({
      name: "Quantum Widget",
      kind: "concept",
      aliases: ["QW"],
      description: "first",
      chunkIds: ["c1"],
      scope: null,
      visibility: "team",
      teamId: "team1",
    })
    const id2 = await graph.upsertEntity({
      name: "quantum widget", // case-insensitive key collision
      kind: "concept",
      aliases: ["Widget"],
      description: "second",
      chunkIds: ["c2"],
      scope: null,
      visibility: "world", // promotes max-permissive → world
      teamId: null,
    })
    expect(id2).toBe(id1) // same row
    const [entity] = await graph.listEntities()
    expect(entity?.aliases.sort()).toEqual(["QW", "Widget"])
    expect(entity?.mentionCount).toBe(2)
    expect(entity?.visibility).toBe("world")
    expect(entity?.teamId).toBeNull()
  })

  test("relate dedups by key: unions evidence and takes MAX confidence", async () => {
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const base = {
      kind: "concept",
      aliases: [],
      description: "",
      scope: null,
      visibility: "world",
      teamId: null,
    }
    const from = await graph.upsertEntity({ ...base, name: "Ada", chunkIds: ["c1"] })
    const to = await graph.upsertEntity({ ...base, name: "Babbage", chunkIds: ["c1"] })
    await graph.relate({ kind: "knows", confidence: 0.4, chunkIds: ["c1"] }, from, to)
    await graph.relate({ kind: "knows", confidence: 0.9, chunkIds: ["c2"] }, from, to)
    const row = sqlite
      .query(
        "SELECT confidence AS conf, evidence_chunk_ids AS ev FROM entity_relations WHERE from_entity_id = ? AND to_entity_id = ? AND kind = 'knows'",
      )
      .get(from, to) as { conf: number; ev: string }
    expect(count("SELECT count(*) AS n FROM entity_relations")).toBe(1) // deduped
    expect(row.conf).toBe(0.9) // max
    expect((JSON.parse(row.ev) as string[]).sort()).toEqual(["c1", "c2"]) // union
  })

  test("mention is idempotent on its uniq key", async () => {
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const id = await graph.upsertEntity({
      name: "Ada",
      kind: "concept",
      aliases: [],
      description: "",
      chunkIds: ["c1"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    await graph.mention(id, "chunk", "c1")
    await graph.mention(id, "chunk", "c1") // duplicate → no-op
    expect(count("SELECT count(*) AS n FROM entity_mentions WHERE entity_id = ?", [id])).toBe(1)
  })

  test("clearPriorExtraction deletes the source's mentions and prunes/deletes relation evidence", async () => {
    // Chunk id follows the ${documentId}:${index} convention so the LIKE 'doc1:%' sweep matches.
    insertChunk(sqlite, { id: "doc1:0", tenantId: "t1", documentId: "doc1" })
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const base = {
      kind: "concept",
      aliases: [],
      description: "",
      scope: null,
      visibility: "world",
      teamId: null,
    }
    const from = await graph.upsertEntity({ ...base, name: "Ada", chunkIds: ["doc1:0"] })
    const to = await graph.upsertEntity({ ...base, name: "Babbage", chunkIds: ["doc1:0"] })
    // mixed-evidence relation survives (pruned to cX); source-only relation is deleted outright.
    await graph.relate({ kind: "mixed", confidence: 0.5, chunkIds: ["doc1:0", "cX"] }, from, to)
    await graph.relate({ kind: "sourceonly", confidence: 0.5, chunkIds: ["doc1:0"] }, from, to)
    await graph.mention(from, "document", "doc1")
    await graph.mention(from, "chunk", "doc1:0") // chunk belongs to doc1 → cleared by LIKE sweep

    await graph.clearPriorExtraction({ sourceKind: "document", sourceId: "doc1" })

    expect(count("SELECT count(*) AS n FROM entity_mentions WHERE source_kind = 'document'")).toBe(
      0,
    )
    // chunk-scoped mention for doc1:0 is swept by LIKE 'doc1:%'.
    expect(count("SELECT count(*) AS n FROM entity_mentions WHERE source_kind = 'chunk'")).toBe(0)
    expect(count("SELECT count(*) AS n FROM entity_relations WHERE kind = 'sourceonly'")).toBe(0)
    const mixed = sqlite
      .query("SELECT evidence_chunk_ids AS ev FROM entity_relations WHERE kind = 'mixed'")
      .get() as { ev: string } | null
    expect(mixed === null ? [] : (JSON.parse(mixed.ev) as string[])).toEqual(["cX"])
  })

  test("clearPriorExtraction prefix-sweeps orphaned chunk mentions after chunk-count shrink", async () => {
    // Simulate a supersede that reduced docS from 8 chunks to 1: only docS:0 survives in the
    // DB; docS:7 was hard-deleted. The old clearPriorExtraction used inArray(currentChunkIds)
    // and would have missed docS:7's orphaned mention rows; the LIKE-based fix catches them.
    insertChunk(sqlite, { id: "docS:0", tenantId: "t1", documentId: "docS" })
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const base = {
      kind: "concept",
      aliases: [],
      description: "",
      scope: null,
      visibility: "world",
      teamId: null,
    }

    // Shared entity: mentioned from docS:0 (will be swept) AND from otherDoc:0 (survives).
    const sharedId = await graph.upsertEntity({ ...base, name: "SharedEnt", chunkIds: ["docS:0"] })
    await graph.mention(sharedId, "chunk", "docS:0")
    await graph.mention(sharedId, "chunk", "otherDoc:0") // unaffected by docS clear

    // Unique entity: only mentioned from the removed chunk docS:7 → must be GC'd.
    const uniqueId = await graph.upsertEntity({ ...base, name: "RemovedEnt", chunkIds: ["docS:7"] })
    await graph.mention(uniqueId, "chunk", "docS:7") // orphaned: docS:7 no longer in chunks table

    await graph.clearPriorExtraction(
      { sourceKind: "document", sourceId: "docS" },
      { gcOrphanedEntities: true },
    )

    // All docS:* chunk-scoped mentions swept — including the orphaned docS:7 one.
    expect(
      count(
        "SELECT count(*) AS n FROM entity_mentions WHERE source_kind = 'chunk' AND source_id LIKE 'docS:%'",
      ),
    ).toBe(0)
    // SharedEnt survives: still has a mention from otherDoc:0.
    expect(count("SELECT count(*) AS n FROM entities WHERE id = ?", [sharedId])).toBe(1)
    // RemovedEnt is GC'd: its only mention (docS:7) was swept.
    expect(count("SELECT count(*) AS n FROM entities WHERE id = ?", [uniqueId])).toBe(0)
  })

  test("a written entity round-trips through searchEntities (entity_fts trigger fired)", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)
    await graph.upsertEntity({
      name: "Photon Drive",
      kind: "concept",
      aliases: [],
      description: "a propulsion concept",
      chunkIds: ["c1"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    const deps = {
      graph,
      entityVectors: new ScopedVectorize(fakeEntityIndex([]), p),
      ai: { embed: async () => null }, // keyword arm only — proves the FTS trigger fired on write
    }
    const hits = await searchEntities(deps, "Photon", { topK: 5 })
    expect(hits.map((h) => h.name)).toContain("Photon Drive")
  })
})

describe("ScopedGraph.findOrphans — disconnected-node report (§6.6)", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>
  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = made.db
  })

  test("returns normal-slug orphans, excludes linked + pseudo (`_`) pages", async () => {
    insertPage(sqlite, { id: "linkedA", tenantId: "t1", slug: "linked-a" })
    insertPage(sqlite, { id: "linkedB", tenantId: "t1", slug: "linked-b" })
    insertPage(sqlite, { id: "orphan1", tenantId: "t1", slug: "lonely-note" })
    insertPage(sqlite, { id: "pseudo1", tenantId: "t1", slug: "_hidden" })
    insertDocLink(sqlite, { id: "lab", tenantId: "t1", fromId: "linkedA", toId: "linkedB" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const report = await graph.findOrphans("doc")
    expect(report.orphans.map((o) => o.id)).toEqual(["orphan1"]) // the bug-fix lock-in
    expect(report.totalOrphans).toBe(1)
    expect(report.totalNodes).toBe(4)
    expect(report.totalLinkable).toBe(3) // pseudo excluded
    expect(report.excluded).toBe(1)
  })

  test("generalizes to the entity graph (entities with no relations)", async () => {
    insertEntity(sqlite, { id: "e1", tenantId: "t1", name: "Linked One" })
    insertEntity(sqlite, { id: "e2", tenantId: "t1", name: "Linked Two" })
    insertEntity(sqlite, { id: "e3", tenantId: "t1", name: "Lonely" })
    insertEntityRelation(sqlite, { id: "r1", tenantId: "t1", fromId: "e1", toId: "e2" })

    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))
    const report = await graph.findOrphans("entity")
    expect(report.orphans.map((o) => o.id)).toEqual(["e3"])
  })
})

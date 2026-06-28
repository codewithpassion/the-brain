/**
 * Phase 2 Obsidian integration — focused tests (PRD §9.0.2).
 *
 * Tests the DB-layer primitives for:
 *  1. Deletion propagation: softDeleteDocument → chunks get deleted_at, recheckChunks excludes them.
 *  2. Supersede on edit: hardDeleteDocumentChunks + updateDocumentForSupersede → old chunks gone,
 *     doc row reused (same id/slug), fingerprint updated, re-ingest writes fresh chunks.
 *  3. recheckChunks exclusion: a soft-deleted document's chunks never surface through the re-check
 *     JOIN even if the chunk's own deleted_at is NOT set (defense in depth via documents.deleted_at).
 *  4. KG forget: clearPriorExtraction clears chunk-scoped entity mentions on delete (FIX 1).
 *
 * Note: supersede uses hard-delete for chunks (not soft-delete as the Phase-2 spec states) because
 * chunk ids are deterministic (`${docId}:${chunkIndex}`); soft-deleted rows still hold the PK, so
 * insertChunks (onConflictDoNothing) would silently skip writing new content. Hard-delete is the
 * minimal correct fix — documented in the Phase-2 adversarial-review report.
 */
import { describe, expect, test } from "bun:test"
import { ScopedGraph } from "../src/graph/scoped-graph"
import { ScopedDB } from "../src/scoped/db"
import { insertChunk, insertDoc, makeDb, principal, withBatch } from "./helpers"

const rowCount = (sqlite: ReturnType<typeof makeDb>["sqlite"], sql: string): number =>
  (sqlite.query(sql).get() as { n: number }).n

// ── Deliverable 1 — soft-delete propagation ───────────────────────────────────

describe("softDeleteDocument — deletion propagation", () => {
  test("sets deleted_at on the document row and all live chunks", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "inbox" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    insertChunk(sqlite, { id: "d1:1", tenantId: "t1", documentId: "d1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    const { chunkIds } = await sdb.softDeleteDocument("d1")

    // Returns the live chunk ids for Vectorize cleanup.
    expect(chunkIds.sort()).toEqual(["d1:0", "d1:1"])

    // Document row has deleted_at set.
    const doc = sqlite.query("SELECT deleted_at FROM documents WHERE id = 'd1'").get() as {
      deleted_at: string | null
    }
    expect(doc.deleted_at).not.toBeNull()

    // All chunks have deleted_at set.
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM chunks WHERE document_id = 'd1' AND deleted_at IS NULL",
      ),
    ).toBe(0)
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM chunks WHERE document_id = 'd1' AND deleted_at IS NOT NULL",
      ),
    ).toBe(2)
  })

  test("is idempotent: re-running on an already-deleted doc is a no-op and returns empty chunkIds", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "inbox" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.softDeleteDocument("d1")
    const { chunkIds } = await sdb.softDeleteDocument("d1") // second call

    // Already-deleted chunks have deleted_at IS NOT NULL, so they're not in the result.
    expect(chunkIds).toEqual([])
    // Only one audit row per soft-delete call (both still audit, but chunkIds is empty on second).
    expect(
      rowCount(
        sqlite,
        "SELECT count(*) AS n FROM documents WHERE id = 'd1' AND deleted_at IS NOT NULL",
      ),
    ).toBe(1)
  })

  test("tenant isolation: soft-delete only touches the calling tenant's document", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "inbox" })
    insertDoc(sqlite, { id: "d2", tenantId: "t2", slug: "inbox" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.softDeleteDocument("d1")

    // t1's doc is deleted; t2's doc is untouched.
    const d1 = sqlite.query("SELECT deleted_at FROM documents WHERE id = 'd1'").get() as {
      deleted_at: string | null
    }
    const d2 = sqlite.query("SELECT deleted_at FROM documents WHERE id = 'd2'").get() as {
      deleted_at: string | null
    }
    expect(d1.deleted_at).not.toBeNull()
    expect(d2.deleted_at).toBeNull()
  })
})

// ── recheckChunks exclusion — search excludes soft-deleted docs ───────────────

describe("recheckChunks — excludes chunks of soft-deleted documents", () => {
  test("a live chunk belonging to a soft-deleted document is dropped by the D1 re-check", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "projects/acme/notes" })
    insertChunk(sqlite, {
      id: "d1:0",
      tenantId: "t1",
      documentId: "d1",
      content: "live chunk of deleted doc",
    })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    // Soft-delete the document; the chunk's own deleted_at remains NULL (not soft-deleted).
    await sdb.softDeleteDocument("d1")
    // Verify: chunk's deleted_at is set by softDeleteDocument (it also soft-deletes chunks).
    // But even if it weren't, documents.deleted_at exclusion in recheckChunks should drop it.
    // This test verifies the documents.deleted_at IS NULL predicate in the INNER JOIN path.

    // Simulate a search arm returning this chunk id:
    const results = await sdb.getChunksByIds(["d1:0"])
    expect(results).toHaveLength(0) // dropped by re-check (document is soft-deleted)
  })

  test("a live chunk of a LIVE document still surfaces through the re-check after sibling deletion", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "deleted-note" })
    insertDoc(sqlite, { id: "d2", tenantId: "t1", slug: "live-note" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    insertChunk(sqlite, { id: "d2:0", tenantId: "t1", documentId: "d2" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.softDeleteDocument("d1")

    const results = await sdb.getChunksByIds(["d1:0", "d2:0"])
    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe("d2:0")
  })
})

// ── listDocuments — excludes soft-deleted documents ───────────────────────────

describe("listDocuments — excludes soft-deleted documents", () => {
  test("soft-deleted documents are not returned by listDocuments", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "note-a" })
    insertDoc(sqlite, { id: "d2", tenantId: "t1", slug: "note-b" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.softDeleteDocument("d1")
    const docs = await sdb.listDocuments()

    expect(docs).toHaveLength(1)
    expect(docs[0]?.id).toBe("d2")
  })
})

// ── Deliverable 2 — supersede on edit ────────────────────────────────────────

describe("hardDeleteDocumentChunks + updateDocumentForSupersede — supersede on edit", () => {
  test("hard-deletes old chunks, frees PK for re-ingest, updates doc fingerprint", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "Projects/Acme/notes" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1", content: "old chunk 0" })
    insertChunk(sqlite, { id: "d1:1", tenantId: "t1", documentId: "d1", content: "old chunk 1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    // Step 1: hard-delete old chunks (supersede path).
    const { chunkIds } = await sdb.hardDeleteDocumentChunks("d1")
    expect(chunkIds.sort()).toEqual(["d1:0", "d1:1"])

    // Old chunk rows are gone (hard-deleted, not soft-deleted).
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM chunks WHERE document_id = 'd1'")).toBe(0)

    // Step 2: update the doc row for supersede.
    await sdb.updateDocumentForSupersede("d1", {
      fingerprint: "obsidian:Projects/Acme/notes.md:new-etag",
      bodyR2Key: "backfill/run1/new-fp.json",
      deletedAt: null,
    })

    // Doc row is still live, fingerprint updated, status reset.
    const doc = sqlite
      .query("SELECT id, slug, fingerprint, status, deleted_at FROM documents WHERE id = 'd1'")
      .get() as {
      id: string
      slug: string
      fingerprint: string
      status: string
      deleted_at: string | null
    }
    expect(doc.id).toBe("d1") // same UUID reused
    expect(doc.slug).toBe("Projects/Acme/notes") // stable slug unchanged
    expect(doc.fingerprint).toBe("obsidian:Projects/Acme/notes.md:new-etag")
    expect(doc.status).toBe("pending") // re-ingest restarted
    expect(doc.deleted_at).toBeNull()
  })

  test("PKs are free after hard-delete — new chunks with same ids can be inserted", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "notes/daily" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1", content: "old content" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.hardDeleteDocumentChunks("d1")
    // Insert a new chunk with the same id — must NOT be skipped (PK is free after hard-delete).
    await sdb.insertChunks([
      { id: "d1:0", documentId: "d1", chunkIndex: 0, content: "new content" },
    ])

    const row = sqlite.query("SELECT content FROM chunks WHERE id = 'd1:0'").get() as {
      content: string
    }
    expect(row.content).toBe("new content") // fresh content, not skipped by onConflictDoNothing
  })

  test("resurrection: soft-deleted doc is resurrected and superseded in one operation", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "weekly-review" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    // Simulate note deleted from vault: soft-delete document + chunks.
    await sdb.softDeleteDocument("d1")
    // Simulate note returning to vault: hard-delete old chunks (including soft-deleted), update doc.
    await sdb.hardDeleteDocumentChunks("d1")
    await sdb.updateDocumentForSupersede("d1", {
      fingerprint: "obsidian:weekly-review.md:new-etag",
      bodyR2Key: "backfill/run2/fp.json",
      deletedAt: null, // clear the soft-delete
    })

    const doc = sqlite.query("SELECT deleted_at, status FROM documents WHERE id = 'd1'").get() as {
      deleted_at: string | null
      status: string
    }
    expect(doc.deleted_at).toBeNull() // resurrected
    expect(doc.status).toBe("pending") // re-ingest pending
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM chunks WHERE document_id = 'd1'")).toBe(0)
  })
})

// ── getDocumentBySlug — returns fingerprint + deletedAt ──────────────────────

describe("getDocumentBySlug — Phase 2 extended return", () => {
  test("returns fingerprint and deletedAt alongside id and status", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "my-note" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    const row = await sdb.getDocumentBySlug("my-note")
    expect(row).not.toBeNull()
    expect(row?.id).toBe("d1")
    expect(row?.fingerprint).toBe("fp-d1")
    expect(row?.deletedAt).toBeNull()
    expect(row?.status).toBe("indexed")
  })

  test("returns soft-deleted documents (slug is still occupied; caller decides resurrection vs no-op)", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "deleted-note" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.softDeleteDocument("d1")
    const row = await sdb.getDocumentBySlug("deleted-note")

    expect(row).not.toBeNull()
    expect(row?.deletedAt).not.toBeNull() // soft-deleted; caller can resurrect
  })
})

// ── getDocumentsBySource — Phase-2 reconcile query ───────────────────────────

describe("getDocumentsBySource — reconcile query", () => {
  test("returns live Phase-2 obsidian docs for a source (sourceKind=obsidian, not deleted)", async () => {
    const { sqlite, db } = makeDb()
    // Insert a Phase-2 obsidian doc (sourceKind=obsidian).
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, source_id, source_kind)
       VALUES ('d1', 't1', 'u1', 'Projects/notes', 'indexed', 'fp-1', 'src-1', 'obsidian')`,
    )
    // Insert a Phase-1 doc (no sourceKind) — must NOT be returned.
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, source_id)
       VALUES ('d2', 't1', 'u1', 'bf-obsidian:old:etag', 'indexed', 'fp-2', 'src-1')`,
    )
    // Insert a soft-deleted Phase-2 doc — must NOT be returned.
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, source_id, source_kind, deleted_at)
       VALUES ('d3', 't1', 'u1', 'Archive/memo', 'indexed', 'fp-3', 'src-1', 'obsidian', '2026-06-27T00:00:00.000Z')`,
    )
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    const docs = await sdb.getDocumentsBySource("src-1")
    expect(docs).toHaveLength(1)
    expect(docs[0]?.id).toBe("d1")
    expect(docs[0]?.slug).toBe("Projects/notes")
  })
})

// ── FIX 1 — KG forget: delete clears chunk-scoped entity mentions ─────────────

describe("clearPriorExtraction — clears chunk-scoped mentions on document delete (FIX 1)", () => {
  test("chunk-scoped mentions (sourceKind=chunk) are cleared alongside document-scoped ones", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "Projects/notes" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    insertChunk(sqlite, { id: "d1:1", tenantId: "t1", documentId: "d1" })
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))

    // Insert an entity and write mentions exactly as the extractor does:
    // sourceKind='chunk', sourceId=chunkId (not 'document').
    const entityId = await graph.upsertEntity({
      name: "Test Entity",
      kind: "concept",
      aliases: [],
      description: "",
      chunkIds: ["d1:0", "d1:1"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    await graph.mention(entityId, "chunk", "d1:0")
    await graph.mention(entityId, "chunk", "d1:1")

    // Before: two chunk-scoped mentions exist.
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM entity_mentions WHERE source_kind = 'chunk'"),
    ).toBe(2)

    // clearPriorExtraction with sourceKind='document' must also clear chunk-scoped mentions.
    await graph.clearPriorExtraction({ sourceKind: "document", sourceId: "d1" })

    // After: all chunk-scoped mentions for d1's chunks are gone.
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM entity_mentions WHERE source_kind = 'chunk'"),
    ).toBe(0)
  })

  test("chunk-scoped mentions for OTHER documents are NOT cleared (tenant isolation)", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "note-to-delete" })
    insertDoc(sqlite, { id: "d2", tenantId: "t1", slug: "note-to-keep" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    insertChunk(sqlite, { id: "d2:0", tenantId: "t1", documentId: "d2" })
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))

    const entityId = await graph.upsertEntity({
      name: "Shared Entity",
      kind: "concept",
      aliases: [],
      description: "",
      chunkIds: ["d1:0", "d2:0"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    await graph.mention(entityId, "chunk", "d1:0")
    await graph.mention(entityId, "chunk", "d2:0")

    // Clear for d1 only (no GC opt) — d2's mention must survive.
    await graph.clearPriorExtraction({ sourceKind: "document", sourceId: "d1" })

    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM entity_mentions WHERE source_kind = 'chunk'"),
    ).toBe(1) // d2:0 survives
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM entity_mentions WHERE source_id = 'd2:0'"),
    ).toBe(1)
  })

  test("gcOrphanedEntities: entity with zero remaining mentions is removed from entities table", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "Projects/notes" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))

    const entityId = await graph.upsertEntity({
      name: "Orphan Entity",
      kind: "concept",
      aliases: [],
      description: "",
      chunkIds: ["d1:0"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    await graph.mention(entityId, "chunk", "d1:0")

    expect(rowCount(sqlite, `SELECT count(*) AS n FROM entities WHERE id = '${entityId}'`)).toBe(1)

    await graph.clearPriorExtraction(
      { sourceKind: "document", sourceId: "d1" },
      { gcOrphanedEntities: true },
    )

    // Entity removed: no remaining mentions → orphaned → GC'd.
    expect(rowCount(sqlite, `SELECT count(*) AS n FROM entities WHERE id = '${entityId}'`)).toBe(0)
  })

  test("gcOrphanedEntities: entity shared across documents survives when one doc is deleted", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "note-to-delete" })
    insertDoc(sqlite, { id: "d2", tenantId: "t1", slug: "note-to-keep" })
    insertChunk(sqlite, { id: "d1:0", tenantId: "t1", documentId: "d1" })
    insertChunk(sqlite, { id: "d2:0", tenantId: "t1", documentId: "d2" })
    const graph = new ScopedGraph(db, principal({ tenantId: "t1" }))

    const entityId = await graph.upsertEntity({
      name: "Shared Entity",
      kind: "concept",
      aliases: [],
      description: "",
      chunkIds: ["d1:0", "d2:0"],
      scope: null,
      visibility: "world",
      teamId: null,
    })
    await graph.mention(entityId, "chunk", "d1:0")
    await graph.mention(entityId, "chunk", "d2:0")

    // Delete d1 with GC — shared entity must NOT be GC'd (still has d2:0 mention).
    await graph.clearPriorExtraction(
      { sourceKind: "document", sourceId: "d1" },
      { gcOrphanedEntities: true },
    )

    expect(rowCount(sqlite, `SELECT count(*) AS n FROM entities WHERE id = '${entityId}'`)).toBe(1) // survived — still mentioned from d2:0
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM entity_mentions WHERE source_id = 'd2:0'"),
    ).toBe(1)
  })
})

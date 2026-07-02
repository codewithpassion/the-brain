import { describe, expect, test } from "bun:test"
import { getStatsCore, listDocumentsCore } from "../src/admin/ops"
import { runBatchIngestCore } from "../src/ingest"
import { ScopedDB } from "../src/scoped/db"
import { ftsArm } from "../src/search/arms"
import type { ScopedServices } from "../src/services"
import { insertDoc, makeDb, principal, withBatch } from "./helpers"

/**
 * W4.5 — oversized-doc `ChunkPart` materialization (§4.3). A document that overflows the
 * per-part ceilings is split into parts, each its OWN `documents` row (part 0 = the original;
 * parts ≥1 = child rows carrying parent_document_id + part_index + part_count). Proves the split
 * lands the right rows/chunks and that a NON-root part is searchable via the real FTS re-check.
 */

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

// 3 paragraphs, each > CHUNK_TARGET (1200) so paragraph-packing keeps them as 3 separate chunks;
// each carries a unique needle so we can prove each part is independently searchable.
const para = (needle: string): string => `${needle} ${"lorem ipsum dolor ".repeat(80)}`
const MARKDOWN = [para("alpharoot"), para("betachild"), para("gammachild")].join("\n\n")

/** Minimal ScopedServices: real ScopedDB over sqlite; blobs/vectors/ai stubbed to the parts used. */
const makeServices = (db: ReturnType<typeof makeDb>["db"], p: ReturnType<typeof principal>) =>
  ({
    db: new ScopedDB(withBatch(db), p),
    blobs: { get: async () => ({ text: async () => MARKDOWN }) },
    vectors: { upsert: async () => {} },
    ai: { embedForIndex: async (texts: string[]) => texts.map(() => vec1024()) },
  }) as unknown as ScopedServices

describe("runBatchIngestCore — ChunkPart materialization (W4.5)", () => {
  const p = principal({ tenantId: "t1", userId: "userA" })

  test("splits an oversized doc into one documents row per part (part 0 = original)", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "doc-1", tenantId: p.tenantId, slug: "root-slug" })
    const services = makeServices(db, p)

    const result = await runBatchIngestCore(services, {
      documentId: "doc-1",
      r2Key: "k",
      contentType: "text/markdown",
      partLimits: { maxChunks: 1 }, // force one chunk per part → 3 parts
    })
    expect(result.status).toBe("indexed")
    expect(result.chunkCount).toBe(3) // total across all parts
    // the two child part ids are surfaced so the caller can run KG extraction over them too.
    expect(result.partDocumentIds).toHaveLength(2)
    expect(result.partDocumentIds).not.toContain("doc-1")

    const docs = sqlite
      .query(
        `SELECT id, slug, parent_document_id AS parent, part_index AS pi, part_count AS pc,
                chunk_count AS cc, status
         FROM documents ORDER BY part_index`,
      )
      .all() as {
      id: string
      slug: string
      parent: string | null
      pi: number | null
      pc: number | null
      cc: number | null
      status: string
    }[]

    expect(docs).toHaveLength(3)
    // Root (part 0) reuses the original id; records its own part identity, no parent.
    const root = docs.find((d) => d.id === "doc-1")
    expect(root).toMatchObject({ parent: null, pi: 0, pc: 3, cc: 1, status: "indexed" })
    // Children carry parent_document_id + their part index, inheriting a derived slug.
    const children = docs.filter((d) => d.id !== "doc-1")
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(child.parent).toBe("doc-1")
      expect(child.pc).toBe(3)
      expect(child.cc).toBe(1)
      expect(child.status).toBe("indexed")
      expect(child.slug.startsWith("root-slug-p")).toBe(true)
    }
    expect(children.map((c) => c.pi).sort()).toEqual([1, 2])
  })

  test("each part owns exactly its chunk slice, re-indexed from 0", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "doc-1", tenantId: p.tenantId, slug: "root-slug" })
    await runBatchIngestCore(makeServices(db, p), {
      documentId: "doc-1",
      r2Key: "k",
      contentType: "text/markdown",
      partLimits: { maxChunks: 1 },
    })
    const chunks = sqlite
      .query(`SELECT id, document_id AS doc, chunk_index AS ci, content FROM chunks`)
      .all() as { id: string; doc: string; ci: number; content: string }[]
    expect(chunks).toHaveLength(3)
    // Every chunk is index 0 of its own part-document; ids are `${docId}:0`.
    for (const c of chunks) {
      expect(c.ci).toBe(0)
      expect(c.id).toBe(`${c.doc}:0`)
    }
    // The root holds the first paragraph; the children hold the later ones.
    const root = chunks.find((c) => c.doc === "doc-1")
    expect(root?.content.includes("alpharoot")).toBe(true)
    const childContent = chunks.filter((c) => c.doc !== "doc-1").map((c) => c.content)
    expect(childContent.some((t) => t.includes("betachild"))).toBe(true)
    expect(childContent.some((t) => t.includes("gammachild"))).toBe(true)
  })

  test("a NON-root part is searchable via the FTS re-check (search still works post-split)", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "doc-1", tenantId: p.tenantId, slug: "root-slug" })
    const scoped = new ScopedDB(withBatch(db), p)
    await runBatchIngestCore(makeServices(db, p), {
      documentId: "doc-1",
      r2Key: "k",
      contentType: "text/markdown",
      partLimits: { maxChunks: 1 },
    })
    // "gammachild" lives only in the last (child) part; the FTS arm must surface it through the
    // full re-check + hydration, proving a materialized child part is a first-class search target.
    const hits = await ftsArm(scoped, "gammachild", 10)
    expect(hits.length).toBeGreaterThan(0)
    // W4.5 citation → parent: the child-part hit resolves to the PARENT slug (one coherent source),
    // never the internal `root-slug-p2`. documentId likewise resolves to the parent doc id.
    const hit = hits.find((h) => h.content.includes("gammachild"))
    expect(hit?.slug).toBe("root-slug")
    expect(hit?.documentId).toBe("doc-1")
  })

  test("a single-part doc is unchanged: one row, no children, part_index NULL", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "doc-solo", tenantId: p.tenantId, slug: "solo-slug" })
    const services = makeServices(db, p)
    // Default ceilings (4000 chunks / 8MB) → the 3 small chunks fit one part.
    const result = await runBatchIngestCore(services, {
      documentId: "doc-solo",
      r2Key: "k",
      contentType: "text/markdown",
    })
    expect(result.status).toBe("indexed")
    expect(result.partDocumentIds).toEqual([]) // no split → no child parts
    const docs = sqlite
      .query(`SELECT id, parent_document_id AS parent, part_index AS pi FROM documents`)
      .all() as { id: string; parent: string | null; pi: number | null }[]
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ id: "doc-solo", parent: null, pi: null })
  })
})

// ── W4.5 lifecycle cascade (delete / supersede / list) ──────────────────────────────

describe("runBatchIngestCore — split-doc lifecycle cascade (W4.5)", () => {
  const p = principal({ tenantId: "t1", userId: "userA" })

  /** Ingest doc-1 as a forced 3-part split; return the shared sqlite + drizzle + scoped handles. */
  const split3 = async () => {
    const { sqlite, db: raw } = makeDb()
    const db = withBatch(raw)
    insertDoc(sqlite, { id: "doc-1", tenantId: p.tenantId, slug: "root-slug" })
    await runBatchIngestCore(makeServices(db, p), {
      documentId: "doc-1",
      r2Key: "k",
      contentType: "text/markdown",
      partLimits: { maxChunks: 1 },
    })
    return { sqlite, db, scoped: new ScopedDB(db, p) }
  }

  const docIds = (sqlite: ReturnType<typeof makeDb>["sqlite"]): string[] =>
    (sqlite.query(`SELECT id FROM documents ORDER BY id`).all() as { id: string }[]).map(
      (d) => d.id,
    )

  test("softDeleteDocument cascades to child parts — nothing searchable after delete", async () => {
    const { sqlite, scoped } = await split3()
    const { chunkIds } = await scoped.softDeleteDocument("doc-1")
    expect(chunkIds).toHaveLength(3) // root + both children's chunks returned for vector cleanup
    // every documents row (root + children) is soft-deleted
    expect(sqlite.query(`SELECT id FROM documents WHERE deleted_at IS NULL`).all()).toHaveLength(0)
    // a child-part term AND the root term both stop surfacing (doc + chunk soft-deleted)
    expect(await ftsArm(scoped, "gammachild", 10)).toHaveLength(0)
    expect(await ftsArm(scoped, "alpharoot", 10)).toHaveLength(0)
  })

  test("hardDeleteDocumentChunks removes OLD child docs+chunks; supersede→fewer parts doesn't collide/orphan", async () => {
    const { sqlite, db, scoped } = await split3()
    const { chunkIds } = await scoped.hardDeleteDocumentChunks("doc-1")
    expect(chunkIds).toHaveLength(3)
    expect(docIds(sqlite)).toEqual(["doc-1"]) // child DOC rows gone; parent kept for in-place supersede

    // re-ingest as a SINGLE part (supersede to fewer parts) — no slug collision, no orphaned parts
    const re = await runBatchIngestCore(makeServices(db, p), {
      documentId: "doc-1",
      r2Key: "k",
      contentType: "text/markdown",
    })
    expect(re.partDocumentIds).toEqual([])
    expect(docIds(sqlite)).toEqual(["doc-1"])
    // the term that used to live in a child part now lives under the root and cites the root
    const hits = await ftsArm(scoped, "gammachild", 10)
    expect(hits.find((h) => h.content.includes("gammachild"))?.slug).toBe("root-slug")
    // the root's stale part_index/part_count are cleared on the unsplit re-ingest
    expect(
      sqlite.query(`SELECT part_index AS pi, part_count AS pc FROM documents`).get(),
    ).toMatchObject({ pi: null, pc: null })
  })

  test("list_documents hides child part rows (only the root shows)", async () => {
    const { db } = await split3()
    const { documents: listed } = await listDocumentsCore(db, p, {})
    expect(listed.map((d) => d.id)).toEqual(["doc-1"])
  })

  test("get_stats counts a split doc as ONE (child parts excluded)", async () => {
    const { db } = await split3()
    const admin = principal({
      tenantId: "t1",
      role: "owner",
      capabilities: ["read", "write", "admin"],
    })
    const stats = await getStatsCore(db, admin)
    expect(stats.documents).toBe(1) // 3 rows on disk (root + 2 parts) → counted as one document
  })

  test("child parts inherit origin='dream' → stay behind the D2 anti-loop filter", async () => {
    const { sqlite, db } = makeDb()
    // Seed the parent as a dream-origin insight, then force a 3-part split.
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, origin)
       VALUES ('doc-d', 't1', 'userA', 'insight-slug', 'indexed', 'fp-d', 'dream')`,
    )
    await runBatchIngestCore(makeServices(db, p), {
      documentId: "doc-d",
      r2Key: "k",
      contentType: "text/markdown",
      partLimits: { maxChunks: 1 },
    })
    // every part row (root + children) carries origin='dream' → notDreamOrigin() excludes them all
    const origins = (
      sqlite.query(`SELECT origin FROM documents`).all() as { origin: string | null }[]
    ).map((r) => r.origin)
    expect(origins).toHaveLength(3)
    expect(origins.every((o) => o === "dream")).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import type { InsertChunkInput, InsertDocumentInput } from "../src/scoped/db"
import { ScopedDB } from "../src/scoped/db"
import { insertChunk, insertDoc, makeDb, principal, withBatch } from "./helpers"

/**
 * The WRITE PATH (invariants 1, 10, 11). Every mutating method MUST:
 *   - force `tenant_id = p.tenantId` even when the caller smuggles a foreign tenant_id,
 *   - write its `memory_audit` row in the SAME batch as its change (all-or-nothing),
 *   - batch chunk inserts at CHUNK_DB_BATCH_SIZE under the per-statement param cap.
 * These run against a REAL bun:sqlite DB; `withBatch` maps `commitBatch` onto a synchronous
 * transaction with the SAME all-or-nothing semantics as D1's `db.batch`.
 */

const rowCount = (sqlite: ReturnType<typeof makeDb>["sqlite"], sql: string): number =>
  (sqlite.query(sql).get() as { n: number }).n

describe("tenant_id forcing (invariant 1) — caller cannot inject a foreign tenant_id", () => {
  test("insertDocument stores the principal's tenant_id, NOT a smuggled payload tenant_id", async () => {
    const { sqlite, db } = makeDb()
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))

    // The input type OMITS tenantId; cast a rogue object in to prove the runtime override.
    const rogue = { slug: "doc-1", fingerprint: "fp-1", tenantId: "evil-tenant" }
    const id = await sdb.insertDocument(rogue as InsertDocumentInput)

    const row = sqlite.query("SELECT tenant_id, user_id FROM documents WHERE id = ?").get(id) as {
      tenant_id: string
      user_id: string
    }
    expect(row.tenant_id).toBe("t1") // forced to the principal's tenant, not "evil-tenant"
    expect(row.user_id).toBe("userA") // authorship forced too
  })

  test("insertChunks stores the principal's tenant_id for every row", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    const rogue = [
      { id: "c1", documentId: "d1", chunkIndex: 0, content: "a", tenantId: "evil" },
      { id: "c2", documentId: "d1", chunkIndex: 1, content: "b", tenantId: "evil" },
    ]
    await sdb.insertChunks(rogue as InsertChunkInput[])

    expect(rowCount(sqlite, "SELECT count(*) AS n FROM chunks WHERE tenant_id = 't1'")).toBe(2)
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM chunks WHERE tenant_id = 'evil'")).toBe(0)
  })
})

describe("audit-in-same-batch (invariant 10)", () => {
  test("on SUCCESS, both the change and its memory_audit row are present", async () => {
    const { sqlite, db } = makeDb()
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))

    const id = await sdb.insertDocument({ slug: "doc-1", fingerprint: "fp-1" })

    expect(rowCount(sqlite, `SELECT count(*) AS n FROM documents WHERE id = '${id}'`)).toBe(1)
    const audit = sqlite
      .query("SELECT tenant_id, user_id, action, target_id FROM memory_audit WHERE target_id = ?")
      .get(id) as { tenant_id: string; user_id: string; action: string; target_id: string }
    expect(audit.action).toBe("document.insert")
    expect(audit.tenant_id).toBe("t1") // audit tenant forced
    expect(audit.user_id).toBe("userA") // audit actor forced
  })

  test("on FAILURE inside the batch, NEITHER the change NOR the audit row lands", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    // Pre-seed a chunk so a second insert with the SAME primary key fails at the DB layer.
    insertChunk(sqlite, { id: "dup", tenantId: "t1", documentId: "d1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    // One fresh chunk + one duplicate-PK chunk in the SAME insertChunks call (one batch).
    await expect(
      sdb.insertChunks([
        { id: "fresh", documentId: "d1", chunkIndex: 1, content: "x" },
        { id: "dup", documentId: "d1", chunkIndex: 2, content: "y" }, // duplicate PK → throws
      ]),
    ).rejects.toThrow()

    // All-or-nothing: the fresh chunk rolled back AND no audit row was written.
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM chunks WHERE id = 'fresh'")).toBe(0)
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_audit WHERE action = 'chunk.insert'"),
    ).toBe(0)
  })
})

describe("insertChunks batching (invariant 11) — 25 chunks → 3 batches, FTS shadow synced", () => {
  test("all 25 chunks stored, chunks_fts populated by the trigger, 3 audit rows", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    const rows: InsertChunkInput[] = Array.from({ length: 25 }, (_unused, i) => ({
      id: `chunk-${i}`,
      documentId: "d1",
      chunkIndex: i,
      content: `chunk ${i} has the needle term`,
    }))
    const ids = await sdb.insertChunks(rows)

    expect(ids).toHaveLength(25)
    expect(rowCount(sqlite, "SELECT count(*) AS n FROM chunks WHERE tenant_id = 't1'")).toBe(25)
    // FTS5 external-content shadow is populated automatically by the chunks_ai trigger.
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'needle'"),
    ).toBe(25)
    // CHUNK_DB_BATCH_SIZE=10 → 10 + 10 + 5 → exactly 3 batches → 3 audit rows.
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_audit WHERE action = 'chunk.insert'"),
    ).toBe(3)
  })
})

describe("updateChunkEmbedding (invariant 1) — tenant-scoped WHERE, audited", () => {
  test("marks the embedding columns and never touches another tenant's chunk", async () => {
    const { sqlite, db } = makeDb()
    insertDoc(sqlite, { id: "d1", tenantId: "t1", slug: "doc-1" })
    insertDoc(sqlite, { id: "d2", tenantId: "t2", slug: "doc-2" })
    insertChunk(sqlite, { id: "mine", tenantId: "t1", documentId: "d1" })
    insertChunk(sqlite, { id: "theirs", tenantId: "t2", documentId: "d2" })
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.updateChunkEmbedding("mine", {
      embeddingModel: "@cf/baai/bge-m3",
      embeddedAt: "2026-06-25T01:00:00.000Z",
    })
    // A cross-tenant id is a no-op (tenant_id-scoped WHERE) — no throw, no change.
    await sdb.updateChunkEmbedding("theirs", {
      embeddingModel: "@cf/baai/bge-m3",
      embeddedAt: "2026-06-25T01:00:00.000Z",
    })

    const mine = sqlite.query("SELECT embedded_at FROM chunks WHERE id = 'mine'").get() as {
      embedded_at: string | null
    }
    const theirs = sqlite.query("SELECT embedded_at FROM chunks WHERE id = 'theirs'").get() as {
      embedded_at: string | null
    }
    expect(mine.embedded_at).toBe("2026-06-25T01:00:00.000Z")
    expect(theirs.embedded_at).toBeNull() // untouched: scoped out by tenant_id
  })
})

describe("upsertMemoryPolicy (invariant 6) — tenant-forced atomic replace", () => {
  test("replaces a prior policy, forces tenant_id, scopes the DELETE by tenant", async () => {
    const { sqlite, db } = makeDb()
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.upsertMemoryPolicy("target-1", { trustGrade: "draft", scopes: ["clientA"] })
    await sdb.upsertMemoryPolicy("target-1", { trustGrade: "instruction", scopes: [] })

    // Clean replace: exactly one row, the latest value.
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_use_policy WHERE target_id = 'target-1'"),
    ).toBe(1)
    const row = sqlite
      .query("SELECT tenant_id, trust_grade FROM memory_use_policy WHERE target_id = 'target-1'")
      .get() as { tenant_id: string; trust_grade: string }
    expect(row.tenant_id).toBe("t1")
    expect(row.trust_grade).toBe("instruction")
  })

  test("the upsert DELETE is tenant-scoped — it never clears another tenant's policy", async () => {
    const { sqlite, db } = makeDb()
    // A policy for the SAME target_id but owned by a DIFFERENT tenant.
    sqlite.run(
      "INSERT INTO memory_use_policy (id, tenant_id, target_id, trust_grade, scopes) VALUES ('p-t2', 't2', 'shared-target', 'evidence', '[]')",
    )
    const sdb = new ScopedDB(withBatch(db), principal({ tenantId: "t1" }))

    await sdb.upsertMemoryPolicy("shared-target", { trustGrade: "draft", scopes: [] })

    // t2's policy survives (the DELETE carries tenant_id = t1), and t1 got its own row.
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_use_policy WHERE tenant_id = 't2'"),
    ).toBe(1)
    expect(
      rowCount(sqlite, "SELECT count(*) AS n FROM memory_use_policy WHERE tenant_id = 't1'"),
    ).toBe(1)
  })
})

describe("appendRecallTrace (invariant 10) — append-only, tenant-forced, readOnly-exempt", () => {
  test("forces tenant_id + recall author; a read-only principal can still emit traces", async () => {
    const { sqlite, db } = makeDb()
    const readonly = new ScopedDB(
      withBatch(db),
      principal({ tenantId: "t1", userId: "userA", role: "readonly", readOnly: true }),
    )

    // A read-only principal is BLOCKED from a mutating write...
    await expect(readonly.insertDocument({ slug: "x", fingerprint: "fp-x" })).rejects.toThrow()

    // ...but recall traces (the read path's audit-grade record) still write.
    await readonly.appendRecallTraces([
      { query: "q", targetId: "chunk-1", score: 0.9, clientId: "claude-code" },
      { query: "q", targetId: "chunk-2", score: 0.8, clientId: "claude-code" },
    ])

    const rows = sqlite
      .query("SELECT tenant_id, user_id FROM memory_recall_traces")
      .all() as Array<{ tenant_id: string; user_id: string }>
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.tenant_id === "t1" && r.user_id === "userA")).toBe(true)
  })
})

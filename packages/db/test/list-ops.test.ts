import { describe, expect, test } from "bun:test"
import {
  getStatsCore,
  listAuditCore,
  listBackfillRunsCore,
  listDocumentsCore,
  listSessionsCore,
} from "../src/admin/ops"
import { AuthError } from "../src/auth/errors"
import { makeDb, principal } from "./helpers"

/**
 * Read-only list/stats ops (PRD §7.1 dashboard extensions).
 *
 * Each test seeds TWO tenants to prove tenant isolation (invariant 1), verifies limit is
 * respected, and verifies field shapes match the op contract exactly.
 */

const adminP = (tenantId: string) =>
  principal({ tenantId, role: "owner", capabilities: ["read", "write", "admin"] })

const readP = (tenantId: string) => principal({ tenantId, role: "member", capabilities: ["read"] })

// ── list_documents ────────────────────────────────────────────────────────────

describe("list_documents", () => {
  test("returns only the caller's tenant docs, newest first", async () => {
    const { sqlite, db } = makeDb()

    const insert = (id: string, tenantId: string, createdAt: string) =>
      sqlite.run(
        `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, created_at)
         VALUES (?, ?, 'userA', ?, 'indexed', ?, ?)`,
        [id, tenantId, `slug-${id}`, `fp-${id}`, createdAt],
      )

    insert("d1", "t1", "2026-06-25T10:00:00.000Z")
    insert("d2", "t1", "2026-06-25T11:00:00.000Z") // newer
    insert("d3", "t2", "2026-06-25T12:00:00.000Z") // other tenant — must NOT appear

    const out = await listDocumentsCore(db, adminP("t1"), {})
    expect(out.documents.map((d) => d.id)).toEqual(["d2", "d1"]) // newest first
    expect(out.documents.every((d) => typeof d.slug === "string")).toBe(true)
    expect(out.documents.every((d) => typeof d.status === "string")).toBe(true)
    expect(out.documents.every((d) => typeof d.chunkCount === "number")).toBe(true)
    // Provenance: userId (the ingestor) must be recorded on every document row.
    expect(out.documents.every((d) => typeof d.userId === "string")).toBe(true)
    expect(out.documents.every((d) => d.userId === "userA")).toBe(true)
  })

  test("respects limit", async () => {
    const { sqlite, db } = makeDb()

    for (let i = 0; i < 5; i++) {
      sqlite.run(
        `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint)
         VALUES (?, 't1', 'userA', ?, 'indexed', ?)`,
        [`doc${i}`, `slug${i}`, `fp${i}`],
      )
    }

    const out = await listDocumentsCore(db, adminP("t1"), { limit: 2 })
    expect(out.documents.length).toBe(2)
  })

  test("read-level principal can access (list_documents is read-gated, not admin-gated)", async () => {
    const { db } = makeDb()
    const out = await listDocumentsCore(db, readP("t1"), {})
    expect(out.documents).toEqual([])
  })

  test("output includes tags (parsed from JSON) and path", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, tags, path, created_at)
       VALUES ('d1', 't1', 'userA', 'slug-d1', 'indexed', 'fp-d1', '["alpha","beta"]', '/project/x', '2026-06-25T10:00:00.000Z')`,
    )
    const out = await listDocumentsCore(db, adminP("t1"), {})
    expect(out.documents[0]?.tags).toEqual(["alpha", "beta"])
    expect(out.documents[0]?.path).toBe("/project/x")
  })

  test("tag filter: returns only docs containing the tag", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, tags)
       VALUES ('d1', 't1', 'userA', 'slug-d1', 'indexed', 'fp-d1', '["alpha","beta"]')`,
    )
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, tags)
       VALUES ('d2', 't1', 'userA', 'slug-d2', 'indexed', 'fp-d2', '["gamma"]')`,
    )

    const out = await listDocumentsCore(db, adminP("t1"), { tag: "alpha" })
    expect(out.documents.map((d) => d.id)).toEqual(["d1"])
    expect(out.documents.every((d) => d.tags.includes("alpha"))).toBe(true)

    // partial substring "alph" must NOT match (exact element, not LIKE)
    const miss = await listDocumentsCore(db, adminP("t1"), { tag: "alph" })
    expect(miss.documents).toEqual([])
  })

  test("path filter: matches exact path and children, but not sibling prefixes", async () => {
    const { sqlite, db } = makeDb()
    const rows = [
      { id: "d1", slug: "s1", fp: "f1", path: "/project" }, // exact match
      { id: "d2", slug: "s2", fp: "f2", path: "/project/x" }, // child
      { id: "d3", slug: "s3", fp: "f3", path: "/projectfoo" }, // sibling — must NOT match
      { id: "d4", slug: "s4", fp: "f4", path: "/other" }, // unrelated — must NOT match
    ]
    for (const r of rows) {
      sqlite.run(
        `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, path)
         VALUES (?, 't1', 'userA', ?, 'indexed', ?, ?)`,
        [r.id, r.slug, r.fp, r.path],
      )
    }

    const out = await listDocumentsCore(db, adminP("t1"), { path: "/project" })
    const ids = out.documents.map((d) => d.id).sort()
    expect(ids).toEqual(["d1", "d2"])
  })

  test("date range filter: since + until narrow by created_at", async () => {
    const { sqlite, db } = makeDb()
    const rows = [
      { id: "d1", slug: "s1", fp: "f1", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "d2", slug: "s2", fp: "f2", createdAt: "2026-06-15T00:00:00.000Z" },
      { id: "d3", slug: "s3", fp: "f3", createdAt: "2026-06-30T00:00:00.000Z" },
    ]
    for (const r of rows) {
      sqlite.run(
        `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, created_at)
         VALUES (?, 't1', 'userA', ?, 'indexed', ?, ?)`,
        [r.id, r.slug, r.fp, r.createdAt],
      )
    }

    // since only
    const sinceOut = await listDocumentsCore(db, adminP("t1"), {
      since: "2026-06-10T00:00:00.000Z",
    })
    expect(sinceOut.documents.map((d) => d.id).sort()).toEqual(["d2", "d3"])

    // until only
    const untilOut = await listDocumentsCore(db, adminP("t1"), {
      until: "2026-06-20T00:00:00.000Z",
    })
    expect(untilOut.documents.map((d) => d.id).sort()).toEqual(["d1", "d2"])

    // since + until together
    const rangeOut = await listDocumentsCore(db, adminP("t1"), {
      since: "2026-06-10T00:00:00.000Z",
      until: "2026-06-20T00:00:00.000Z",
    })
    expect(rangeOut.documents.map((d) => d.id)).toEqual(["d2"])
  })
})

// ── list_sessions ─────────────────────────────────────────────────────────────

describe("list_sessions", () => {
  test("returns only the caller's tenant sessions, newest-activity first", async () => {
    const { sqlite, db } = makeDb()

    const insert = (id: string, tenantId: string, lastActivityAt: string) =>
      sqlite.run(
        `INSERT INTO sessions (id, tenant_id, user_id, client, status, started_at, last_activity_at)
         VALUES (?, ?, 'userA', 'cli', 'open', '2026-06-25T00:00:00.000Z', ?)`,
        [id, tenantId, lastActivityAt],
      )

    insert("s1", "t1", "2026-06-25T09:00:00.000Z")
    insert("s2", "t1", "2026-06-25T10:00:00.000Z") // more recent
    insert("s3", "t2", "2026-06-25T11:00:00.000Z") // other tenant — must NOT appear

    const out = await listSessionsCore(db, adminP("t1"), {})
    expect(out.sessions.map((s) => s.id)).toEqual(["s2", "s1"]) // newest-activity first
    expect(out.sessions.every((s) => typeof s.client === "string")).toBe(true)
    expect(out.sessions.every((s) => typeof s.turnCount === "number")).toBe(true)
    expect(out.sessions.every((s) => typeof s.lastActivityAt === "string")).toBe(true)
    // Provenance: userId (the session owner) must be recorded on every session row.
    expect(out.sessions.every((s) => typeof s.userId === "string")).toBe(true)
    expect(out.sessions.every((s) => s.userId === "userA")).toBe(true)
  })

  test("respects limit", async () => {
    const { sqlite, db } = makeDb()

    for (let i = 0; i < 4; i++) {
      sqlite.run(
        `INSERT INTO sessions (id, tenant_id, user_id, client, status, started_at, last_activity_at)
         VALUES (?, 't1', 'userA', 'cli', 'open', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
        [`sess${i}`],
      )
    }

    const out = await listSessionsCore(db, adminP("t1"), { limit: 2 })
    expect(out.sessions.length).toBe(2)
  })

  test("non-admin caller is denied (403)", async () => {
    const { db } = makeDb()
    const err = await listSessionsCore(db, readP("t1"), {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })
})

// ── list_backfill_runs ────────────────────────────────────────────────────────

describe("list_backfill_runs", () => {
  test("returns only the caller's tenant runs, newest first", async () => {
    const { sqlite, db } = makeDb()

    const insert = (id: string, tenantId: string, createdAt: string) =>
      sqlite.run(
        `INSERT INTO backfill_runs (id, tenant_id, source_id, kind, created_at, updated_at)
         VALUES (?, ?, 'src1', 'repo', ?, ?)`,
        [id, tenantId, createdAt, createdAt],
      )

    insert("r1", "t1", "2026-06-25T08:00:00.000Z")
    insert("r2", "t1", "2026-06-25T09:00:00.000Z") // newer
    insert("r3", "t2", "2026-06-25T10:00:00.000Z") // other tenant — must NOT appear

    const out = await listBackfillRunsCore(db, adminP("t1"), {})
    expect(out.runs.map((r) => r.id)).toEqual(["r2", "r1"]) // newest first
    expect(out.runs.every((r) => typeof r.sourceId === "string")).toBe(true)
    expect(out.runs.every((r) => typeof r.attempts === "number")).toBe(true)
  })

  test("respects limit", async () => {
    const { sqlite, db } = makeDb()

    for (let i = 0; i < 5; i++) {
      sqlite.run(
        `INSERT INTO backfill_runs (id, tenant_id, source_id, kind, created_at, updated_at)
         VALUES (?, 't1', 'src1', 'repo', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
        [`run${i}`],
      )
    }

    const out = await listBackfillRunsCore(db, adminP("t1"), { limit: 3 })
    expect(out.runs.length).toBe(3)
  })
})

// ── list_audit ────────────────────────────────────────────────────────────────

describe("list_audit", () => {
  test("returns only the caller's tenant audit entries, newest first", async () => {
    const { sqlite, db } = makeDb()

    const insert = (id: string, tenantId: string, at: number) =>
      sqlite.run(
        `INSERT INTO memory_audit (id, tenant_id, user_id, action, at)
         VALUES (?, ?, 'userA', 'fact.create', ?)`,
        [id, tenantId, at],
      )

    insert("a1", "t1", 1000)
    insert("a2", "t1", 2000) // newer
    insert("a3", "t2", 3000) // other tenant — must NOT appear

    const out = await listAuditCore(db, adminP("t1"), {})
    expect(out.entries.map((e) => e.id)).toEqual(["a2", "a1"]) // newest first (at DESC)
    expect(out.entries.every((e) => typeof e.userId === "string")).toBe(true)
    expect(out.entries.every((e) => typeof e.action === "string")).toBe(true)
    expect(out.entries.every((e) => typeof e.at === "number")).toBe(true)
  })

  test("respects limit", async () => {
    const { sqlite, db } = makeDb()

    for (let i = 0; i < 5; i++) {
      sqlite.run(
        `INSERT INTO memory_audit (id, tenant_id, user_id, action, at) VALUES (?, 't1', 'userA', 'fact.create', ?)`,
        [`ae${i}`, i * 1000],
      )
    }

    const out = await listAuditCore(db, adminP("t1"), { limit: 2 })
    expect(out.entries.length).toBe(2)
  })

  test("non-admin caller is denied (403)", async () => {
    const { db } = makeDb()
    const err = await listAuditCore(db, readP("t1"), {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })
})

// ── get_stats ─────────────────────────────────────────────────────────────────

describe("get_stats", () => {
  test("counts only the caller's tenant rows and includes ceiling", async () => {
    const { sqlite, db } = makeDb()

    // Tenant t1 rows
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint) VALUES ('d1', 't1', 'u', 'sl1', 'indexed', 'f1')`,
    )
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint) VALUES ('d2', 't1', 'u', 'sl2', 'indexed', 'f2')`,
    )
    // t2 document — must NOT be counted
    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint) VALUES ('d3', 't2', 'u', 'sl3', 'indexed', 'f3')`,
    )

    sqlite.run(
      `INSERT INTO sessions (id, tenant_id, user_id, client, status, started_at, last_activity_at)
       VALUES ('s1', 't1', 'u', 'cli', 'open', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    )
    sqlite.run(
      `INSERT INTO sessions (id, tenant_id, user_id, client, status, started_at, last_activity_at)
       VALUES ('s2', 't2', 'u', 'cli', 'open', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    )

    const out = await getStatsCore(db, adminP("t1"))
    expect(out.documents).toBe(2)
    expect(out.sessions).toBe(1)
    expect(typeof out.chunks).toBe("number")
    expect(typeof out.entities).toBe("number")
    expect(typeof out.facts).toBe("number")
    expect(typeof out.tokenSpendNeurons).toBe("number")
    expect(typeof out.monthlyCeilingUsd).toBe("number")
    expect(out.monthlyCeilingUsd).toBeGreaterThan(0)
  })

  test("chunks count excludes soft-deleted; facts count excludes expired", async () => {
    const { sqlite, db } = makeDb()

    sqlite.run(
      `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint) VALUES ('d1', 't1', 'u', 'sl1', 'indexed', 'fp1')`,
    )
    // 2 live chunks, 1 soft-deleted
    sqlite.run(
      `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content, embedding_model, embedding_dims, updated_at)
       VALUES ('c1', 't1', 'd1', 'world', 0, 'txt', '@cf/baai/bge-m3', 1024, '2026-06-01T00:00:00.000Z')`,
    )
    sqlite.run(
      `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content, embedding_model, embedding_dims, updated_at)
       VALUES ('c2', 't1', 'd1', 'world', 1, 'txt', '@cf/baai/bge-m3', 1024, '2026-06-01T00:00:00.000Z')`,
    )
    sqlite.run(
      `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content, embedding_model, embedding_dims, updated_at, deleted_at)
       VALUES ('c3', 't1', 'd1', 'world', 2, 'txt', '@cf/baai/bge-m3', 1024, '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z')`,
    )
    // 1 live fact, 1 expired
    sqlite.run(
      `INSERT INTO facts (tenant_id, scope, user_id, visibility, fact, source) VALUES ('t1', null, 'u', 'world', 'live fact', 'mcp:extract_facts')`,
    )
    sqlite.run(
      `INSERT INTO facts (tenant_id, scope, user_id, visibility, fact, source, expired_at) VALUES ('t1', null, 'u', 'world', 'expired', 'mcp:extract_facts', '2026-06-01T00:00:00.000Z')`,
    )

    const out = await getStatsCore(db, adminP("t1"))
    expect(out.chunks).toBe(2) // not 3
    expect(out.facts).toBe(1) // not 2
  })

  test("non-admin caller is denied (403)", async () => {
    const { db } = makeDb()
    const member = principal({ tenantId: "t1", role: "member", capabilities: ["read"] })
    const err = await getStatsCore(db, member).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })
})

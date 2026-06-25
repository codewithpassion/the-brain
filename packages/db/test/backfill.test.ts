import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { ReembedStore } from "../src/backfill/reembed"
import { BackfillRunStore } from "../src/backfill/runs"
import { isBackoffReady, SourceStore } from "../src/backfill/sources"
import { findOrg, principalFromMessageDb } from "../src/backfill/tenant"
import { makeDb, principal, withBatch } from "./helpers"

/**
 * Phase-3 backfill stores (PRD §8.6/§8.7) against a REAL bun:sqlite DB; `withBatch` maps
 * `commitBatch` to a synchronous all-or-nothing transaction (same semantics as D1 `db.batch`).
 *
 * Proves the load-bearing slice invariants:
 *   - `backfill_runs` lifecycle: create→claim(optimistic, race-safe)→progress→anchor→finish; tenant-scoped.
 *   -  source backoff: `sync_fail_count` widens the window; a clean pass RESETS it; archived never re-enqueues.
 *   -  re-embed candidate selection (stale/wrong-model/foreign-dim/never-embedded) is VISIBILITY-AGNOSTIC
 *     (invariant 12 coverage: a different-user PRIVATE chunk is still a candidate).
 *   -  `tenantFromMessage` fail-closed (invariant 18): unknown tenant ⇒ null; absent membership ⇒ null.
 */

const ORG_STAMP = "2026-06-25T00:00:00.000Z"

const insertOrg = (sqlite: Database, id: string, slug: string): void => {
  sqlite.run("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)", [id, id, slug])
}

const insertMembership = (
  sqlite: Database,
  opts: { tenantId: string; userId: string; role?: string },
): void => {
  sqlite.run(
    "INSERT INTO memberships (id, tenant_id, user_id, team_id, role, allowed_scopes) VALUES (?, ?, ?, NULL, ?, NULL)",
    [`mem-${opts.tenantId}-${opts.userId}`, opts.tenantId, opts.userId, opts.role ?? "member"],
  )
}

const insertSource = (
  sqlite: Database,
  opts: {
    id: string
    tenantId: string
    lastAttemptAt?: string | null
    syncFailCount?: number
    archived?: number
  },
): void => {
  sqlite.run(
    `INSERT INTO sources (id, tenant_id, name, kind, last_attempt_at, sync_fail_count, archived)
     VALUES (?, ?, ?, 'github', ?, ?, ?)`,
    [
      opts.id,
      opts.tenantId,
      opts.id,
      opts.lastAttemptAt ?? null,
      opts.syncFailCount ?? 0,
      opts.archived ?? 0,
    ],
  )
}

/** A `chunks` row with FULL control over the embedding-staleness columns. */
const insertChunkRaw = (
  sqlite: Database,
  opts: {
    id: string
    tenantId: string
    documentId: string
    userId?: string | null
    visibility?: string
    embeddingModel?: string
    embeddingDims?: number
    embeddedAt?: string | null
    updatedAt?: string
    deletedAt?: string | null
    content?: string
  },
): void => {
  sqlite.run(
    `INSERT INTO chunks
       (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
        content, embedded_at, embedding_model, embedding_dims, updated_at, deleted_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.tenantId,
      opts.documentId,
      opts.userId ?? null,
      opts.visibility ?? "world",
      opts.content ?? "candidate content",
      opts.embeddedAt ?? null,
      opts.embeddingModel ?? "@cf/baai/bge-m3",
      opts.embeddingDims ?? 1024,
      opts.updatedAt ?? ORG_STAMP,
      opts.deletedAt ?? null,
    ],
  )
}

describe("BackfillRunStore — lifecycle + optimistic claim (PRD §8.1/§8.6)", () => {
  test("create → claim(race-safe) → progress → anchor → addStats → finish", async () => {
    const { db } = makeDb()
    const store = new BackfillRunStore(withBatch(db), principal({ tenantId: "t1" }))

    await store.createRun({ id: "run-1", sourceId: "src-1", kind: "session" })
    const queued = await store.get("run-1")
    expect(queued?.status).toBe("queued")
    expect(queued?.stats.processed).toBe(0)

    // First claim wins; a second claim from `queued` finds a non-matching status → loses (no double-drive).
    expect(await store.claim("run-1")).toBe(true)
    expect(await store.claim("run-1")).toBe(false)
    expect((await store.get("run-1"))?.attempts).toBe(1)

    await store.persistProgress("run-1", "cursor-42", {
      processed: 5,
      created: 4,
      skipped: 1,
      errors: 0,
      merged: 1,
      neurons: 0,
    })
    expect((await store.get("run-1"))?.cursor).toBe("cursor-42")

    // Anchor advances only here (the clean-pass call); progress never touched it.
    await store.advanceAnchor("run-1", "commit-abc")
    expect((await store.get("run-1"))?.anchor).toBe("commit-abc")

    await store.addStats("run-1", { neurons: 12.5, processed: 2 })
    const afterStats = await store.get("run-1")
    expect(afterStats?.stats.neurons).toBe(12.5)
    expect(afterStats?.stats.processed).toBe(7)

    await store.finishRun("run-1", "success")
    expect((await store.get("run-1"))?.status).toBe("success")
  })

  test("a run is tenant-scoped — another tenant cannot see/claim it", async () => {
    const { db } = makeDb()
    const t1 = new BackfillRunStore(withBatch(db), principal({ tenantId: "t1" }))
    const t2 = new BackfillRunStore(withBatch(db), principal({ tenantId: "t2" }))
    await t1.createRun({ id: "run-x", sourceId: "src", kind: "doc" })
    expect(await t2.get("run-x")).toBeNull()
    expect(await t2.claim("run-x")).toBe(false)
    expect((await t1.get("run-x"))?.status).toBe("queued") // t2's failed claim never ran it
  })
})

describe("SourceStore — exponential backoff + anchor discipline (PRD §8.1)", () => {
  test("isBackoffReady widens with sync_fail_count and excludes archived", () => {
    const now = new Date("2026-06-25T01:00:00.000Z")
    // 0 fails, attempted 2 min ago, base 1 min → window 1 min → ready.
    expect(
      isBackoffReady(
        { lastAttemptAt: "2026-06-25T00:58:00.000Z", syncFailCount: 0, archived: 0 },
        now,
      ),
    ).toBe(true)
    // 3 fails → window 8 min; attempted 2 min ago → NOT ready.
    expect(
      isBackoffReady(
        { lastAttemptAt: "2026-06-25T00:58:00.000Z", syncFailCount: 3, archived: 0 },
        now,
      ),
    ).toBe(false)
    // never attempted → ready; archived → never.
    expect(isBackoffReady({ lastAttemptAt: null, syncFailCount: 9, archived: 0 }, now)).toBe(true)
    expect(isBackoffReady({ lastAttemptAt: null, syncFailCount: 0, archived: 1 }, now)).toBe(false)
  })

  test("recordFailure bumps the count; recordSuccess resets it + advances the anchor", async () => {
    const { sqlite, db } = makeDb()
    insertSource(sqlite, { id: "src-1", tenantId: "t1", syncFailCount: 0 })
    const store = new SourceStore(withBatch(db), principal({ tenantId: "t1" }))

    await store.recordFailure("src-1")
    await store.recordFailure("src-1")
    expect((await store.get("src-1"))?.syncFailCount).toBe(2)

    await store.recordSuccess("src-1", { lastCommit: "deadbeef" })
    const ok = await store.get("src-1")
    expect(ok?.syncFailCount).toBe(0) // reset on clean pass
    expect(ok?.lastCommit).toBe("deadbeef") // anchor advanced
  })

  test("listReenqueuable returns only non-archived sources past their backoff window", async () => {
    const { sqlite, db } = makeDb()
    const now = new Date("2026-06-25T01:00:00.000Z")
    insertSource(sqlite, {
      id: "ready",
      tenantId: "t1",
      lastAttemptAt: "2026-06-25T00:50:00.000Z",
      syncFailCount: 0,
    })
    insertSource(sqlite, {
      id: "cooling",
      tenantId: "t1",
      lastAttemptAt: "2026-06-25T00:59:00.000Z",
      syncFailCount: 5,
    })
    insertSource(sqlite, { id: "dead", tenantId: "t1", lastAttemptAt: null, archived: 1 })
    const store = new SourceStore(withBatch(db), principal({ tenantId: "t1" }))
    const ids = (await store.listReenqueuable(now)).map((s) => s.id)
    expect(ids).toContain("ready")
    expect(ids).not.toContain("cooling")
    expect(ids).not.toContain("dead")
  })
})

describe("ReembedStore — stale candidate selection is visibility-agnostic (invariant 12)", () => {
  test("selects stale/wrong-model/foreign-dim/never-embedded; skips a fresh chunk", async () => {
    const { sqlite, db } = makeDb()
    // FRESH: same model, 1024d, embedded after its last update → NOT a candidate.
    insertChunkRaw(sqlite, {
      id: "fresh",
      tenantId: "t1",
      documentId: "d1",
      embeddedAt: "2026-06-25T02:00:00.000Z",
      updatedAt: "2026-06-25T01:00:00.000Z",
    })
    // pending model (importer drop), foreign dim, never embedded, stale (updated>embedded).
    insertChunkRaw(sqlite, {
      id: "pending",
      tenantId: "t1",
      documentId: "d1",
      embeddingModel: "pending",
      embeddingDims: 0,
      embeddedAt: null,
    })
    insertChunkRaw(sqlite, {
      id: "foreign",
      tenantId: "t1",
      documentId: "d1",
      embeddingDims: 1536,
      embeddedAt: "2026-06-25T02:00:00.000Z",
    })
    insertChunkRaw(sqlite, { id: "never", tenantId: "t1", documentId: "d1", embeddedAt: null })
    insertChunkRaw(sqlite, {
      id: "stale",
      tenantId: "t1",
      documentId: "d1",
      embeddedAt: "2026-06-25T01:00:00.000Z",
      updatedAt: "2026-06-25T03:00:00.000Z",
    })

    const store = new ReembedStore(withBatch(db), principal({ tenantId: "t1" }))
    const ids = (await store.findCandidates()).map((c) => c.id).sort()
    expect(ids).toEqual(["foreign", "never", "pending", "stale"])
    expect(await store.getCandidate("fresh")).toBeNull() // not stale → re-delivery no-op
  })

  test("a different-user PRIVATE chunk is still a candidate (no visibility drop)", async () => {
    const { sqlite, db } = makeDb()
    // Candidate owned by userB, private — the system principal (userA) must STILL re-embed it.
    insertChunkRaw(sqlite, {
      id: "priv",
      tenantId: "t1",
      documentId: "d1",
      userId: "userB",
      visibility: "private",
      embeddingModel: "pending",
      embeddingDims: 0,
      embeddedAt: null,
    })
    const store = new ReembedStore(withBatch(db), principal({ tenantId: "t1", userId: "userA" }))
    const cand = await store.getCandidate("priv")
    expect(cand?.id).toBe("priv")
    expect(cand?.visibility).toBe("private")
  })

  test("markReembedded re-stamps model+dims → the chunk stops being a candidate (idempotency)", async () => {
    const { sqlite, db } = makeDb()
    // Foreign-dim, pending-model, never-embedded → a candidate on all three terms.
    insertChunkRaw(sqlite, {
      id: "c1",
      tenantId: "t1",
      documentId: "d1",
      embeddingModel: "pending",
      embeddingDims: 1536,
      embeddedAt: null,
    })
    const store = new ReembedStore(withBatch(db), principal({ tenantId: "t1" }))
    expect(await store.getCandidate("c1")).not.toBeNull()
    await store.markReembedded("c1", "2026-06-25T05:00:00.000Z")
    // Now bge-m3 / 1024d / embedded — no longer stale, so a re-delivered message is a no-op.
    expect(await store.getCandidate("c1")).toBeNull()
  })

  test("a soft-deleted chunk is never a candidate; tenant is forced", async () => {
    const { sqlite, db } = makeDb()
    insertChunkRaw(sqlite, {
      id: "del",
      tenantId: "t1",
      documentId: "d1",
      embeddedAt: null,
      deletedAt: "2026-06-25T00:00:00.000Z",
    })
    insertChunkRaw(sqlite, { id: "other", tenantId: "t2", documentId: "d1", embeddedAt: null })
    const store = new ReembedStore(withBatch(db), principal({ tenantId: "t1" }))
    expect(await store.findCandidates()).toHaveLength(0) // del is soft-deleted, other is t2
  })
})

describe("tenant validation — fail-closed (invariant 18)", () => {
  test("findOrg returns the org when present, null when absent", async () => {
    const { sqlite, db } = makeDb()
    insertOrg(sqlite, "org-real", "real")
    expect(await findOrg(db, "org-real")).toEqual({ id: "org-real" })
    expect(await findOrg(db, "org-ghost")).toBeNull()
    expect(await findOrg(db, "")).toBeNull()
    expect(await findOrg(db, undefined)).toBeNull()
  })

  test("principalFromMessageDb: unknown tenant ⇒ null; system principal for a real tenant", async () => {
    const { sqlite, db } = makeDb()
    insertOrg(sqlite, "org-real", "real")
    expect(await principalFromMessageDb(db, { tenantId: "org-ghost" })).toBeNull()
    const sys = await principalFromMessageDb(db, { tenantId: "org-real" })
    expect(sys?.tenantId).toBe("org-real")
    expect(sys?.userId).toBe("system")
    expect(sys?.readOnly).toBe(false)
  })

  test("principalFromMessageDb with userId: real membership resolves; a non-member ⇒ null", async () => {
    const { sqlite, db } = makeDb()
    insertOrg(sqlite, "org-real", "real")
    insertMembership(sqlite, { tenantId: "org-real", userId: "userA", role: "member" })
    const member = await principalFromMessageDb(db, { tenantId: "org-real", userId: "userA" })
    expect(member?.userId).toBe("userA")
    // A user with no membership in the tenant fails closed (a removed user can't be impersonated).
    expect(await principalFromMessageDb(db, { tenantId: "org-real", userId: "ghost" })).toBeNull()
  })
})

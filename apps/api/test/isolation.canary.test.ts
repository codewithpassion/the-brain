import { env } from "cloudflare:test"
import {
  type BrainBindings,
  type ClerkIdentity,
  type ClerkVerifier,
  createScopedServices,
  type InsertDocumentInput,
  resolvePrincipal,
  ScopedDB,
  ScopedVectorize,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { countRows, seedChunk, seedDoc, seedFact, seedMembership, seedOrg } from "./seed"

/**
 * THE Phase-1 isolation canary suite — the FIRST proof that the load-bearing security
 * properties hold against REAL local D1 running inside workerd (not bun:sqlite). The PRD
 * scored security lowest (71/100); this suite is the blocking merge precondition.
 *
 * Every canary is NON-VACUOUS: both sides of each boundary are seeded, and the leak path is
 * shown to actually surface the forbidden id BEFORE proving the chokepoint drops it. The
 * mandatory D1 re-check (invariant 3) drops cross-tenant / out-of-scope / out-of-visibility /
 * soft-deleted ids SILENTLY — by predicate, never by a missing-row JOIN failure.
 *
 * Each test owns a unique tenant/id namespace, so the suite is robust to pool-workers storage
 * isolation either way (no shared mutable fixtures beyond the two original beforeAll canaries).
 */

const env_ = env as unknown as BrainBindings

/** A `Principal` with sensible defaults; override per test. */
const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "t1",
  userId: "userA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read"],
  readOnly: false,
  ...overrides,
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 1 + 2 (KEEP): cross-tenant D1 read, and the vector arm re-check with an
// adversarial fake that actually emits the cross-tenant id.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_A = "chunk-A"
const CHUNK_B = "chunk-B"

const principalA: Principal = principal({ tenantId: "orgA", userId: "ownerA" })

/**
 * Adversarial fake Vectorize: returns BOTH chunk ids (including orgB's cross-tenant chunk)
 * for any query. If it did NOT emit the cross-tenant id the canary would be vacuous, so the
 * test asserts the emission explicitly before re-checking.
 */
const adversarialIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: CHUNK_A, score: 0.91 },
      { id: CHUNK_B, score: 0.88 },
    ],
  }),
} as unknown as Vectorize

beforeAll(async () => {
  await seedOrg("orgA", "orgA")
  await seedMembership({ tenantId: "orgA", userId: "ownerA" })
  await seedDoc({ id: "doc-A", tenantId: "orgA", slug: "needle-doc" })
  await seedChunk({
    id: CHUNK_A,
    tenantId: "orgA",
    documentId: "doc-A",
    userId: "ownerA",
    content: "the needle is here",
  })
  await seedOrg("orgB", "orgB")
  await seedMembership({ tenantId: "orgB", userId: "ownerB" })
  await seedDoc({ id: "doc-B", tenantId: "orgB", slug: "needle-doc" })
  await seedChunk({
    id: CHUNK_B,
    tenantId: "orgB",
    documentId: "doc-B",
    userId: "ownerB",
    content: "the needle is here",
  })
})

describe("isolation canary (invariant 3) — real local D1 in workerd", () => {
  test("D1 arm: getChunksByIds drops the cross-tenant id, returns only chunk A", async () => {
    const sdb = new ScopedDB(drizzle(env_.DB), principalA)
    const rows = await sdb.getChunksByIds([CHUNK_A, CHUNK_B])
    // drop-don't-error: orgB's chunk is simply absent, never thrown.
    expect(rows.map((row) => row.id)).toEqual([CHUNK_A])
    expect(rows[0]?.trustGrade).toBe("evidence")
  })

  test("vector arm: an adversarial fake leaks chunk B; the D1 re-check drops it", async () => {
    const sdb = new ScopedDB(drizzle(env_.DB), principalA)
    const vectors = new ScopedVectorize(adversarialIndex, principalA)

    const matches = await vectors.query({ values: new Array(1024).fill(0), topK: 10 })
    // Non-vacuous guard: the fake MUST have surfaced the cross-tenant id.
    expect(matches.map((match) => match.id).sort()).toEqual([CHUNK_A, CHUNK_B])

    const survivors = await sdb.getChunksByIds(matches.map((match) => match.id))
    expect(survivors.map((row) => row.id)).toEqual([CHUNK_A])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 3: FTS-arm leak (invariant 4). MATCH is pure text; the JOIN-back to the
// scoped base table is what isolates it. Chunks (rowid join) AND facts (id join).
// ─────────────────────────────────────────────────────────────────────────────

describe("FTS arm JOIN-back (invariant 4) — colliding needle across tenants", () => {
  test("ftsChunkIds returns ONLY tenant-A ids; a soft-deleted row never surfaces", async () => {
    await seedOrg("ftsA", "fts-a")
    await seedOrg("ftsB", "fts-b")
    await seedDoc({ id: "fts-da", tenantId: "ftsA", slug: "fts-doc-a" })
    await seedDoc({ id: "fts-db", tenantId: "ftsB", slug: "fts-doc-b" })
    // Same colliding MATCH term in two tenants.
    await seedChunk({
      id: "fts-a-hit",
      tenantId: "ftsA",
      documentId: "fts-da",
      content: "the kryptonite needle term",
    })
    await seedChunk({
      id: "fts-b-hit",
      tenantId: "ftsB",
      documentId: "fts-db",
      content: "the kryptonite needle term",
    })
    // A tenant-A row that is soft-deleted — must never surface even though it MATCHes.
    await seedChunk({
      id: "fts-a-deleted",
      tenantId: "ftsA",
      documentId: "fts-da",
      content: "the kryptonite needle term",
      deletedAt: "2026-06-25T00:00:00.000Z",
    })

    const sdb = new ScopedDB(drizzle(env_.DB), principal({ tenantId: "ftsA" }))
    const ids = await sdb.ftsChunkIds("kryptonite", 10)
    // Only the live tenant-A row: the cross-tenant and soft-deleted rows are JOIN-scoped out.
    expect(ids).toEqual(["fts-a-hit"])

    // And re-checking the cross-tenant id from a hostile arm still drops it.
    expect(await sdb.getChunksByIds(["fts-b-hit"])).toHaveLength(0)
  })

  test("ftsFactIds re-checks tenant + visibility on the base table (joined by id)", async () => {
    const fWorld = await seedFact({
      tenantId: "ftsfA",
      visibility: "world",
      fact: "shared selenium fact",
    })
    // cross-tenant collision
    await seedFact({ tenantId: "ftsfB", visibility: "world", fact: "shared selenium fact" })
    // someone else's private fact in the same tenant
    await seedFact({
      tenantId: "ftsfA",
      visibility: "private",
      userId: "userB",
      fact: "shared selenium fact",
    })
    // an expired/superseded tenant-A fact
    await seedFact({
      tenantId: "ftsfA",
      visibility: "world",
      fact: "shared selenium fact",
      expiredAt: "2026-06-25T00:00:00.000Z",
    })

    const sdb = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "ftsfA", userId: "userA", teamIds: [] }),
    )
    expect(await sdb.ftsFactIds("selenium", 10)).toEqual([fWorld])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 4: cross-scope (invariant 5). A restricted grant cannot read another scope
// in the SAME tenant; '*' sees both.
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-scope (invariant 5) — restricted grant vs '*'", () => {
  test("allowedScopes=['x'] cannot read scope 'y'; '*' reads both", async () => {
    await seedOrg("scopeT", "scope-t")
    await seedDoc({ id: "scope-d", tenantId: "scopeT", slug: "scope-doc" })
    await seedChunk({ id: "in-x", tenantId: "scopeT", documentId: "scope-d", scope: "x" })
    await seedChunk({ id: "in-y", tenantId: "scopeT", documentId: "scope-d", scope: "y" })

    const restricted = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "scopeT", allowedScopes: ["x"] }),
    )
    // Non-vacuous: the 'y' chunk exists and is same-tenant — only the scope gate drops it.
    expect((await restricted.getChunksByIds(["in-x", "in-y"])).map((r) => r.id)).toEqual(["in-x"])

    const wildcard = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "scopeT", allowedScopes: "*" }),
    )
    expect((await wildcard.getChunksByIds(["in-x", "in-y"])).map((r) => r.id).sort()).toEqual([
      "in-x",
      "in-y",
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 5: intra-tenant visibility (invariant 8). private→author, team→members,
// world→everyone in the tenant.
// ─────────────────────────────────────────────────────────────────────────────

describe("intra-tenant visibility (invariant 8)", () => {
  test("userA sees world + own-private + own-team; not userB-private nor other-team", async () => {
    await seedOrg("visT", "vis-t")
    await seedDoc({ id: "vis-d", tenantId: "visT", slug: "vis-doc" })
    await seedChunk({ id: "v-world", tenantId: "visT", documentId: "vis-d", visibility: "world" })
    await seedChunk({
      id: "v-priv-A",
      tenantId: "visT",
      documentId: "vis-d",
      visibility: "private",
      userId: "userA",
    })
    await seedChunk({
      id: "v-priv-B",
      tenantId: "visT",
      documentId: "vis-d",
      visibility: "private",
      userId: "userB",
    })
    await seedChunk({
      id: "v-team-X",
      tenantId: "visT",
      documentId: "vis-d",
      visibility: "team",
      teamId: "teamX",
    })
    await seedChunk({
      id: "v-team-Y",
      tenantId: "visT",
      documentId: "vis-d",
      visibility: "team",
      teamId: "teamY",
    })

    const all = ["v-world", "v-priv-A", "v-priv-B", "v-team-X", "v-team-Y"]
    const userA = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "visT", userId: "userA", teamIds: ["teamX"] }),
    )
    expect((await userA.getChunksByIds(all)).map((r) => r.id).sort()).toEqual([
      "v-priv-A",
      "v-team-X",
      "v-world",
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 6: break-glass (invariant 8). member denied; admin w/o sink denied;
// admin w/ sink reads the userB-private row, STILL drops cross-tenant, audit fires.
// ─────────────────────────────────────────────────────────────────────────────

describe("break-glass (invariant 8) — fails closed, never crosses tenant, always audited", () => {
  test("a member is denied (throws before any read)", async () => {
    const member = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "bgT", role: "member" }),
      async () => {},
    )
    await expect(member.breakGlass(["whatever"], "investigation")).rejects.toThrow()
  })

  test("an admin with NO audit sink is denied (unaudited break-glass is impossible)", async () => {
    const adminNoSink = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "bgT", role: "admin" }),
    )
    await expect(adminNoSink.breakGlass(["whatever"], "investigation")).rejects.toThrow()
  })

  test("an admin WITH a sink reads userB-private, drops cross-tenant, fires the audit", async () => {
    await seedOrg("bgA", "bg-a")
    await seedOrg("bgB", "bg-b")
    await seedDoc({ id: "bg-da", tenantId: "bgA", slug: "bg-doc-a" })
    await seedDoc({ id: "bg-db", tenantId: "bgB", slug: "bg-doc-b" })
    await seedChunk({
      id: "bg-priv-B",
      tenantId: "bgA",
      documentId: "bg-da",
      visibility: "private",
      userId: "userB",
    })
    await seedChunk({
      id: "bg-cross",
      tenantId: "bgB",
      documentId: "bg-db",
      visibility: "world",
    })

    // Non-vacuous: WITHOUT break-glass the admin cannot see userB's private row.
    const adminNormal = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "bgA", role: "admin", userId: "adminA" }),
    )
    expect(await adminNormal.getChunksByIds(["bg-priv-B"])).toHaveLength(0)

    const events: string[] = []
    const admin = new ScopedDB(
      drizzle(env_.DB),
      principal({ tenantId: "bgA", role: "admin", userId: "adminA" }),
      async (event) => {
        events.push(event.reason)
      },
    )
    const rows = await admin.breakGlass(["bg-priv-B", "bg-cross"], "incident-42")
    // Sees the private row it normally couldn't — but the cross-tenant id is STILL dropped.
    expect(rows.map((r) => r.id)).toEqual(["bg-priv-B"])
    // The audit sink fired (an unaudited break-glass cannot have happened).
    expect(events).toEqual(["incident-42"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 7: resolvePrincipal end-to-end in workerd (invariant 17). Fake clerkVerifier
// (NO network) → membership → active tenant → Principal → createScopedServices → the
// re-check returns only that tenant's rows. Plus 401-no-tenant + idempotent provision.
// ─────────────────────────────────────────────────────────────────────────────

const fakeVerifier = (identity: ClerkIdentity | null): ClerkVerifier => ({
  verify: async () => identity,
})

const bearerRequest = (): Request =>
  new Request("https://brain.test/op", {
    headers: { Authorization: "Bearer clerk.fake.jwt" },
  })

describe("resolvePrincipal end-to-end (invariant 17) — real workerd, injected Clerk", () => {
  test("Clerk JWT + active tenant → Principal → scoped services see only that tenant", async () => {
    await seedOrg("rpOrg", "rp-slug")
    await seedMembership({ tenantId: "rpOrg", userId: "rpUser" })
    await seedDoc({ id: "rp-doc", tenantId: "rpOrg", slug: "rp-doc" })
    await seedChunk({ id: "rp-mine", tenantId: "rpOrg", documentId: "rp-doc" })
    // A colliding row in a DIFFERENT tenant that must never surface.
    await seedOrg("rpOther", "rp-other")
    await seedDoc({ id: "rp-doc-o", tenantId: "rpOther", slug: "rp-doc-o" })
    await seedChunk({ id: "rp-theirs", tenantId: "rpOther", documentId: "rp-doc-o" })

    const p = await resolvePrincipal(env_, bearerRequest(), {
      clerkVerifier: fakeVerifier({ userId: "rpUser" }),
      activeTenantSlug: "rp-slug",
    })
    expect(p.tenantId).toBe("rpOrg")
    expect(p.userId).toBe("rpUser")

    const services = createScopedServices(env_, p)
    const rows = await services.db.getChunksByIds(["rp-mine", "rp-theirs"])
    expect(rows.map((r) => r.id)).toEqual(["rp-mine"])
  })

  test("a Clerk user WITH a membership but NO active tenant named → 401 (invariant 17)", async () => {
    await seedOrg("rp401", "rp-401")
    await seedMembership({ tenantId: "rp401", userId: "rp401User" })

    await expect(
      resolvePrincipal(env_, bearerRequest(), {
        clerkVerifier: fakeVerifier({ userId: "rp401User" }),
      }),
    ).rejects.toThrow(/active tenant required/)
  })

  test("a brand-new sub auto-provisions org==user; a second resolve is idempotent", async () => {
    const sub = "clerk_brand_new_sub"
    const tenantId = `org_${sub}`

    const first = await resolvePrincipal(env_, bearerRequest(), {
      clerkVerifier: fakeVerifier({ userId: sub }),
    })
    expect(first.tenantId).toBe(tenantId)
    expect(first.role).toBe("owner")
    expect(first.allowedScopes).toBe("*")
    expect(await countRows("orgs", tenantId)).toBe(1)
    expect(await countRows("memberships", tenantId)).toBe(1)

    // Second resolve: the membership now exists, so an active tenant MUST be named (the org
    // id is a valid selector). It must NOT create a second org/membership.
    const second = await resolvePrincipal(env_, bearerRequest(), {
      clerkVerifier: fakeVerifier({ userId: sub }),
      activeTenantSlug: tenantId,
    })
    expect(second.tenantId).toBe(tenantId)
    expect(await countRows("orgs", tenantId)).toBe(1)
    expect(await countRows("memberships", tenantId)).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 8: WRITE PATH (invariants 1, 10, 11) — real local D1 `db.batch` in workerd.
// Phase-2a converts the Phase-1 write-path todos into live canaries: tenant_id is
// forced on every write, the memory_audit row commits in the SAME db.batch as its
// change (all-or-nothing), and a tenant-A write is invisible to tenant B.
// ─────────────────────────────────────────────────────────────────────────────

describe("write-path tenant injection + audit-in-batch (invariants 1, 10) — real D1 batch", () => {
  test("a tenant-A write forces tenant_id, lands its audit in the SAME batch, is invisible to tenant B", async () => {
    await seedOrg("wpA", "wp-a")
    await seedOrg("wpB", "wp-b")
    const sdb = new ScopedDB(drizzle(env_.DB), principal({ tenantId: "wpA", userId: "wpUserA" }))

    // Smuggle a foreign tenant_id in the payload — the chokepoint MUST override it with wpA.
    const rogue = { slug: "wp-doc", fingerprint: "wp-fp", tenantId: "wpB" }
    const docId = await sdb.insertDocument(rogue as InsertDocumentInput)

    const doc = await env_.DB.prepare("SELECT tenant_id, user_id FROM documents WHERE id = ?")
      .bind(docId)
      .first<{ tenant_id: string; user_id: string }>()
    expect(doc?.tenant_id).toBe("wpA") // forced, NOT the smuggled "wpB"
    expect(doc?.user_id).toBe("wpUserA") // authorship forced

    // The audit row landed in the SAME batch, tenant-scoped to wpA (the actor's tenant).
    const audit = await env_.DB.prepare(
      "SELECT tenant_id, action FROM memory_audit WHERE target_id = ?",
    )
      .bind(docId)
      .first<{ tenant_id: string; action: string }>()
    expect(audit?.action).toBe("document.insert")
    expect(audit?.tenant_id).toBe("wpA")

    // Tenant B (through the chokepoint) cannot see tenant A's document nor its audit trail.
    const sdbB = new ScopedDB(drizzle(env_.DB), principal({ tenantId: "wpB" }))
    expect((await sdbB.listDocuments()).some((d) => d.id === docId)).toBe(false)
    const bAudit = await env_.DB.prepare(
      "SELECT count(*) AS n FROM memory_audit WHERE tenant_id = 'wpB'",
    ).first<{ n: number }>()
    expect(bAudit?.n).toBe(0)
  })

  test("a batch failure rolls back BOTH the change and its audit row (D1 batch atomicity)", async () => {
    await seedOrg("wpAtom", "wp-atom")
    await seedDoc({ id: "wp-atom-doc", tenantId: "wpAtom", slug: "wp-atom-doc" })
    // Pre-seed a chunk so a second insert with the SAME primary key fails at the DB layer.
    await seedChunk({ id: "wp-dup", tenantId: "wpAtom", documentId: "wp-atom-doc" })
    const sdb = new ScopedDB(drizzle(env_.DB), principal({ tenantId: "wpAtom" }))

    await expect(
      sdb.insertChunks([
        { id: "wp-fresh", documentId: "wp-atom-doc", chunkIndex: 1, content: "fresh" },
        { id: "wp-dup", documentId: "wp-atom-doc", chunkIndex: 2, content: "dup" }, // dup PK → throws
      ]),
    ).rejects.toThrow()

    // All-or-nothing: the fresh chunk rolled back AND no audit row was written.
    const fresh = await env_.DB.prepare(
      "SELECT count(*) AS n FROM chunks WHERE id = 'wp-fresh'",
    ).first<{ n: number }>()
    expect(fresh?.n).toBe(0)
    const audit = await env_.DB.prepare(
      "SELECT count(*) AS n FROM memory_audit WHERE action = 'chunk.insert' AND tenant_id = 'wpAtom'",
    ).first<{ n: number }>()
    expect(audit?.n).toBe(0)
  })

  test("recall-trace appends are tenant-isolated and tenant_id/author-forced", async () => {
    await seedOrg("rtA", "rt-a")
    const sdb = new ScopedDB(drizzle(env_.DB), principal({ tenantId: "rtA", userId: "rtUserA" }))
    await sdb.appendRecallTraces([
      { query: "needle", targetId: "rt-c1", score: 0.9, clientId: "claude-code" },
      { query: "needle", targetId: "rt-c2", score: 0.8, clientId: "claude-code" },
    ])

    const rows = await env_.DB.prepare(
      "SELECT tenant_id, user_id FROM memory_recall_traces WHERE tenant_id = 'rtA'",
    ).all<{ tenant_id: string; user_id: string }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results.every((r) => r.tenant_id === "rtA" && r.user_id === "rtUserA")).toBe(true)
    // A different tenant sees none of tenant A's traces.
    const other = await env_.DB.prepare(
      "SELECT count(*) AS n FROM memory_recall_traces WHERE tenant_id = 'rtB'",
    ).first<{ n: number }>()
    expect(other?.n).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canary 9 (HONESTY): boundaries that need LATER features remain visible todos.
// ─────────────────────────────────────────────────────────────────────────────

describe("not-yet-provable isolation (carry-forward — visible, not omitted)", () => {
  // BFS graph traversal lands in P4 (EntityExtractionWorkflow + generalized BFS over EdgeSpec).
  test.todo("[P4] BFS cross-tenant graph hop never crosses tenant_id at any depth")
  // The append-only trace + its tenant-forcing are proven above; the remaining deferred half is
  // the CALLER wiring the append OFF the synchronous read path via `ctx.waitUntil` (P5 surfaces).
  test.todo("[P5] recall-trace append is dispatched off the read path via ctx.waitUntil")
})

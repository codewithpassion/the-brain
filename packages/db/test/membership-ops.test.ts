import { describe, expect, test } from "bun:test"
import {
  addMemberCore,
  membershipsCore,
  removeMemberCore,
  searchUserByEmailCore,
  updateMemberCore,
} from "../src/admin/ops"
import { AuthError } from "../src/auth/errors"
import { makeDb, principal } from "./helpers"

/**
 * Membership management ops (Task #5):
 *   - search_user_by_email: resolves via stubbed Clerk BAPI fetch.
 *   - add_member: email→userId, inserts membership tenant-scoped, writes audit row, rejects duplicates.
 *   - update_member: role/scopes, last-owner guard, audited.
 *   - remove_member: deletes row, last-owner guard, audited.
 *   - non-admin is rejected with 403 for all mutating ops.
 */

// ── helpers ───────────────────────────────────────────────────────────────────

const OWNER_SECRET = "sk_test_fake"

const ownerP = (tenantId: string, userId = "actor") =>
  principal({
    tenantId,
    userId,
    role: "owner",
    capabilities: ["read", "write", "admin"],
  })

const memberP = (tenantId: string, userId = "actor") =>
  principal({
    tenantId,
    userId,
    role: "member",
    capabilities: ["read", "write"],
  })

/** Seed a minimal org + one owner membership so the tenant exists. */
const seedOrg = (sqlite: ReturnType<typeof makeDb>["sqlite"], orgId: string, ownerId = "actor") => {
  sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)`, [orgId, orgId, orgId])
  sqlite.run(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, 'owner')`, [
    `mem_${orgId}_${ownerId}`,
    orgId,
    ownerId,
  ])
}

/**
 * Minimal Clerk BAPI stub — returns a single user whose email matches the query.
 * Parses the `email_address` query param and serves it back so callers can assert
 * the field values without touching the real Clerk API.
 */
const clerkFetch = async (url: string): Promise<Response> => {
  const parsed = new URL(url)
  const email = parsed.searchParams.get("email_address") ?? ""
  const body = JSON.stringify([
    {
      id: `user_stub_${email.replace(/[^a-zA-Z0-9]/g, "_")}`,
      email_addresses: [{ id: "iea1", email_address: email }],
      primary_email_address_id: "iea1",
      first_name: "Stub",
      last_name: "User",
      image_url: "https://example.com/avatar.jpg",
    },
  ])
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
}

/** Stub that returns 404 (empty array — no matching user). */
const clerkFetchNotFound = async (): Promise<Response> =>
  new Response("[]", { status: 200, headers: { "content-type": "application/json" } })

// ── search_user_by_email ──────────────────────────────────────────────────────

describe("search_user_by_email", () => {
  test("resolves a user from the stubbed Clerk BAPI response", async () => {
    const result = await searchUserByEmailCore(OWNER_SECRET, "alice@example.com", clerkFetch)
    expect(result).not.toBeNull()
    expect(result?.email).toBe("alice@example.com")
    expect(result?.userId).toContain("user_stub_")
    expect(result?.firstName).toBe("Stub")
    expect(result?.lastName).toBe("User")
    expect(result?.imageUrl).toBe("https://example.com/avatar.jpg")
  })

  test("returns null when Clerk BAPI returns no user", async () => {
    const result = await searchUserByEmailCore(
      OWNER_SECRET,
      "nobody@example.com",
      clerkFetchNotFound,
    )
    expect(result).toBeNull()
  })

  test("tolerates a wrapped { data: [...] } envelope from the Clerk BAPI", async () => {
    // Some Clerk API versions or internal environments return { data: [...] } instead of a
    // bare array. The implementation should handle both without crashing.
    const wrappedFetch = async (_url: string): Promise<Response> => {
      const body = JSON.stringify({
        data: [
          {
            id: "user_wrapped",
            email_addresses: [{ id: "iea1", email_address: "wrapped@example.com" }],
            primary_email_address_id: "iea1",
            first_name: "Wrapped",
            last_name: "User",
            image_url: "",
          },
        ],
      })
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    }
    const result = await searchUserByEmailCore(OWNER_SECRET, "wrapped@example.com", wrappedFetch)
    expect(result).not.toBeNull()
    expect(result?.userId).toBe("user_wrapped")
    expect(result?.email).toBe("wrapped@example.com")
  })

  test("throws 500 when CLERK_SECRET_KEY is absent", async () => {
    await expect(
      searchUserByEmailCore(undefined, "any@example.com", clerkFetch),
    ).rejects.toMatchObject({ status: 500 })
  })
})

// ── add_member ────────────────────────────────────────────────────────────────

describe("add_member", () => {
  test("creates a membership row tenant-scoped with the resolved userId", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")

    const out = await addMemberCore(
      db,
      ownerP("org1"),
      { email: "bob@example.com", role: "member" },
      OWNER_SECRET,
      clerkFetch,
    )

    expect(typeof out.userId).toBe("string")
    expect(out.userId).toContain("user_stub_")
    expect(out.membershipId).toBe(`mem_org1_${out.userId}`)

    // Verify the DB row is in the correct tenant.
    const row = sqlite
      .query(`SELECT * FROM memberships WHERE tenant_id = 'org1' AND user_id = ?`)
      .get(out.userId) as Record<string, unknown> | null
    expect(row).not.toBeNull()
    expect(row?.role).toBe("member")
    expect(row?.tenant_id).toBe("org1")
    expect(row?.allowed_scopes).toBeNull() // default '*'
  })

  test("stores a member.add audit row (actor recorded)", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")

    const out = await addMemberCore(
      db,
      ownerP("org1", "actor"),
      { email: "carol@example.com", role: "member" },
      OWNER_SECRET,
      clerkFetch,
    )

    const audit = sqlite
      .query(`SELECT * FROM memory_audit WHERE tenant_id = 'org1' AND action = 'member.add'`)
      .get() as Record<string, unknown> | null
    expect(audit).not.toBeNull()
    expect(audit?.user_id).toBe("actor") // actor
    expect(audit?.target_id).toBe(out.userId) // the added user
  })

  test("rejects duplicate add with 409", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")

    // First add succeeds.
    const out = await addMemberCore(
      db,
      ownerP("org1"),
      { email: "dup@example.com", role: "member" },
      OWNER_SECRET,
      clerkFetch,
    )

    // Second add with the same email → 409.
    await expect(
      addMemberCore(
        db,
        ownerP("org1"),
        { email: "dup@example.com", role: "admin" },
        OWNER_SECRET,
        clerkFetch,
      ),
    ).rejects.toMatchObject({ status: 409 })

    // Still only one membership for that userId.
    const count = sqlite
      .query(`SELECT COUNT(*) as n FROM memberships WHERE user_id = ?`)
      .get(out.userId) as { n: number }
    expect(count.n).toBe(1)
  })

  test("returns 404 when email has no Clerk account", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")

    await expect(
      addMemberCore(
        db,
        ownerP("org1"),
        { email: "ghost@example.com", role: "member" },
        OWNER_SECRET,
        clerkFetchNotFound,
      ),
    ).rejects.toMatchObject({ status: 404 })
  })

  test("non-admin caller is rejected with 403", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")

    await expect(
      addMemberCore(
        db,
        memberP("org1"),
        { email: "any@example.com", role: "member" },
        OWNER_SECRET,
        clerkFetch,
      ),
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ── update_member ─────────────────────────────────────────────────────────────

describe("update_member", () => {
  test("updates role and writes an audit row", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")
    // Seed a second owner so we can demote one.
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('mem_org1_other', 'org1', 'other', 'owner')`,
    )

    const out = await updateMemberCore(db, ownerP("org1", "actor"), {
      userId: "other",
      role: "admin",
    })

    expect(out.updated).toBe(true)
    expect(out.userId).toBe("other")

    const row = sqlite
      .query(`SELECT role FROM memberships WHERE tenant_id = 'org1' AND user_id = 'other'`)
      .get() as { role: string } | null
    expect(row?.role).toBe("admin")

    const audit = sqlite
      .query(`SELECT * FROM memory_audit WHERE action = 'member.update'`)
      .get() as Record<string, unknown> | null
    expect(audit).not.toBeNull()
    expect(audit?.target_id).toBe("other")
    expect(audit?.user_id).toBe("actor")
  })

  test("last-owner guard: cannot demote the last owner", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor") // only one owner

    await expect(
      updateMemberCore(db, ownerP("org1", "actor"), { userId: "actor", role: "member" }),
    ).rejects.toBeInstanceOf(AuthError)

    await expect(
      updateMemberCore(db, ownerP("org1", "actor"), { userId: "actor", role: "admin" }),
    ).rejects.toMatchObject({ status: 409 })
  })

  test("can promote a member to owner without triggering last-owner guard", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('mem_org1_target', 'org1', 'target', 'member')`,
    )

    const out = await updateMemberCore(db, ownerP("org1", "actor"), {
      userId: "target",
      role: "owner",
    })
    expect(out.updated).toBe(true)
  })

  test("returns false when no fields to update are provided", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")

    const out = await updateMemberCore(db, ownerP("org1", "actor"), { userId: "actor" })
    expect(out.updated).toBe(false)
  })

  test("throws 404 when userId is not a member", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")

    await expect(
      updateMemberCore(db, ownerP("org1", "actor"), { userId: "ghost", role: "member" }),
    ).rejects.toMatchObject({ status: 404 })
  })

  test("non-admin caller is rejected with 403", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")

    await expect(
      updateMemberCore(db, memberP("org1", "actor"), { userId: "actor", role: "member" }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ── remove_member ─────────────────────────────────────────────────────────────

describe("remove_member", () => {
  test("removes the membership and writes an audit row", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")
    // Seed a second owner so we can remove one.
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('mem_org1_other', 'org1', 'other', 'owner')`,
    )

    const out = await removeMemberCore(db, ownerP("org1", "actor"), { userId: "other" })
    expect(out.removed).toBe(true)
    expect(out.userId).toBe("other")

    const row = sqlite
      .query(`SELECT * FROM memberships WHERE tenant_id = 'org1' AND user_id = 'other'`)
      .get()
    expect(row).toBeNull()

    const audit = sqlite
      .query(`SELECT * FROM memory_audit WHERE action = 'member.remove'`)
      .get() as Record<string, unknown> | null
    expect(audit).not.toBeNull()
    expect(audit?.target_id).toBe("other")
    expect(audit?.user_id).toBe("actor")
  })

  test("last-owner guard: cannot remove the last owner", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor") // only one owner

    await expect(
      removeMemberCore(db, ownerP("org1", "actor"), { userId: "actor" }),
    ).rejects.toBeInstanceOf(AuthError)

    await expect(
      removeMemberCore(db, ownerP("org1", "actor"), { userId: "actor" }),
    ).rejects.toMatchObject({ status: 409 })
  })

  test("returns removed=false when userId is not a member (idempotent)", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")

    const out = await removeMemberCore(db, ownerP("org1", "actor"), { userId: "ghost" })
    expect(out.removed).toBe(false)
  })

  test("non-admin caller is rejected with 403", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1", "actor")

    await expect(
      removeMemberCore(db, memberP("org1", "actor"), { userId: "actor" }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ── cross-tenant isolation ────────────────────────────────────────────────────

describe("cross-tenant isolation", () => {
  test("add_member only inserts into the principal's active tenant (tenant_id forced)", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")
    seedOrg(sqlite, "org2", "other")

    await addMemberCore(
      db,
      ownerP("org1"),
      { email: "alice@example.com", role: "member" },
      OWNER_SECRET,
      clerkFetch,
    )

    // Only org1 has the new member.
    const org2Count = sqlite
      .query(`SELECT COUNT(*) as n FROM memberships WHERE tenant_id = 'org2'`)
      .get() as { n: number }
    expect(org2Count.n).toBe(1) // only the seeded owner
  })

  test("memberships op still only returns the active tenant's rows", async () => {
    const { sqlite, db } = makeDb()
    seedOrg(sqlite, "org1")
    seedOrg(sqlite, "org2", "other")

    await addMemberCore(
      db,
      ownerP("org1"),
      { email: "alice@example.com", role: "member" },
      OWNER_SECRET,
      clerkFetch,
    )

    // list org1 only
    const out = await membershipsCore(db, ownerP("org1"), {})
    const tenants = out.memberships.map((m) => m.userId)
    expect(tenants).not.toContain("other") // org2's owner must not appear
  })
})

import { describe, expect, test } from "bun:test"
import { createOrgCore, listOrgsCore } from "../src/admin/ops"
import { AuthError } from "../src/auth/errors"
import { autoProvisionOrg, loadMembershipPrincipal } from "../src/auth/principal"
import { makeDb, principal } from "./helpers"

/**
 * `create_org` + `list_orgs` ops (multi-org core).
 *
 * Tests assert:
 *   1. create_org inserts org + owner membership + created_by.
 *   2. list_orgs returns only the calling user's orgs with role.
 *   3. Slug conflict → clear error (no silent upsert).
 *   4. A second org is switchable (list_orgs surfaces both; loadMembershipPrincipal resolves each).
 *   5. Non-member tenant is rejected at the auth layer (loadMembershipPrincipal returns null).
 */

const ownerP = (tenantId: string, userId = "userA") =>
  principal({ tenantId, userId, role: "owner", capabilities: ["read", "write", "admin"] })

// ── create_org ────────────────────────────────────────────────────────────────

describe("create_org", () => {
  test("inserts org + owner membership + created_by for the caller", async () => {
    const { sqlite, db } = makeDb()

    // Seed an existing org so the principal has a tenantId to resolve to.
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('existing', 'Existing', 'existing')`)
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m0', 'existing', 'userA', 'owner')`,
    )

    const out = await createOrgCore(db, ownerP("existing", "userA"), {
      name: "Acme Corp",
      slug: "acme",
    })

    expect(out.slug).toBe("acme")
    expect(typeof out.id).toBe("string")
    expect(out.id.length).toBeGreaterThan(0)

    // org row exists with created_by
    const orgRow = sqlite.query(`SELECT * FROM orgs WHERE id = ?`).get(out.id) as Record<
      string,
      unknown
    > | null
    expect(orgRow).not.toBeNull()
    expect(orgRow?.name).toBe("Acme Corp")
    expect(orgRow?.slug).toBe("acme")
    expect(orgRow?.created_by).toBe("userA")

    // owner membership row exists
    const memRow = sqlite
      .query(`SELECT * FROM memberships WHERE tenant_id = ? AND user_id = ?`)
      .get(out.id, "userA") as Record<string, unknown> | null
    expect(memRow).not.toBeNull()
    expect(memRow?.role).toBe("owner")
    expect(memRow?.allowed_scopes).toBeNull() // NULL = '*'
  })

  test("slug is auto-derived from name when omitted", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('existing', 'Existing', 'existing')`)
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m0', 'existing', 'userA', 'owner')`,
    )

    const out = await createOrgCore(db, ownerP("existing", "userA"), { name: "My New Org" })
    expect(out.slug).toBe("my-new-org")
  })

  test("slug conflict → clear AuthError(409)", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('existing', 'Existing', 'existing')`)
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m0', 'existing', 'userA', 'owner')`,
    )
    // Pre-insert an org with the conflicting slug.
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('other', 'Other', 'taken-slug')`)

    await expect(
      createOrgCore(db, ownerP("existing", "userA"), { name: "Conflict", slug: "taken-slug" }),
    ).rejects.toBeInstanceOf(AuthError)

    // Verify the error is specifically a 409.
    let caught: AuthError | null = null
    try {
      await createOrgCore(db, ownerP("existing", "userA"), { name: "Conflict", slug: "taken-slug" })
    } catch (e) {
      caught = e as AuthError
    }
    expect(caught?.status).toBe(409)
    expect(caught?.message).toContain("taken-slug")
  })
})

// ── list_orgs ─────────────────────────────────────────────────────────────────

describe("list_orgs", () => {
  test("returns only the calling user's orgs with role, not other users' orgs", async () => {
    const { sqlite, db } = makeDb()

    // userA is in two orgs; userB is in one different org.
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'Org One', 'org-one')`)
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org2', 'Org Two', 'org-two')`)
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org3', 'Org Three', 'org-three')`)
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m1', 'org1', 'userA', 'owner')`,
    )
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m2', 'org2', 'userA', 'member')`,
    )
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m3', 'org3', 'userB', 'owner')`,
    )

    const outA = await listOrgsCore(db, ownerP("org1", "userA"))
    expect(outA.orgs.map((o) => o.id).sort()).toEqual(["org1", "org2"])
    expect(outA.orgs.find((o) => o.id === "org1")?.role).toBe("owner")
    expect(outA.orgs.find((o) => o.id === "org2")?.role).toBe("member")
    // userB's org must not appear.
    expect(outA.orgs.some((o) => o.id === "org3")).toBe(false)

    // userB sees only their own org.
    const outB = await listOrgsCore(db, ownerP("org3", "userB"))
    expect(outB.orgs.map((o) => o.id)).toEqual(["org3"])
  })

  test("includes slug + name in every row", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'Alpha Org', 'alpha-org')`)
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m1', 'org1', 'userA', 'owner')`,
    )

    const out = await listOrgsCore(db, ownerP("org1", "userA"))
    expect(out.orgs[0]).toMatchObject({
      id: "org1",
      slug: "alpha-org",
      name: "Alpha Org",
      role: "owner",
    })
  })

  test("returns empty array when user has no memberships", async () => {
    const { db } = makeDb()
    const out = await listOrgsCore(db, ownerP("nonexistent", "ghostUser"))
    expect(out.orgs).toEqual([])
  })
})

// ── switchable second org + non-member rejection ──────────────────────────────

describe("multi-org: switchability + non-member rejection", () => {
  test("a second org is switchable: loadMembershipPrincipal resolves both orgs for the user", async () => {
    const { sqlite, db } = makeDb()

    // userA is auto-provisioned in their personal org, then also joins a team org.
    const personalId = await autoProvisionOrg(db, "userA", "User A")
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('team-org', 'Team Org', 'team-org')`)
    sqlite.run(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ('m-team', 'team-org', 'userA', 'member')`,
    )

    // Both orgs are resolvable for userA.
    const personalPrincipal = await loadMembershipPrincipal(db, "userA", personalId)
    expect(personalPrincipal).not.toBeNull()
    expect(personalPrincipal?.tenantId).toBe(personalId)

    const teamPrincipal = await loadMembershipPrincipal(db, "userA", "team-org")
    expect(teamPrincipal).not.toBeNull()
    expect(teamPrincipal?.tenantId).toBe("team-org")
    expect(teamPrincipal?.role).toBe("member")
  })

  test("non-member tenant is rejected: loadMembershipPrincipal returns null (→ 401 at edge)", async () => {
    const { sqlite, db } = makeDb()

    // userA is in their personal org only.
    const personalId = await autoProvisionOrg(db, "userA", "User A")
    // There exists another org that userA is NOT a member of.
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('other-org', 'Other Org', 'other-org')`)

    // Attempting to resolve userA against the other org → null (API would 401).
    const result = await loadMembershipPrincipal(db, "userA", "other-org")
    expect(result).toBeNull()

    // userA's own org still resolves fine.
    const own = await loadMembershipPrincipal(db, "userA", personalId)
    expect(own).not.toBeNull()
  })

  test("create_org + list_orgs end-to-end: new org appears in the user's list", async () => {
    const { db } = makeDb()

    // Bootstrap: userA has a personal org.
    const personalId = await autoProvisionOrg(db, "userA", "User A")
    const beforeCreate = await listOrgsCore(db, ownerP(personalId, "userA"))
    expect(beforeCreate.orgs.length).toBe(1)

    // Create a second org.
    const created = await createOrgCore(db, ownerP(personalId, "userA"), {
      name: "New Project",
      slug: "new-project",
    })

    // It should now appear in list_orgs.
    const afterCreate = await listOrgsCore(db, ownerP(personalId, "userA"))
    expect(afterCreate.orgs.length).toBe(2)
    expect(afterCreate.orgs.some((o) => o.id === created.id && o.slug === "new-project")).toBe(true)
    expect(afterCreate.orgs.some((o) => o.id === personalId)).toBe(true)
  })
})

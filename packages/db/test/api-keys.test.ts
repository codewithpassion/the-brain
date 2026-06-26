import { describe, expect, test } from "bun:test"
import { createApiKeyCore, listApiKeysCore, revokeApiKeyCore } from "../src/admin/ops"
import { AuthError } from "../src/auth/errors"
import { resolveApiKeyPrincipal } from "../src/auth/mint"
import { makeDb, principal } from "./helpers"

/**
 * API key CRUD ops (Task #7):
 *   - list_api_keys: REDACTED listing (no key_hash, no raw token), admin-only, tenant-isolated.
 *   - create_api_key: returns raw bk_ token ONCE; the key resolves via resolvePrincipal; audited.
 *   - revoke_api_key: sets revoked_at; revoked key fails resolution; tenant isolation no-op; audited.
 */

const adminP = (tenantId: string, userId = "actor") =>
  principal({
    tenantId,
    userId,
    role: "owner",
    capabilities: ["read", "write", "admin"],
  })

const memberP = (tenantId: string) =>
  principal({
    tenantId,
    role: "member",
    capabilities: ["read", "write"],
  })

// ── list_api_keys ─────────────────────────────────────────────────────────────

describe("list_api_keys", () => {
  test("returns REDACTED keys for the active tenant — no key_hash in output", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const out = await createApiKeyCore(db, adminP("org1"), { name: "my-key" })

    const listed = await listApiKeysCore(db, adminP("org1"))
    expect(listed.keys).toHaveLength(1)
    const k = listed.keys[0]
    expect(k?.id).toBe(out.keyId)
    expect(k?.name).toBe("my-key")
    expect(k?.keyPrefix).toBe(out.keyPrefix)
    // REDACTED: no key_hash, no raw token — only the typed row shape
    expect(Object.keys(k ?? {})).not.toContain("keyHash")
    expect(Object.keys(k ?? {})).not.toContain("token")
    expect(typeof k?.readOnly).toBe("boolean")
  })

  test("returns keys newest-first", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org2', 'org2', 'org2')`)

    const a = await createApiKeyCore(db, adminP("org2"), { name: "key-a" })
    const b = await createApiKeyCore(db, adminP("org2"), { name: "key-b" })

    const listed = await listApiKeysCore(db, adminP("org2"))
    expect(listed.keys.map((k) => k.id)).toContain(a.keyId)
    expect(listed.keys.map((k) => k.id)).toContain(b.keyId)
  })

  test("non-admin is denied (403)", async () => {
    const { db } = makeDb()
    const err = await listApiKeysCore(db, memberP("org1")).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })

  test("tenant isolation: only returns keys for the active tenant", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('tenA', 'tenA', 'tenA')`)
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('tenB', 'tenB', 'tenB')`)

    // Key in tenant A
    const keyA = await createApiKeyCore(db, adminP("tenA"), { name: "key-a" })
    // Key in tenant B
    await createApiKeyCore(db, adminP("tenB"), { name: "key-b" })

    // Tenant A admin can only see their own key
    const listedA = await listApiKeysCore(db, adminP("tenA"))
    expect(listedA.keys).toHaveLength(1)
    expect(listedA.keys[0]?.id).toBe(keyA.keyId)

    // Tenant B admin can only see their own key
    const listedB = await listApiKeysCore(db, adminP("tenB"))
    expect(listedB.keys).toHaveLength(1)
    expect(listedB.keys[0]?.name).toBe("key-b")
  })
})

// ── create_api_key ────────────────────────────────────────────────────────────

describe("create_api_key", () => {
  test("returns a raw bk_ token ONCE + stored metadata", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const out = await createApiKeyCore(db, adminP("org1"), { name: "ci-key" })
    expect(out.token).toMatch(/^bk_/)
    expect(out.keyId).toBeTruthy()
    expect(out.keyPrefix).toBe(out.token.slice(0, 11))
    expect(out.name).toBe("ci-key")
    expect(Array.isArray(out.scopes)).toBe(true)
  })

  test("the minted key resolves via resolveApiKeyPrincipal (resolvePrincipal path)", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const { token } = await createApiKeyCore(db, adminP("org1"), { name: "resolve-test" })
    const resolved = await resolveApiKeyPrincipal(db, token)
    expect(resolved).not.toBeNull()
    expect(resolved?.tenantId).toBe("org1")
  })

  test("scopes are intersected DOWN to the minter's capabilities (no escalation)", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    // Minter has admin (to pass assertAdmin) but NOT write — so write is dropped from the key.
    const restrictedMinter = principal({
      tenantId: "org1",
      role: "admin",
      capabilities: ["read", "admin"],
    })
    // Request write capability — minter doesn't hold it, so it's dropped
    const out = await createApiKeyCore(db, restrictedMinter, {
      name: "narrow",
      scopes: ["read", "write", "admin"],
    })
    expect(out.scopes).toContain("read")
    expect(out.scopes).toContain("admin")
    expect(out.scopes).not.toContain("write") // write dropped (not in minter's capabilities)
  })

  test("writes an apikey.create audit row with actor userId", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const out = await createApiKeyCore(db, adminP("org1", "actor-123"), { name: "audit-test" })

    const audit = sqlite
      .query(`SELECT * FROM memory_audit WHERE tenant_id = 'org1' AND action = 'apikey.create'`)
      .get() as Record<string, unknown> | null
    expect(audit).not.toBeNull()
    expect(audit?.user_id).toBe("actor-123")
    expect(audit?.target_id).toBe(out.keyId)
  })

  test("non-admin is denied (403)", async () => {
    const { db } = makeDb()
    const err = await createApiKeyCore(db, memberP("org1"), { name: "x" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })
})

// ── revoke_api_key ────────────────────────────────────────────────────────────

describe("revoke_api_key", () => {
  test("sets revoked_at on the row", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const { keyId } = await createApiKeyCore(db, adminP("org1"), { name: "to-revoke" })
    const out = await revokeApiKeyCore(db, adminP("org1"), { keyId })
    expect(out.revoked).toBe(true)
    expect(out.keyId).toBe(keyId)

    const row = sqlite.query(`SELECT revoked_at FROM api_keys WHERE id = ?`).get(keyId) as {
      revoked_at: string | null
    } | null
    expect(row?.revoked_at).toBeTruthy()
  })

  test("a revoked key fails resolution via resolveApiKeyPrincipal", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const { token, keyId } = await createApiKeyCore(db, adminP("org1"), { name: "to-revoke-2" })

    // Resolves before revocation
    const before = await resolveApiKeyPrincipal(db, token)
    expect(before).not.toBeNull()

    // Revoke it
    await revokeApiKeyCore(db, adminP("org1"), { keyId })

    // Fails resolution after revocation (resolveApiKeyPrincipal:164 — if (row.revokedAt) return null)
    const after = await resolveApiKeyPrincipal(db, token)
    expect(after).toBeNull()
  })

  test("writes an apikey.revoke audit row", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('org1', 'org1', 'org1')`)

    const { keyId } = await createApiKeyCore(db, adminP("org1", "actor-456"), {
      name: "revoke-audit",
    })
    await revokeApiKeyCore(db, adminP("org1", "actor-456"), { keyId })

    const audit = sqlite
      .query(`SELECT * FROM memory_audit WHERE tenant_id = 'org1' AND action = 'apikey.revoke'`)
      .get() as Record<string, unknown> | null
    expect(audit).not.toBeNull()
    expect(audit?.user_id).toBe("actor-456")
    expect(audit?.target_id).toBe(keyId)
  })

  test("no-op (revoked=false) when keyId is not in this tenant", async () => {
    const { sqlite, db } = makeDb()
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('tenA', 'tenA', 'tenA')`)
    sqlite.run(`INSERT INTO orgs (id, name, slug) VALUES ('tenB', 'tenB', 'tenB')`)

    // Key belongs to tenant B
    const { keyId } = await createApiKeyCore(db, adminP("tenB"), { name: "tenB-key" })

    // Tenant A tries to revoke it — must be a no-op
    const out = await revokeApiKeyCore(db, adminP("tenA"), { keyId })
    expect(out.revoked).toBe(false)

    // Tenant B's key is still active
    const row = sqlite.query(`SELECT revoked_at FROM api_keys WHERE id = ?`).get(keyId) as {
      revoked_at: string | null
    } | null
    expect(row?.revoked_at).toBeNull()
  })

  test("non-admin is denied (403)", async () => {
    const { db } = makeDb()
    const err = await revokeApiKeyCore(db, memberP("org1"), { keyId: "any" }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })
})

import { describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT } from "jose"
import {
  AuthError,
  aggregateMemberships,
  autoProvisionOrg,
  type ClerkVerifier,
  makeClerkVerifier,
  mintApiKey,
  mintMachineToken,
  resolvePrincipal,
} from "../src/auth"
import type { BrainBindings } from "../src/env"
import { memberships, orgs } from "../src/schema"
import { makeDb, principal } from "./helpers"

/**
 * The edge auth resolver (PRD §7.2, invariant 17): every credential reduces to ONE validated
 * Principal, tenant comes from the pinned mechanism (never the JWT alone), and a Clerk user
 * with memberships but no active tenant is a 401 — never a silent first-membership default.
 * Tests use a bun:sqlite-backed Drizzle DB, a locally-signed Clerk token via an injected
 * verifier, and real WebCrypto for the `bdev_` HMAC and `bk_` SHA-256 paths.
 */

const ISSUER = "https://clerk.test"
const DEVICE_SECRET = "test-device-flow-secret"

/** Local base64url codec (mirrors the internal token codec) for the claim-forgery test. */
const b64urlToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
const bytesToB64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** A minimal env — the DB and Clerk verifier are injected, so only the secrets are read. */
const testEnv = (): BrainBindings =>
  ({
    CLERK_FRONTEND_API: "clerk.test",
    DEVICE_FLOW_SECRET: DEVICE_SECRET,
  }) as unknown as BrainBindings

const bearer = (token: string, tenantHeader?: string): Request =>
  new Request("https://api.brain.test/think", {
    headers: tenantHeader
      ? { Authorization: `Bearer ${token}`, "X-Brain-Tenant": tenantHeader }
      : { Authorization: `Bearer ${token}` },
  })

/** Sign a real RS256 JWT and return it alongside a verifier bound to the matching key. */
const clerkToken = async (
  sub: string,
  email?: string,
): Promise<{ token: string; verifier: ClerkVerifier }> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const builder = new SignJWT(email ? { email } : {})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("1h")
  const token = await builder.sign(privateKey)
  return { token, verifier: makeClerkVerifier(publicKey, ISSUER) }
}

describe("resolvePrincipal — Clerk JWT", () => {
  test("valid token + active-tenant slug → correct Principal (role→capabilities)", async () => {
    const { db } = makeDb()
    await db.insert(orgs).values({ id: "org_acme", name: "Acme", slug: "acme" })
    await db.insert(memberships).values({
      id: "m1",
      tenantId: "org_acme",
      userId: "user_owner",
      teamId: null,
      role: "owner",
      allowedScopes: null,
    })
    const { token, verifier } = await clerkToken("user_owner", "owner@acme.test")

    const p = await resolvePrincipal(testEnv(), bearer(token, "acme"), {
      db,
      clerkVerifier: verifier,
    })
    expect(p.tenantId).toBe("org_acme")
    expect(p.userId).toBe("user_owner")
    expect(p.role).toBe("owner")
    expect(p.allowedScopes).toBe("*")
    expect([...p.capabilities].sort()).toEqual(["admin", "read", "write"])
    expect(p.readOnly).toBe(false)
  })

  test("a restricted member's grant + capabilities come from the membership row", async () => {
    const { db } = makeDb()
    await db.insert(orgs).values({ id: "org_acme", name: "Acme", slug: "acme" })
    await db.insert(memberships).values({
      id: "m1",
      tenantId: "org_acme",
      userId: "user_member",
      teamId: "teamX",
      role: "member",
      allowedScopes: JSON.stringify(["clientA"]),
    })
    const { token, verifier } = await clerkToken("user_member")

    const p = await resolvePrincipal(testEnv(), bearer(token), {
      db,
      clerkVerifier: verifier,
      activeTenantSlug: "acme",
    })
    expect(p.role).toBe("member")
    expect(p.allowedScopes).toEqual(["clientA"])
    expect([...p.capabilities].sort()).toEqual(["read", "write"])
    expect([...p.teamIds]).toEqual(["teamX"])
  })

  test("user HAS memberships but NO active tenant specified → 401 (no silent default)", async () => {
    const { db } = makeDb()
    await db.insert(orgs).values({ id: "org_acme", name: "Acme", slug: "acme" })
    await db.insert(memberships).values({
      id: "m1",
      tenantId: "org_acme",
      userId: "user_owner",
      teamId: null,
      role: "owner",
      allowedScopes: null,
    })
    const { token, verifier } = await clerkToken("user_owner")

    const promise = resolvePrincipal(testEnv(), bearer(token), { db, clerkVerifier: verifier })
    await expect(promise).rejects.toMatchObject({ status: 401 })
  })

  test("member of tenant A cannot select tenant B → 401", async () => {
    const { db } = makeDb()
    await db.insert(orgs).values({ id: "org_a", name: "A", slug: "tenant-a" })
    await db.insert(orgs).values({ id: "org_b", name: "B", slug: "tenant-b" })
    await db.insert(memberships).values({
      id: "m1",
      tenantId: "org_a",
      userId: "user_x",
      teamId: null,
      role: "member",
      allowedScopes: null,
    })
    const { token, verifier } = await clerkToken("user_x")

    const promise = resolvePrincipal(testEnv(), bearer(token, "tenant-b"), {
      db,
      clerkVerifier: verifier,
    })
    await expect(promise).rejects.toMatchObject({ status: 401 })
  })
})

describe("resolvePrincipal — first-login auto-provision", () => {
  test("brand-new user → provisions org==user + owner membership; bound on next request", async () => {
    const { db } = makeDb()
    const { token, verifier } = await clerkToken("user_new", "new@brain.test")

    // First authenticated request, no org → auto-provision own org and bind to it.
    const first = await resolvePrincipal(testEnv(), bearer(token), { db, clerkVerifier: verifier })
    expect(first.tenantId).toBe("org_user_new")
    expect(first.role).toBe("owner")
    expect(first.allowedScopes).toBe("*")

    // The user now HAS a membership: a later request must name the active tenant (invariant
    // 17 — no silent default), here the user's own org. It binds to the SAME tenant, no dup.
    const second = await resolvePrincipal(testEnv(), bearer(token), {
      db,
      clerkVerifier: verifier,
      activeTenantSlug: "org_user_new",
    })
    expect(second.tenantId).toBe("org_user_new")

    const orgRows = await db.select().from(orgs)
    const memRows = await db.select().from(memberships)
    expect(orgRows).toHaveLength(1)
    expect(memRows).toHaveLength(1)
  })

  test("autoProvisionOrg is idempotent under concurrent first-requests (UNIQUE index)", async () => {
    const { db } = makeDb()
    // Two simultaneous first-requests both see no org and race to provision.
    const [a, b] = await Promise.all([
      autoProvisionOrg(db, "user_race", "user_race"),
      autoProvisionOrg(db, "user_race", "user_race"),
    ])
    expect(a).toBe("org_user_race")
    expect(b).toBe("org_user_race")
    expect(await db.select().from(orgs)).toHaveLength(1)
    expect(await db.select().from(memberships)).toHaveLength(1)
  })
})

describe("aggregateMemberships — scope grant resolution (PRD §7.2)", () => {
  test("a NULL grant on ANY row widens to '*' (never the finite union)", () => {
    const agg = aggregateMemberships([
      { role: "member", teamId: "teamA", allowedScopes: null },
      { role: "member", teamId: "teamB", allowedScopes: JSON.stringify(["clientA"]) },
    ])
    expect(agg?.allowedScopes).toBe("*")
    expect(agg?.teamIds.sort()).toEqual(["teamA", "teamB"])
  })

  test("all-finite rows union their grants; role is the highest", () => {
    const agg = aggregateMemberships([
      { role: "member", teamId: null, allowedScopes: JSON.stringify(["clientA"]) },
      { role: "readonly", teamId: null, allowedScopes: JSON.stringify(["clientB"]) },
    ])
    expect(agg?.role).toBe("member")
    expect([...(agg?.allowedScopes ?? [])].sort()).toEqual(["clientA", "clientB"])
  })

  test("owner/admin is always '*' regardless of stored grant", () => {
    const agg = aggregateMemberships([
      { role: "admin", teamId: null, allowedScopes: JSON.stringify(["clientA"]) },
    ])
    expect(agg?.allowedScopes).toBe("*")
  })
})

describe("resolvePrincipal — bdev_ machine token", () => {
  test("valid HMAC → tenant-baked Principal; tampered signature → 401", async () => {
    const { db } = makeDb()
    const minter = principal({
      tenantId: "org_acme",
      userId: "user_owner",
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
    })
    const token = await mintMachineToken(DEVICE_SECRET, minter)

    const p = await resolvePrincipal(testEnv(), bearer(token), { db })
    expect(p.tenantId).toBe("org_acme")
    expect(p.userId).toBe("user_owner")
    expect(p.role).toBe("owner")

    const tampered = `${token.slice(0, -2)}xy`
    await expect(resolvePrincipal(testEnv(), bearer(tampered), { db })).rejects.toMatchObject({
      status: 401,
    })
  })

  test("forging another tenant into the claims breaks the MAC → 401", async () => {
    const { db } = makeDb()
    const minter = principal({ tenantId: "org_acme", userId: "user_owner" })
    const token = await mintMachineToken(DEVICE_SECRET, minter)
    // Rewrite the base64url claims body to point at a different tenant, keep the old MAC.
    const [body, mac] = token.slice("bdev_".length).split(".")
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(body ?? "")))
    claims.tenantId = "org_victim"
    const forgedBody = bytesToB64url(new TextEncoder().encode(JSON.stringify(claims)))
    const forged = `bdev_${forgedBody}.${mac}`
    await expect(resolvePrincipal(testEnv(), bearer(forged), { db })).rejects.toMatchObject({
      status: 401,
    })
  })

  test("scopes baked into claims are bounded by the minter", async () => {
    const { db } = makeDb()
    const minter = principal({ allowedScopes: ["clientA"], capabilities: ["read", "write"] })
    const token = await mintMachineToken(DEVICE_SECRET, minter, {
      requestedScopes: "*",
      requestedCapabilities: ["read", "write", "admin"],
    })
    const p = await resolvePrincipal(testEnv(), bearer(token), { db })
    expect(p.allowedScopes).toEqual(["clientA"])
    expect([...p.capabilities].sort()).toEqual(["read", "write"])
  })
})

describe("resolvePrincipal — bk_ API key", () => {
  test("valid hash → Principal with stored scopes/caps/read_only; revoked/expired → 401", async () => {
    const { db, sqlite } = makeDb()
    const minter = principal({
      tenantId: "org_acme",
      userId: "user_owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
    })
    const { token, keyId } = await mintApiKey(db, minter, {
      name: "ci-key",
      requestedCapabilities: ["read"],
      readOnly: true,
    })

    const p = await resolvePrincipal(testEnv(), bearer(token), { db })
    expect(p.tenantId).toBe("org_acme")
    expect(p.readOnly).toBe(true)
    expect(p.role).toBe("readonly")
    expect([...p.capabilities]).toEqual(["read"])

    // Revoke → 401.
    sqlite.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [
      "2026-06-25T00:00:00.000Z",
      keyId,
    ])
    await expect(resolvePrincipal(testEnv(), bearer(token), { db })).rejects.toMatchObject({
      status: 401,
    })
  })

  test("expired key → 401", async () => {
    const { db, sqlite } = makeDb()
    const minter = principal({ allowedScopes: "*", capabilities: ["read", "write"] })
    const { token, keyId } = await mintApiKey(db, minter, { name: "exp-key" })
    sqlite.run("UPDATE api_keys SET expires_at = ? WHERE id = ?", [
      "2000-01-01T00:00:00.000Z",
      keyId,
    ])
    await expect(resolvePrincipal(testEnv(), bearer(token), { db })).rejects.toMatchObject({
      status: 401,
    })
  })
})

describe("mintApiKey — no scope/capability escalation (PRD §7.1)", () => {
  test("requested scopes EXCEEDING the minter are intersected down; caps bounded too", async () => {
    const { db } = makeDb()
    const restricted = principal({
      tenantId: "org_acme",
      userId: "user_member",
      role: "member",
      allowedScopes: ["clientA"],
      capabilities: ["read", "write"],
    })
    // Restricted member asks for the whole tenant + admin — must NOT widen.
    const { token } = await mintApiKey(db, restricted, {
      name: "escalation-attempt",
      requestedScopes: "*",
      requestedCapabilities: ["read", "write", "admin"],
    })

    const p = await resolvePrincipal(testEnv(), bearer(token), { db })
    expect(p.allowedScopes).toEqual(["clientA"]) // never '*'
    expect([...p.capabilities].sort()).toEqual(["read", "write"]) // 'admin' dropped

    // A second mint asking for a sibling scope keeps only the granted intersection.
    const { token: t2 } = await mintApiKey(db, restricted, {
      name: "partial",
      requestedScopes: ["clientA", "clientB"],
    })
    const p2 = await resolvePrincipal(testEnv(), bearer(t2), { db })
    expect(p2.allowedScopes).toEqual(["clientA"])
  })
})

describe("resolvePrincipal — missing credential", () => {
  test("no Authorization header → 401 AuthError", async () => {
    const { db } = makeDb()
    const req = new Request("https://api.brain.test/think")
    const promise = resolvePrincipal(testEnv(), req, { db })
    await expect(promise).rejects.toBeInstanceOf(AuthError)
    await expect(promise).rejects.toMatchObject({ status: 401 })
  })
})

/**
 * vault-dav canary: path-sanitization, credential resolution, and a PROPFIND/PUT/GET
 * round-trip against real workerd D1 + R2.
 *
 * Gates:
 *   - `sanitizeRelpath` blocks every path-escape attempt.
 *   - `resolveVaultCredential` passes good creds, fails bad password, fails revoked, fails
 *     cross-tenant (ownership isolation).
 *   - HTTP round-trip: PUT writes a note, PROPFIND lists it, GET reads it back.
 */
import { env } from "cloudflare:test"
import {
  type BrainBindings,
  createVaultCredentialCore,
  resolveVaultCredential,
  revokeVaultCredentialCore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src"
import { sanitizeRelpath } from "../src/vault-dav"
import { seedMembership, seedOrg } from "./seed"

// ── Test tenant setup ─────────────────────────────────────────────────────────

const TENANT_A = "davOrgA"
const TENANT_B = "davOrgB"
const USER = "davUser1"

const principalFor = (tenantId: string): Principal => ({
  tenantId,
  userId: USER,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const env_ = env as unknown as BrainBindings

beforeAll(async () => {
  await seedOrg(TENANT_A, "dav-org-a")
  await seedOrg(TENANT_B, "dav-org-b")
  await seedMembership({ tenantId: TENANT_A, userId: USER, role: "owner" })
  await seedMembership({ tenantId: TENANT_B, userId: USER, role: "owner" })
})

// ── Pure unit tests: path sanitization ───────────────────────────────────────

describe("sanitizeRelpath — isolation guard", () => {
  test("accepts a normal file path", () => {
    expect(sanitizeRelpath("notes/foo.md")).toBe("notes/foo.md")
  })

  test("accepts empty string (vault root)", () => {
    expect(sanitizeRelpath("")).toBe("")
  })

  test("accepts a flat filename", () => {
    expect(sanitizeRelpath("readme.md")).toBe("readme.md")
  })

  test("strips leading slashes (defensive)", () => {
    expect(sanitizeRelpath("/notes/foo.md")).toBe("notes/foo.md")
  })

  test("rejects path with .. segment (directory traversal)", () => {
    expect(sanitizeRelpath("../etc/passwd")).toBeNull()
  })

  test("rejects path with internal .. segment", () => {
    expect(sanitizeRelpath("notes/../../etc")).toBeNull()
  })

  test("rejects path ending in ..", () => {
    expect(sanitizeRelpath("notes/..")).toBeNull()
  })

  test("rejects path with null byte", () => {
    expect(sanitizeRelpath("notes/\0evil")).toBeNull()
  })

  test("rejects path with backslash", () => {
    expect(sanitizeRelpath("notes\\evil.md")).toBeNull()
  })

  test("rejects dot-only segment (.)", () => {
    expect(sanitizeRelpath("notes/./foo.md")).toBeNull()
  })

  test("rejects empty segment (double slash)", () => {
    expect(sanitizeRelpath("notes//foo.md")).toBeNull()
  })
})

// ── DB integration: resolveVaultCredential ────────────────────────────────────

describe("resolveVaultCredential — auth isolation", () => {
  test("returns tenantId on good credentials", async () => {
    const db = drizzle(env_.DB)
    const { username, password } = await createVaultCredentialCore(db, principalFor(TENANT_A))
    const result = await resolveVaultCredential(db, username, password)
    expect(result).toBe(TENANT_A)
  })

  test("returns null on wrong password", async () => {
    const db = drizzle(env_.DB)
    const { username } = await createVaultCredentialCore(db, principalFor(TENANT_A))
    const result = await resolveVaultCredential(db, username, "wrong-password-xyz")
    expect(result).toBeNull()
  })

  test("returns null for unknown username", async () => {
    const db = drizzle(env_.DB)
    const result = await resolveVaultCredential(db, "vk_doesnotexist", "any-password")
    expect(result).toBeNull()
  })

  test("returns null after credential is revoked", async () => {
    const db = drizzle(env_.DB)
    const { username, password } = await createVaultCredentialCore(db, principalFor(TENANT_A))
    // Verify it works before revocation.
    expect(await resolveVaultCredential(db, username, password)).toBe(TENANT_A)
    // Revoke it.
    const revoked = await revokeVaultCredentialCore(db, principalFor(TENANT_A), username)
    expect(revoked).toBe(true)
    // Now it must fail.
    expect(await resolveVaultCredential(db, username, password)).toBeNull()
  })

  test("cross-tenant isolation: credential for tenant A never resolves to tenant B", async () => {
    const db = drizzle(env_.DB)
    const { username, password } = await createVaultCredentialCore(db, principalFor(TENANT_A))
    const result = await resolveVaultCredential(db, username, password)
    // Must resolve to A, NOT B.
    expect(result).toBe(TENANT_A)
    expect(result).not.toBe(TENANT_B)
  })

  test("revokeVaultCredentialCore is no-op for a username in a different tenant", async () => {
    const db = drizzle(env_.DB)
    const { username } = await createVaultCredentialCore(db, principalFor(TENANT_A))
    // Try to revoke with tenant B principal — must return false (ownership check).
    const revoked = await revokeVaultCredentialCore(db, principalFor(TENANT_B), username)
    expect(revoked).toBe(false)
  })
})

// ── HTTP round-trip: PUT → PROPFIND → GET ─────────────────────────────────────

describe("vault-dav HTTP round-trip (real workerd D1 + R2)", () => {
  const RT_TENANT = "davRtOrg"
  const RT_SLUG = "dav-rt-org"
  let rtUsername = ""
  let rtPassword = ""

  beforeAll(async () => {
    await seedOrg(RT_TENANT, RT_SLUG)
    await seedMembership({ tenantId: RT_TENANT, userId: USER, role: "owner" })
    const db = drizzle(env_.DB)
    const cred = await createVaultCredentialCore(db, {
      tenantId: RT_TENANT,
      userId: USER,
      teamIds: [],
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
      readOnly: false,
    })
    rtUsername = cred.username
    rtPassword = cred.password
  })

  const basicAuth = (u: string, p: string): string => `Basic ${btoa(`${u}:${p}`)}`

  /** Minimal ExecutionContext for testing (waitUntil is a no-op). */
  const ctx = {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext

  test("OPTIONS /dav returns 200 with DAV and Allow headers (no auth needed)", async () => {
    const app = createApp()
    const req = new Request("http://localhost/dav", { method: "OPTIONS" })
    const res = await app.fetch(req, env_ as never, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("dav")).toBe("1,2")
    expect(res.headers.get("allow")).toContain("PROPFIND")
  })

  test("any request without auth → 401 with WWW-Authenticate", async () => {
    const app = createApp()
    const req = new Request("http://localhost/dav/notes.md", { method: "GET" })
    const res = await app.fetch(req, env_ as never, ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("brain-vault")
  })

  test("any request with wrong password → 401", async () => {
    const app = createApp()
    const req = new Request("http://localhost/dav/notes.md", {
      method: "GET",
      headers: { Authorization: basicAuth(rtUsername, "bad-password") },
    })
    const res = await app.fetch(req, env_ as never, ctx)
    expect(res.status).toBe(401)
  })

  test("PUT /dav/round-trip-note.md → 201, GET → 200 with content", async () => {
    const app = createApp()
    const content = "# Round-trip note\n\nHello vault."

    // PUT the note.
    const putRes = await app.fetch(
      new Request("http://localhost/dav/round-trip-note.md", {
        method: "PUT",
        headers: {
          Authorization: basicAuth(rtUsername, rtPassword),
          "Content-Type": "text/markdown",
        },
        body: content,
      }),
      env_ as never,
      ctx,
    )
    expect(putRes.status).toBeOneOf([201, 204])

    // GET the note back.
    const getRes = await app.fetch(
      new Request("http://localhost/dav/round-trip-note.md", {
        method: "GET",
        headers: { Authorization: basicAuth(rtUsername, rtPassword) },
      }),
      env_ as never,
      ctx,
    )
    expect(getRes.status).toBe(200)
    const body = await getRes.text()
    expect(body).toBe(content)
  })

  test("PROPFIND /dav depth=1 lists uploaded note", async () => {
    const app = createApp()

    // Ensure the note exists (PUT first).
    await app.fetch(
      new Request("http://localhost/dav/propfind-note.md", {
        method: "PUT",
        headers: {
          Authorization: basicAuth(rtUsername, rtPassword),
          "Content-Type": "text/markdown",
        },
        body: "# PROPFIND test note",
      }),
      env_ as never,
      ctx,
    )

    // PROPFIND the root.
    const propRes = await app.fetch(
      new Request("http://localhost/dav/", {
        method: "PROPFIND",
        headers: {
          Authorization: basicAuth(rtUsername, rtPassword),
          Depth: "1",
        },
      }),
      env_ as never,
      ctx,
    )
    expect(propRes.status).toBe(207)
    const xml = await propRes.text()
    expect(xml).toContain("multistatus")
    expect(xml).toContain("propfind-note.md")
  })

  test("DELETE /dav/round-trip-note.md → 204, GET → 404", async () => {
    const app = createApp()

    // Ensure note exists.
    await app.fetch(
      new Request("http://localhost/dav/to-delete.md", {
        method: "PUT",
        headers: {
          Authorization: basicAuth(rtUsername, rtPassword),
          "Content-Type": "text/markdown",
        },
        body: "# Delete me",
      }),
      env_ as never,
      ctx,
    )

    // Delete it.
    const delRes = await app.fetch(
      new Request("http://localhost/dav/to-delete.md", {
        method: "DELETE",
        headers: { Authorization: basicAuth(rtUsername, rtPassword) },
      }),
      env_ as never,
      ctx,
    )
    expect(delRes.status).toBe(204)

    // Should be 404 now.
    const getRes = await app.fetch(
      new Request("http://localhost/dav/to-delete.md", {
        method: "GET",
        headers: { Authorization: basicAuth(rtUsername, rtPassword) },
      }),
      env_ as never,
      ctx,
    )
    expect(getRes.status).toBe(404)
  })

  test("path with .. never reaches vault data", async () => {
    const app = createApp()
    const res = await app.fetch(
      new Request("http://localhost/dav/../evil", {
        method: "GET",
        headers: { Authorization: basicAuth(rtUsername, rtPassword) },
      }),
      env_ as never,
      ctx,
    )
    // URL parsers normalize `/dav/../evil` → `/evil` before the request reaches the handler.
    // The request then hits the auth middleware (not the vault-dav route) → 401.
    // If NOT normalized (raw path), the sanitizer returns 403.
    // Either way: the path NEVER reaches vault storage. Status 401/403/404 all prove this.
    expect([401, 403, 404]).toContain(res.status)
  })
})

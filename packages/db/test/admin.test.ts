import { describe, expect, test } from "bun:test"
import { getTokenSpendCore, membershipsCore, mintApiKeyCore } from "../src/admin/ops"
import { AuthError } from "../src/auth/errors"
import { resolveApiKeyPrincipal } from "../src/auth/mint"
import { makeDb, principal } from "./helpers"

/**
 * Admin op cores (PRD §7.1/§9.2.2). Each is gated by `scopeSatisfied("admin", …)` and operates on
 * the tenant-scoped chokepoints — proven here against a bun:sqlite Drizzle DB:
 *   - `mint_api_key` never escalates past the minter (scopes + capabilities intersected DOWN).
 *   - `get_token_spend` reads ONLY the caller's tenant (tenant_id forced by `ScopedDB`).
 *   - `memberships` is owner/admin-only (a `member` fails CLOSED to 403).
 */

const adminP = (tenantId: string) =>
  principal({ tenantId, role: "owner", capabilities: ["read", "write", "admin"] })

describe("mint_api_key", () => {
  test("intersects scopes + capabilities DOWN to the minter (no escalation)", async () => {
    const { db } = makeDb()
    const minter = principal({
      tenantId: "t1",
      role: "admin",
      allowedScopes: ["a", "b"],
      capabilities: ["read", "write", "admin"],
    })
    // Request the WORLD (`*` scopes + admin caps); the minter caps it to its own finite grant.
    const { token } = await mintApiKeyCore(db, minter, {
      name: "k",
      requestedScopes: "*",
      requestedCapabilities: ["read", "write", "admin"],
    })
    const resolved = await resolveApiKeyPrincipal(db, token)
    expect(resolved).not.toBeNull()
    expect(resolved?.allowedScopes).toEqual(["a", "b"]) // NOT "*"
    expect(resolved?.capabilities).toEqual(["read", "write", "admin"])
  })

  test("a restricted minter cannot widen scopes it does not hold", async () => {
    const { db } = makeDb()
    const minter = principal({
      tenantId: "t1",
      role: "admin",
      allowedScopes: ["a"],
      capabilities: ["read", "write", "admin"],
    })
    const { token } = await mintApiKeyCore(db, minter, {
      name: "k2",
      requestedScopes: ["a", "z"], // 'z' is outside the minter's grant → dropped
    })
    const resolved = await resolveApiKeyPrincipal(db, token)
    expect(resolved?.allowedScopes).toEqual(["a"])
  })

  test("a non-admin caller is denied (403)", async () => {
    const { db } = makeDb()
    const member = principal({ tenantId: "t1", role: "member", capabilities: ["read", "write"] })
    const err = await mintApiKeyCore(db, member, { name: "x" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).status).toBe(403)
  })
})

describe("get_token_spend", () => {
  test("sums ONLY the caller's tenant for the window", async () => {
    const { sqlite, db } = makeDb()
    // Distinct models per row (the ledger is keyed UNIQUE on tenant+window+model); the spend read
    // sums across models for the window.
    const row = (id: string, tenant: string, model: string, neurons: number) =>
      sqlite.run(
        `INSERT INTO token_spend (id, tenant_id, window, model, neurons, updated_at)
         VALUES (?, ?, '2026-06', ?, ?, '2026-06-25T00:00:00.000Z')`,
        [id, tenant, model, neurons],
      )
    row("s1", "t1", "@cf/baai/bge-m3", 1000)
    row("s2", "t1", "@cf/meta/llama-3.3-70b", 500)
    row("s3", "t2", "@cf/baai/bge-m3", 9999) // another tenant — must NOT be counted

    const out = await getTokenSpendCore(db, adminP("t1"), { window: "2026-06" })
    expect(out.window).toBe("2026-06")
    expect(out.neurons).toBe(1500)
    expect(out.usd).toBeCloseTo(1500 * (0.011 / 1000))
    expect(out.ceilingUsd).toBe(400)
  })

  test("a non-admin caller is denied (403)", async () => {
    const { db } = makeDb()
    const member = principal({ tenantId: "t1", role: "member", capabilities: ["read", "write"] })
    const err = await getTokenSpendCore(db, member, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
  })
})

describe("memberships", () => {
  test("lists the caller's tenant and is owner/admin-only", async () => {
    const { sqlite, db } = makeDb()
    const mem = (id: string, tenant: string, user: string, role: string) =>
      sqlite.run(
        `INSERT INTO memberships (id, tenant_id, user_id, role, allowed_scopes)
         VALUES (?, ?, ?, ?, NULL)`,
        [id, tenant, user, role],
      )
    mem("m1", "t1", "userA", "owner")
    mem("m2", "t1", "userB", "member")
    mem("m3", "t2", "userC", "owner") // another tenant — must NOT appear

    const out = await membershipsCore(db, adminP("t1"), {})
    expect(out.memberships.map((m) => m.userId).sort()).toEqual(["userA", "userB"])

    const member = principal({ tenantId: "t1", role: "member", capabilities: ["read", "write"] })
    const err = await membershipsCore(db, member, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
  })
})

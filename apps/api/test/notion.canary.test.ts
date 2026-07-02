import { env } from "cloudflare:test"
import {
  type BrainBindings,
  createNotionConnectionCore,
  disconnectNotionOp,
  getActiveConnectionByWorkspaceCore,
  getDecryptedAccessTokenCore,
  listNotionConnectionsCore,
  listNotionConnectionsOp,
  NotionWorkspaceConflictError,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { seedMembership, seedOrg } from "./seed"

/**
 * Phase-8 Notion connection-store canary — proves the security invariants of the reversed-direction
 * token store against REAL local D1 in workerd:
 *   - tokens are stored ENCRYPTED (ciphertext in the row) and NEVER surface in a list/status op;
 *   - `workspace_id → tenant` resolution is tenant-isolated and fail-closed on revoke;
 *   - a workspace already connected to another tenant is REJECTED (no cross-tenant takeover);
 *   - mutating ops audit; management ops fail closed without admin capability.
 * All are non-vacuous: the raw ciphertext row + the plaintext round-trip are both asserted.
 */

const env_ = env as unknown as BrainBindings
const ENC_KEY = "canary-notion-enc-key"

const TENANT_A = "notion-tA"
const TENANT_B = "notion-tB"
const WS_A = "ws-alpha"
const WS_B = "ws-beta"
const TOKEN_A = "ntn_secret_alpha_token"
const TOKEN_B = "ntn_secret_beta_token"

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: TENANT_A,
  userId: "userA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["admin"],
  readOnly: false,
  ...overrides,
})

const pA = principal({ tenantId: TENANT_A, userId: "userA" })
const pB = principal({ tenantId: TENANT_B, userId: "userB" })

const auditCount = async (tenantId: string, action: string): Promise<number> => {
  const res = await env_.DB.prepare(
    "SELECT COUNT(*) AS n FROM memory_audit WHERE tenant_id = ? AND action = ?",
  )
    .bind(tenantId, action)
    .first<{ n: number }>()
  return res?.n ?? 0
}

const rawCiphertext = async (workspaceId: string): Promise<string | null> => {
  const res = await env_.DB.prepare(
    "SELECT token_ciphertext FROM notion_connections WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first<{ token_ciphertext: string }>()
  return res?.token_ciphertext ?? null
}

describe("notion connection store canary", () => {
  beforeAll(async () => {
    await seedOrg(TENANT_A, "notion-org-a")
    await seedOrg(TENANT_B, "notion-org-b")
    await seedMembership({ tenantId: TENANT_A, userId: "userA" })
    await seedMembership({ tenantId: TENANT_B, userId: "userB" })
  })

  test("connect stores an ENCRYPTED token and round-trips via the tenant-scoped decrypt", async () => {
    const db = drizzle(env_.DB)
    const row = await createNotionConnectionCore(
      db,
      pA,
      { workspaceId: WS_A, workspaceName: "Alpha WS", botId: "bot-a", accessToken: TOKEN_A },
      ENC_KEY,
    )
    expect(row).toEqual({
      workspaceId: WS_A,
      workspaceName: "Alpha WS",
      botId: "bot-a",
      createdAt: expect.any(String),
      revokedAt: null,
    })

    // Non-vacuous: the persisted ciphertext exists and is NOT the plaintext token.
    const cipher = await rawCiphertext(WS_A)
    expect(cipher).not.toBeNull()
    expect(cipher).not.toContain(TOKEN_A)

    // The tenant-scoped decrypt recovers the original token.
    expect(await getDecryptedAccessTokenCore(db, pA, WS_A, ENC_KEY)).toBe(TOKEN_A)
  })

  test("list + status ops NEVER return token material", async () => {
    const db = drizzle(env_.DB)
    const rows = await listNotionConnectionsCore(db, pA)
    expect(rows.length).toBe(1)
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(TOKEN_A)
    expect(serialized).not.toContain("ciphertext")
    expect(rows[0]).toEqual({
      workspaceId: WS_A,
      workspaceName: "Alpha WS",
      botId: "bot-a",
      createdAt: expect.any(String),
      revokedAt: null,
    })

    const opOut = await listNotionConnectionsOp.handler({ env: env_, principal: pA }, {})
    expect(JSON.stringify(opOut)).not.toContain(TOKEN_A)
  })

  test("workspace→tenant resolution is tenant-isolated", async () => {
    const db = drizzle(env_.DB)
    await createNotionConnectionCore(
      db,
      pB,
      { workspaceId: WS_B, workspaceName: "Beta WS", botId: "bot-b", accessToken: TOKEN_B },
      ENC_KEY,
    )

    // Each workspace resolves ONLY to its owning tenant.
    expect(await getActiveConnectionByWorkspaceCore(db, WS_A)).toEqual({
      tenantId: TENANT_A,
      botId: "bot-a",
    })
    expect(await getActiveConnectionByWorkspaceCore(db, WS_B)).toEqual({
      tenantId: TENANT_B,
      botId: "bot-b",
    })

    // Tenant A's list never includes tenant B's workspace.
    const aRows = await listNotionConnectionsCore(db, pA)
    expect(aRows.map((r) => r.workspaceId)).toEqual([WS_A])

    // Tenant A cannot decrypt tenant B's token (scoped decrypt returns null).
    expect(await getDecryptedAccessTokenCore(db, pA, WS_B, ENC_KEY)).toBeNull()
  })

  test("a workspace owned by another tenant cannot be taken over", async () => {
    const db = drizzle(env_.DB)
    await expect(
      createNotionConnectionCore(
        db,
        pB,
        { workspaceId: WS_A, accessToken: "ntn_attacker_token" },
        ENC_KEY,
      ),
    ).rejects.toBeInstanceOf(NotionWorkspaceConflictError)
    // The original owner's token is untouched.
    expect(await getActiveConnectionByWorkspaceCore(db, WS_A)).toEqual({
      tenantId: TENANT_A,
      botId: "bot-a",
    })
  })

  test("disconnect stops sync: resolution + decrypt fail closed, list retains audit trail", async () => {
    const db = drizzle(env_.DB)
    const out = await disconnectNotionOp.handler(
      { env: env_, principal: pA },
      { workspaceId: WS_A },
    )
    expect(out).toEqual({ revoked: true })

    // Fail-closed after revoke: no workspace routing, no usable token.
    expect(await getActiveConnectionByWorkspaceCore(db, WS_A)).toBeNull()
    expect(await getDecryptedAccessTokenCore(db, pA, WS_A, ENC_KEY)).toBeNull()

    // The row survives (soft revoke) with revokedAt set — audit history preserved.
    const rows = await listNotionConnectionsCore(db, pA)
    expect(rows[0]?.revokedAt).toEqual(expect.any(String))

    // A second disconnect is an idempotent no-op.
    const again = await disconnectNotionOp.handler(
      { env: env_, principal: pA },
      { workspaceId: WS_A },
    )
    expect(again).toEqual({ revoked: false })
  })

  test("mutations write audit rows; non-admins are rejected", async () => {
    expect(await auditCount(TENANT_A, "notion_connection.create")).toBeGreaterThanOrEqual(1)
    expect(await auditCount(TENANT_A, "notion_connection.revoke")).toBe(1)

    const reader = principal({ tenantId: TENANT_A, capabilities: ["read"] })
    await expect(
      listNotionConnectionsOp.handler({ env: env_, principal: reader }, {}),
    ).rejects.toThrow()
    await expect(
      disconnectNotionOp.handler({ env: env_, principal: reader }, { workspaceId: WS_A }),
    ).rejects.toThrow()
  })
})

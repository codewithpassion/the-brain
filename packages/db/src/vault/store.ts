/**
 * Vault credential store — create/list/revoke/resolve hashed WebDAV credentials.
 *
 * Auth boundary contract:
 *   - `secret_hash = SHA-256(password)` is the ONLY form ever persisted.
 *   - The raw password is returned ONCE from `createVaultCredentialCore` and never stored.
 *   - `resolveVaultCredential` accepts a raw `BrainDrizzle` handle (called PRE-auth, before any
 *     `Principal` exists — it is the gate that establishes the Principal from Basic creds).
 *   - Every mutating method forces `tenant_id = p.tenantId` from the Principal and audits in-batch.
 */
import type { Principal } from "@brain/shared"
import { and, eq, isNull } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { randomToken, sha256Hex } from "../auth/tokens"
import { commitBatch } from "../batch"
import type { BrainBindings } from "../env"
import { memoryAudit, vaultCredentials } from "../schema"
import type { BrainDrizzle } from "../scoped/db"

// ── Local crypto helpers ──────────────────────────────────────────────────────

/** Generate a `vk_<16 hex>` username from 8 cryptographically-random bytes. */
const generateUsername = (): string => {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `vk_${hex}`
}

// ── Public types ──────────────────────────────────────────────────────────────

/** One listed credential row (secret_hash is NEVER included). */
export interface VaultCredentialRow {
  username: string
  label: string | null
  createdAt: string
  revokedAt: string | null
}

/** The result of a successful `createVaultCredentialCore` call (password shown ONCE). */
export interface CreatedVaultCredential {
  username: string
  /** 32-byte base64url password — shown ONCE. Never stored. */
  password: string
}

// ── Store methods ─────────────────────────────────────────────────────────────

/**
 * Create a vault credential for the caller's tenant. Generates a `vk_<16 hex>` username and a
 * 32-byte base64url password, stores `SHA-256(password)` only, and audits in the same batch.
 * Returns `{ username, password }` — the caller MUST surface the password to the user now.
 */
export const createVaultCredentialCore = async (
  db: BrainDrizzle,
  p: Principal,
  label?: string,
): Promise<CreatedVaultCredential> => {
  const username = generateUsername()
  // randomToken("") generates 32 cryptographically-random bytes as base64url (no prefix).
  const password = randomToken("")
  const secretHash = await sha256Hex(password)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  const insert = db.insert(vaultCredentials).values({
    id,
    tenantId: p.tenantId, // forced — never caller-supplied
    username,
    secretHash,
    label: label ?? null,
    createdAt: now,
    createdBy: p.userId, // authorship forced
  })

  const audit = db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: p.tenantId, // forced
    userId: p.userId,
    action: "vault_credential.create",
    targetId: username,
    at: Date.now(),
  })

  await commitBatch(db, [insert, audit])
  return { username, password }
}

/** List vault credentials for the caller's tenant. Never returns `secret_hash`. */
export const listVaultCredentialsCore = async (
  db: BrainDrizzle,
  p: Principal,
): Promise<VaultCredentialRow[]> => {
  const rows = await db
    .select({
      username: vaultCredentials.username,
      label: vaultCredentials.label,
      createdAt: vaultCredentials.createdAt,
      revokedAt: vaultCredentials.revokedAt,
    })
    .from(vaultCredentials)
    .where(eq(vaultCredentials.tenantId, p.tenantId))
  return rows.map((r) => ({
    username: r.username,
    label: r.label ?? null,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt ?? null,
  }))
}

/**
 * Revoke a vault credential by `username` (tenant-scoped — only revokes if tenant matches).
 * Audited in-batch. Returns `true` when revoked, `false` when not found in this tenant.
 */
export const revokeVaultCredentialCore = async (
  db: BrainDrizzle,
  p: Principal,
  username: string,
): Promise<boolean> => {
  const existing = await db
    .select({ id: vaultCredentials.id })
    .from(vaultCredentials)
    .where(and(eq(vaultCredentials.tenantId, p.tenantId), eq(vaultCredentials.username, username)))
    .limit(1)

  if (existing.length === 0) return false

  const now = new Date().toISOString()
  const update = db
    .update(vaultCredentials)
    .set({ revokedAt: now })
    .where(and(eq(vaultCredentials.tenantId, p.tenantId), eq(vaultCredentials.username, username)))

  const audit = db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: p.tenantId,
    userId: p.userId,
    action: "vault_credential.revoke",
    targetId: username,
    at: Date.now(),
  })

  await commitBatch(db, [update, audit])
  return true
}

/**
 * Resolve a vault credential for WebDAV Basic auth (PRE-auth — called before any `Principal`
 * exists). Looks up by `username`, checks `revoked_at IS NULL`, SHA-256 compares the password.
 * Returns the `tenantId` on success or `null` on any failure (wrong password, revoked, unknown).
 *
 * Accepts a raw `BrainDrizzle` handle — call `resolveVaultCredentialFromEnv` from outside
 * `@brain/db` to keep raw binding access inside this package (invariant 2).
 */
export const resolveVaultCredential = async (
  db: BrainDrizzle,
  username: string,
  password: string,
): Promise<string | null> => {
  const rows = await db
    .select({
      tenantId: vaultCredentials.tenantId,
      secretHash: vaultCredentials.secretHash,
    })
    .from(vaultCredentials)
    .where(and(eq(vaultCredentials.username, username), isNull(vaultCredentials.revokedAt)))
    .limit(1)

  const row = rows[0]
  // Hash unconditionally (no early return on unknown username — removes an enumeration
  // timing side-channel) and compare in constant time over the fixed-length hex.
  const inputHash = await sha256Hex(password)
  const expected = row?.secretHash ?? "0".repeat(inputHash.length)
  const match = timingSafeEqualHex(inputHash, expected)
  if (row === undefined || !match) return null

  return row.tenantId
}

/** Constant-time comparison of two equal-length hex strings (no early-exit on first diff). */
const timingSafeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Convenience wrapper for callers outside `@brain/db` — builds the `BrainDrizzle` from the raw
 * `BrainBindings.DB` binding (legal inside `packages/db`, invariant 2) and delegates to
 * `resolveVaultCredential`. The raw binding never escapes this file.
 */
export const resolveVaultCredentialFromEnv = async (
  env: BrainBindings,
  username: string,
  password: string,
): Promise<string | null> => {
  const db = drizzle(env.DB)
  return resolveVaultCredential(db, username, password)
}

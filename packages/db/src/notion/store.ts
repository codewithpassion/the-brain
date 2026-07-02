/**
 * Notion connection store — create/list/revoke/resolve encrypted per-tenant Notion OAuth tokens
 * (docs/notion-integration-plan.md §2, §7).
 *
 * Security contract (mirrors `vault/store.ts`, adapted for a REVERSIBLE token):
 *   - `token_ciphertext`/`refresh_token_ciphertext` = AES-GCM(token) is the ONLY stored form;
 *     the plaintext is never persisted, logged, or returned from a list/status op.
 *   - Every mutating method forces `tenant_id = p.tenantId` from the Principal and audits in-batch.
 *   - `getActiveConnectionByWorkspaceCore` is the ONE deliberate cross-tenant read (webhook
 *     `workspace_id → tenant` routing) — it takes a raw `BrainDrizzle` handle, like
 *     `resolveVaultCredential`, and is called BEFORE a Principal exists.
 *   - `workspace_id` is globally unique: a workspace already connected to another tenant is
 *     REJECTED (fail-closed) rather than silently re-homed (cross-tenant takeover guard).
 */
import type { Principal } from "@brain/shared"
import { and, eq, isNull } from "drizzle-orm"
import { commitBatch } from "../batch"
import { memoryAudit, notionConnections } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { decryptToken, encryptToken } from "./crypto"

// ── Public types ──────────────────────────────────────────────────────────────

/** One listed connection row — NO ciphertext / token field is ever included. */
export interface NotionConnectionRow {
  workspaceId: string
  workspaceName: string | null
  botId: string | null
  createdAt: string
  revokedAt: string | null
}

/** The token grant persisted on connect (from the Notion OAuth token exchange). */
export interface NotionConnectionInput {
  workspaceId: string
  workspaceName?: string | null
  botId?: string | null
  accessToken: string
  refreshToken?: string | null
}

/** A resolved active connection for webhook routing (no token material). */
export interface ResolvedNotionConnection {
  tenantId: string
  botId: string | null
}

/** Thrown when a workspace is already connected to a DIFFERENT tenant (fail-closed). */
export class NotionWorkspaceConflictError extends Error {
  constructor() {
    super("notion: workspace is already connected to another tenant")
    this.name = "NotionWorkspaceConflictError"
  }
}

// ── Store methods ─────────────────────────────────────────────────────────────

/**
 * Persist (or refresh) a Notion connection for the caller's tenant. Encrypts the access/refresh
 * tokens under `encKey` and stores only the ciphertext. Re-connect by the SAME tenant refreshes
 * the tokens and clears `revoked_at`; a workspace owned by a DIFFERENT tenant is rejected.
 * Audited in-batch. Returns the non-secret row shape.
 */
export const createNotionConnectionCore = async (
  db: BrainDrizzle,
  p: Principal,
  input: NotionConnectionInput,
  encKey: string,
): Promise<NotionConnectionRow> => {
  const existing = await db
    .select({ id: notionConnections.id, tenantId: notionConnections.tenantId })
    .from(notionConnections)
    .where(eq(notionConnections.workspaceId, input.workspaceId))
    .limit(1)

  const prior = existing[0]
  if (prior !== undefined && prior.tenantId !== p.tenantId) {
    throw new NotionWorkspaceConflictError()
  }

  const tokenCiphertext = await encryptToken(encKey, input.accessToken)
  const refreshTokenCiphertext =
    input.refreshToken != null ? await encryptToken(encKey, input.refreshToken) : null
  const now = new Date().toISOString()
  const workspaceName = input.workspaceName ?? null
  const botId = input.botId ?? null

  const write =
    prior === undefined
      ? db.insert(notionConnections).values({
          id: crypto.randomUUID(),
          tenantId: p.tenantId, // forced — never caller-supplied
          workspaceId: input.workspaceId,
          workspaceName,
          botId,
          tokenCiphertext,
          refreshTokenCiphertext,
          createdBy: p.userId, // authorship forced
          createdAt: now,
        })
      : db
          .update(notionConnections)
          .set({
            workspaceName,
            botId,
            tokenCiphertext,
            refreshTokenCiphertext,
            revokedAt: null, // re-connect resurrects
          })
          .where(
            and(
              eq(notionConnections.tenantId, p.tenantId),
              eq(notionConnections.workspaceId, input.workspaceId),
            ),
          )

  const audit = db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: p.tenantId, // forced
    userId: p.userId,
    action: "notion_connection.create",
    targetId: input.workspaceId,
    at: Date.now(),
  })

  await commitBatch(db, [write, audit])
  return { workspaceId: input.workspaceId, workspaceName, botId, createdAt: now, revokedAt: null }
}

/** List this tenant's Notion connections. Never returns any ciphertext / token. */
export const listNotionConnectionsCore = async (
  db: BrainDrizzle,
  p: Principal,
): Promise<NotionConnectionRow[]> => {
  const rows = await db
    .select({
      workspaceId: notionConnections.workspaceId,
      workspaceName: notionConnections.workspaceName,
      botId: notionConnections.botId,
      createdAt: notionConnections.createdAt,
      revokedAt: notionConnections.revokedAt,
    })
    .from(notionConnections)
    .where(eq(notionConnections.tenantId, p.tenantId))
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName ?? null,
    botId: r.botId ?? null,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt ?? null,
  }))
}

/**
 * Soft-revoke a Notion connection by `workspaceId` (tenant-scoped). Audited in-batch. Returns
 * `true` when revoked, `false` when not found in this tenant / already revoked.
 */
export const revokeNotionConnectionCore = async (
  db: BrainDrizzle,
  p: Principal,
  workspaceId: string,
): Promise<boolean> => {
  const existing = await db
    .select({ id: notionConnections.id })
    .from(notionConnections)
    .where(
      and(
        eq(notionConnections.tenantId, p.tenantId),
        eq(notionConnections.workspaceId, workspaceId),
        isNull(notionConnections.revokedAt),
      ),
    )
    .limit(1)

  if (existing.length === 0) return false

  const now = new Date().toISOString()
  const update = db
    .update(notionConnections)
    .set({ revokedAt: now })
    .where(
      and(
        eq(notionConnections.tenantId, p.tenantId),
        eq(notionConnections.workspaceId, workspaceId),
      ),
    )

  const audit = db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: p.tenantId,
    userId: p.userId,
    action: "notion_connection.revoke",
    targetId: workspaceId,
    at: Date.now(),
  })

  await commitBatch(db, [update, audit])
  return true
}

/**
 * Resolve the tenant that owns an active connection for `workspaceId` (webhook routing). Raw
 * `BrainDrizzle` handle — called PRE-auth (before any Principal), like `resolveVaultCredential`.
 * Returns `null` for unknown / revoked workspaces (fail-closed). No token material is returned.
 */
export const getActiveConnectionByWorkspaceCore = async (
  db: BrainDrizzle,
  workspaceId: string,
): Promise<ResolvedNotionConnection | null> => {
  const rows = await db
    .select({ tenantId: notionConnections.tenantId, botId: notionConnections.botId })
    .from(notionConnections)
    .where(and(eq(notionConnections.workspaceId, workspaceId), isNull(notionConnections.revokedAt)))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return { tenantId: row.tenantId, botId: row.botId ?? null }
}

/**
 * Decrypt the active access token for a tenant's workspace (used by the poller/consumer to call
 * Notion). Tenant-scoped: only returns a token for a live connection owned by `p.tenantId`.
 * Returns `null` when no active connection exists. The plaintext is used transiently and never
 * logged/returned to a caller boundary.
 */
export const getDecryptedAccessTokenCore = async (
  db: BrainDrizzle,
  p: Principal,
  workspaceId: string,
  encKey: string,
): Promise<string | null> => {
  const rows = await db
    .select({ tokenCiphertext: notionConnections.tokenCiphertext })
    .from(notionConnections)
    .where(
      and(
        eq(notionConnections.tenantId, p.tenantId),
        eq(notionConnections.workspaceId, workspaceId),
        isNull(notionConnections.revokedAt),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return decryptToken(encKey, row.tokenCiphertext)
}

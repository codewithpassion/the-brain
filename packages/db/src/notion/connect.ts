/**
 * Notion connect completion (docs/notion-integration-plan.md §2) — the env-level helper the public
 * `/notion/callback` route calls after exchanging the OAuth code. Keeps raw `env.DB` access inside
 * `@brain/db` (invariant 2): the callback route hands us the token grant + the tenant (recovered
 * from the one-time OAuth nonce) and we persist the encrypted connection + a `kind:"notion"`
 * `sources` row that drives the cron poller.
 */
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { SourceStore } from "../backfill/sources"
import type { BrainBindings } from "../env"
import {
  createNotionConnectionCore,
  getActiveConnectionByWorkspaceCore,
  getDecryptedAccessTokenCore,
  type NotionConnectionInput,
  type ResolvedNotionConnection,
} from "./store"

/** Deterministic `sources.id` for a Notion workspace — lets connect/disconnect address it O(1). */
export const notionSourceId = (workspaceId: string): string => `notion:${workspaceId}`

/**
 * Persist a completed Notion OAuth grant under the AUTHENTICATED `principal` (the admin who
 * confirmed the connection): store the encrypted connection + ensure the `kind:"notion"` source row
 * (config `{workspaceId}`) the poll sweep reads. All writes are tenant-scoped to `principal.tenantId`
 * (never a hand-rolled owner/admin system principal). Throws if the encryption key is unset or the
 * workspace belongs to another tenant (`NotionWorkspaceConflictError` from the store).
 */
export const completeNotionConnection = async (
  env: BrainBindings,
  principal: Principal,
  grant: NotionConnectionInput,
): Promise<void> => {
  const encKey = env.NOTION_TOKEN_ENC_KEY
  if (!encKey) throw new Error("notion: NOTION_TOKEN_ENC_KEY not configured")
  const db = drizzle(env.DB)

  await createNotionConnectionCore(db, principal, grant, encKey)

  const sources = new SourceStore(db, principal)
  await sources.create({
    id: notionSourceId(grant.workspaceId),
    name: grant.workspaceName ?? grant.workspaceId,
    kind: "notion",
    config: JSON.stringify({ workspaceId: grant.workspaceId }),
  })
}

/**
 * Decrypt the active Notion access token for a tenant's workspace (poll/consumer use). Returns
 * `null` when the key is unset or no active connection exists — the caller then no-ops. Keeps raw
 * `env.DB` inside `@brain/db`.
 */
export const getNotionAccessTokenFromEnv = async (
  env: BrainBindings,
  principal: Principal,
  workspaceId: string,
): Promise<string | null> => {
  const encKey = env.NOTION_TOKEN_ENC_KEY
  if (!encKey) return null
  const db = drizzle(env.DB)
  return getDecryptedAccessTokenCore(db, principal, workspaceId, encKey)
}

/**
 * Resolve the tenant that owns an active connection for `workspaceId` (webhook routing). Raw
 * `env.DB` inside `@brain/db`; fail-closed (`null`) for unknown/revoked workspaces. No token.
 */
export const resolveNotionWorkspaceFromEnv = async (
  env: BrainBindings,
  workspaceId: string,
): Promise<ResolvedNotionConnection | null> => {
  const db = drizzle(env.DB)
  return getActiveConnectionByWorkspaceCore(db, workspaceId)
}

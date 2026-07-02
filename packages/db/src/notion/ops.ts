/**
 * Notion connection op CONTRACTS + bound handlers (docs/notion-integration-plan.md §2).
 *
 * Two `capability: "admin"` ops in this chunk gate the connection lifecycle's management surface:
 *   - `list_notion_connections` — list this tenant's connections (NO token material).
 *   - `disconnect_notion`       — soft-revoke a connection by workspace id (stops sync).
 *
 * `connect_notion` (starts the OAuth redirect) ships with the OAuth routes in a later chunk.
 * All ops are `AdminBoundOp`-shaped (`{ env, principal }` context) so the surface catalog
 * projects them via `adminSurfaceOp` alongside the vault/admin families.
 */
import {
  type AnyOpDef,
  defineOp,
  type OpRegistry,
  type Principal,
  scopeSatisfied,
} from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"
import { AuthError } from "../auth/errors"
import { randomToken } from "../auth/tokens"
import { SourceStore } from "../backfill/sources"
import type { BrainBindings } from "../env"
import { completeNotionConnection, notionSourceId } from "./connect"
import { decryptToken } from "./crypto"
import {
  buildNotionAuthorizeUrl,
  deleteNotionPendingGrant,
  peekNotionPendingGrant,
  storeNotionOAuthNonce,
} from "./oauth"
import { listNotionConnectionsCore, revokeNotionConnectionCore } from "./store"

// ── Capability guard ──────────────────────────────────────────────────────────

/** Fail CLOSED with 403 when the principal lacks admin capability. */
const assertAdmin = (principal: Principal): void => {
  if (!scopeSatisfied("admin", principal)) {
    throw new AuthError(403, "admin capability required for Notion connection management")
  }
}

// ── Op contracts ──────────────────────────────────────────────────────────────

/** `connect_notion` — start the OAuth flow; returns an authorize URL to open in the browser. */
export const CONNECT_NOTION_OP = defineOp({
  name: "connect_notion",
  description:
    "Begin connecting a Notion workspace. Returns an authorize URL to open in the browser to grant " +
    "the Brain access; complete the consent in Notion. Returns configured:false when the Notion " +
    "integration is not configured on this deployment.",
  capability: "admin",
  readOnly: false,
  input: z.object({}),
  output: z.object({ configured: z.boolean(), authorizeUrl: z.string().optional() }),
})

/** `confirm_notion_connection` — the same-principal confirmation that actually persists the grant. */
export const CONFIRM_NOTION_CONNECTION_OP = defineOp({
  name: "confirm_notion_connection",
  description:
    "Confirm and persist a pending Notion connection (from the OAuth callback) by its confirm token. " +
    "Only an admin of the SAME tenant the connect flow was started for may confirm — the login-CSRF guard.",
  capability: "admin",
  readOnly: false,
  input: z.object({
    confirmToken: z.string().describe("The confirm token from the /notion callback redirect."),
  }),
  output: z.object({
    confirmed: z.boolean(),
    workspaceId: z.string().optional(),
    workspaceName: z.string().nullable().optional(),
  }),
})

/** `list_notion_connections` — list tenant connections without any token material. */
export const LIST_NOTION_CONNECTIONS_OP = defineOp({
  name: "list_notion_connections",
  description:
    "List this tenant's Notion workspace connections (workspace, bot, connect/revoke timestamps) " +
    "without any token. Includes revoked connections. Use to find a workspace id before disconnect_notion.",
  capability: "admin",
  readOnly: true,
  input: z.object({}),
  output: z.object({
    connections: z.array(
      z.object({
        workspaceId: z.string(),
        workspaceName: z.string().nullable(),
        botId: z.string().nullable(),
        createdAt: z.string(),
        revokedAt: z.string().nullable(),
      }),
    ),
  }),
})

/** `disconnect_notion` — soft-revoke a Notion connection by workspace id (stops sync). */
export const DISCONNECT_NOTION_OP = defineOp({
  name: "disconnect_notion",
  description:
    "Disconnect a Notion workspace by workspace id. Soft-revokes the stored token so sync stops. " +
    "No-op if not in this tenant or already revoked. Use list_notion_connections to find the id.",
  capability: "admin",
  readOnly: false,
  input: z.object({
    workspaceId: z.string().describe("The Notion workspace id from list_notion_connections."),
  }),
  output: z.object({ revoked: z.boolean() }),
})

// ── Op context + bound-handler shape (matches AdminBoundOp) ─────────────────────

export interface NotionOpContext {
  env: BrainBindings
  principal: Principal
}

export interface NotionBoundOp<I, O> {
  def: AnyOpDef
  handler: (ctx: NotionOpContext, input: I) => Promise<O>
}

// ── Bound handlers ────────────────────────────────────────────────────────────

export const connectNotionOp: NotionBoundOp<
  Record<string, never>,
  { configured: boolean; authorizeUrl?: string }
> = {
  def: CONNECT_NOTION_OP,
  handler: async (ctx, _input) => {
    assertAdmin(ctx.principal)
    const clientId = ctx.env.NOTION_CLIENT_ID
    if (!clientId) return { configured: false }
    // Mint a one-time CSRF nonce bound to this tenant; the public callback consumes it to recover
    // the tenant (the browser redirect carries no bearer). The nonce is the tenant binding.
    const nonce = randomToken("")
    await storeNotionOAuthNonce(ctx.env, nonce, ctx.principal.tenantId)
    return { configured: true, authorizeUrl: buildNotionAuthorizeUrl(clientId, nonce) }
  },
}

export const confirmNotionConnectionOp: NotionBoundOp<
  { confirmToken: string },
  { confirmed: boolean; workspaceId?: string; workspaceName?: string | null }
> = {
  def: CONFIRM_NOTION_CONNECTION_OP,
  handler: async (ctx, input) => {
    assertAdmin(ctx.principal)
    // PEEK (no delete): a mismatched/failed confirm must NOT burn the token — the legitimate tenant
    // can still confirm. We delete ONLY after the grant is successfully persisted.
    const pending = await peekNotionPendingGrant(ctx.env, input.confirmToken)
    if (pending === null) return { confirmed: false } // expired / unknown / already used

    // The LOAD-BEARING login-CSRF guard: only an admin of the tenant the connect flow was started
    // for (bound into the pending grant via the one-time nonce) may persist it. Leave the grant in
    // place on a mismatch (defense-in-depth: no token burn for the real tenant).
    if (pending.tenantId !== ctx.principal.tenantId) {
      throw new AuthError(403, "notion: connection is bound to a different workspace")
    }
    const encKey = ctx.env.NOTION_TOKEN_ENC_KEY
    if (!encKey) return { confirmed: false }

    const accessToken = await decryptToken(encKey, pending.accessTokenCipher)
    const refreshToken =
      pending.refreshTokenCipher !== null
        ? await decryptToken(encKey, pending.refreshTokenCipher)
        : null
    await completeNotionConnection(ctx.env, ctx.principal, {
      workspaceId: pending.workspaceId,
      workspaceName: pending.workspaceName,
      botId: pending.botId,
      accessToken,
      ...(refreshToken !== null ? { refreshToken } : {}),
    })
    // Persisted — now consume the one-time grant. (A persist throw above leaves it retryable.)
    await deleteNotionPendingGrant(ctx.env, input.confirmToken)
    return {
      confirmed: true,
      workspaceId: pending.workspaceId,
      workspaceName: pending.workspaceName,
    }
  },
}

export const listNotionConnectionsOp: NotionBoundOp<
  Record<string, never>,
  {
    connections: {
      workspaceId: string
      workspaceName: string | null
      botId: string | null
      createdAt: string
      revokedAt: string | null
    }[]
  }
> = {
  def: LIST_NOTION_CONNECTIONS_OP,
  handler: async (ctx, _input) => {
    assertAdmin(ctx.principal)
    const db = drizzle(ctx.env.DB)
    const connections = await listNotionConnectionsCore(db, ctx.principal)
    return { connections }
  },
}

export const disconnectNotionOp: NotionBoundOp<{ workspaceId: string }, { revoked: boolean }> = {
  def: DISCONNECT_NOTION_OP,
  handler: async (ctx, input) => {
    assertAdmin(ctx.principal)
    const db = drizzle(ctx.env.DB)
    const revoked = await revokeNotionConnectionCore(db, ctx.principal, input.workspaceId)
    if (revoked) {
      // Archive the matching source so the poll sweep skips it (revoke stops sync).
      await new SourceStore(db, ctx.principal).archive(notionSourceId(input.workspaceId))
    }
    return { revoked }
  },
}

/** Every Notion op as a bound pair (def + handler). */
export const NOTION_OPS = [
  connectNotionOp,
  confirmNotionConnectionOp,
  listNotionConnectionsOp,
  disconnectNotionOp,
] as const

/** Register the Notion op contracts into a shared `OpRegistry`. */
export const registerNotionOps = (registry: OpRegistry): OpRegistry => {
  for (const op of NOTION_OPS) registry.register(op.def)
  return registry
}

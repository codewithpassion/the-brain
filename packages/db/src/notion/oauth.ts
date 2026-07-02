/**
 * Notion OAuth flow helpers (docs/notion-integration-plan.md §2). The Brain is the OAuth CLIENT
 * (reversed vs the vault). `connect_notion` mints a one-time CSRF nonce → tenant mapping in
 * `OAUTH_KV` and returns the Notion authorize URL; `/notion/callback` (a public route) consumes
 * the nonce to recover the tenant, then exchanges the code for the bot token. The nonce is the
 * CSRF guard AND the tenant binding — an attacker cannot forge a callback for another tenant
 * without a live server-minted nonce.
 */
import type { BrainBindings } from "../env"

/** Notion's OAuth authorize + token endpoints (public integration flow). */
export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize"
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token"

/**
 * The redirect URI registered on the Notion integration. Hardcoded (like the vault `DAV_ENDPOINT`)
 * — it must exactly match the value configured in the Notion integration settings (a human step).
 */
export const NOTION_REDIRECT_URI = "https://brain-api.dominik-fretz.workers.dev/notion/callback"

const NONCE_PREFIX = "notion:oauth:"
const NONCE_TTL_SECONDS = 600 // 10 minutes to complete consent

/** Store a one-time `nonce → tenantId` mapping in OAUTH_KV (TTL-expiring, CSRF + tenant binding). */
export const storeNotionOAuthNonce = async (
  env: BrainBindings,
  nonce: string,
  tenantId: string,
): Promise<void> => {
  await env.OAUTH_KV.put(`${NONCE_PREFIX}${nonce}`, tenantId, { expirationTtl: NONCE_TTL_SECONDS })
}

/** Consume (read + delete) a nonce, returning the bound tenantId or `null` (unknown/expired/reused). */
export const consumeNotionOAuthNonce = async (
  env: BrainBindings,
  nonce: string,
): Promise<string | null> => {
  const key = `${NONCE_PREFIX}${nonce}`
  const tenantId = await env.OAUTH_KV.get(key)
  if (tenantId === null) return null
  await env.OAUTH_KV.delete(key) // one-time use
  return tenantId
}

const WEBHOOK_TOKEN_KV_KEY = "notion:webhook:verification_token"

/**
 * Stash the webhook `verification_token` (the integration-level HMAC secret) in OAUTH_KV for
 * one-time operator retrieval — NEVER log it. **First-write-wins**: refuses to overwrite an
 * existing stash (a malicious/duplicate handshake POST must not clobber the real token) and
 * returns `false`. The operator reads it once
 * (`wrangler kv key get --binding OAUTH_KV notion:webhook:verification_token`), sets it as the
 * `NOTION_WEBHOOK_TOKEN` Worker secret, then deletes the KV entry to allow a future re-provision.
 */
export const storeNotionWebhookToken = async (
  env: BrainBindings,
  token: string,
): Promise<boolean> => {
  const existing = await env.OAUTH_KV.get(WEBHOOK_TOKEN_KV_KEY)
  if (existing !== null) return false // never overwrite — requires an explicit operator clear
  await env.OAUTH_KV.put(WEBHOOK_TOKEN_KV_KEY, token)
  return true
}

// ── Pending-grant stash (login-CSRF defence) ─────────────────────────────────────────────────────

const PENDING_PREFIX = "notion:pending:"
const PENDING_TTL_SECONDS = 600

/**
 * A completed OAuth grant awaiting the same-principal confirmation step. The callback (public, no
 * session) stashes this instead of auto-persisting; an AUTHENTICATED admin of the bound tenant then
 * confirms via `confirm_notion_connection`. Tokens are stored ENCRYPTED (never plaintext in KV).
 */
export interface PendingNotionGrant {
  /** The tenant the connect flow was started for (from the one-time nonce). */
  tenantId: string
  workspaceId: string
  workspaceName: string | null
  botId: string | null
  accessTokenCipher: string
  refreshTokenCipher: string | null
}

/** Stash a pending grant under a fresh confirm token (TTL-expiring). */
export const storeNotionPendingGrant = async (
  env: BrainBindings,
  confirmToken: string,
  grant: PendingNotionGrant,
): Promise<void> => {
  await env.OAUTH_KV.put(`${PENDING_PREFIX}${confirmToken}`, JSON.stringify(grant), {
    expirationTtl: PENDING_TTL_SECONDS,
  })
}

/**
 * PEEK a pending grant WITHOUT deleting it, or `null` when unknown/expired/malformed. The confirm
 * op peeks → checks the tenant → deletes ONLY on a successful confirm, so a mismatched/failed
 * confirm never burns the token (the legitimate tenant can still confirm).
 */
export const peekNotionPendingGrant = async (
  env: BrainBindings,
  confirmToken: string,
): Promise<PendingNotionGrant | null> => {
  const raw = await env.OAUTH_KV.get(`${PENDING_PREFIX}${confirmToken}`)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as PendingNotionGrant
  } catch {
    return null
  }
}

/** Delete a consumed pending grant (called after a successful confirm; one-time use). */
export const deleteNotionPendingGrant = async (
  env: BrainBindings,
  confirmToken: string,
): Promise<void> => {
  await env.OAUTH_KV.delete(`${PENDING_PREFIX}${confirmToken}`)
}

/** Build the Notion authorize URL for the consent redirect (`owner=user`, `response_type=code`). */
export const buildNotionAuthorizeUrl = (clientId: string, state: string): string => {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: NOTION_REDIRECT_URI,
    state,
  })
  return `${NOTION_AUTHORIZE_URL}?${params.toString()}`
}

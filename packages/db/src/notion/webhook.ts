/**
 * Notion webhook signature verification + event parsing (docs/notion-integration-plan.md §5, Phase
 * 3). Every event carries `X-Notion-Signature: sha256=HMAC-SHA256(verification_token, rawBody)`;
 * we recompute it and compare in CONSTANT time BEFORE touching any tenant data. The
 * `verification_token` is the integration-level secret captured via the one-time handshake and set
 * as the `NOTION_WEBHOOK_TOKEN` Worker secret. Web Crypto only (Workers + bun).
 */

const encoder = new TextEncoder()

const importHmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])

/** Decode a lowercase/uppercase hex string to bytes, or `null` on malformed/odd-length input. */
const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Verify a Notion webhook signature over the RAW request body via `crypto.subtle.verify` (the one
 * constant-time HMAC path). Returns `false` on a missing/malformed header (no `sha256=` prefix, bad
 * hex) or a mismatch — the caller fail-closes (401) BEFORE any tenant work. Never throws.
 */
export const verifyNotionSignature = async (
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> => {
  if (!header?.startsWith("sha256=")) return false
  const sigBytes = hexToBytes(header.slice("sha256=".length))
  if (sigBytes === null) return false
  try {
    const key = await importHmacKey(secret)
    return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(rawBody))
  } catch {
    return false
  }
}

// ── Event parsing ───────────────────────────────────────────────────────────────────────────────

/** The subset of a Notion webhook event body we read (all fields defensively optional). */
interface NotionWebhookBody {
  verification_token?: string
  type?: string
  workspace_id?: string
  entity?: { id?: string; type?: string }
}

/** A parsed, actionable Notion event routed by `workspace_id`. */
export interface ParsedNotionEvent {
  workspaceId: string
  pageId: string
  action: "upsert" | "delete"
}

/** Map a Notion event type to our ingest action (or `null` to ignore non-page/unknown events). */
const eventAction = (type: string | undefined): "upsert" | "delete" | null => {
  // `page.undeleted` (trash → restore) re-ingests: the upsert path resurrects the soft-deleted doc.
  if (type === "page.created" || type === "page.content_updated" || type === "page.undeleted") {
    return "upsert"
  }
  if (type === "page.deleted") return "delete"
  return null
}

/** The one-time handshake body: `{ verification_token }`. Returns the token, or `null`. */
export const notionHandshakeToken = (body: unknown): string | null => {
  const b = body as NotionWebhookBody
  return typeof b?.verification_token === "string" ? b.verification_token : null
}

/**
 * Parse a verified event body into `{ workspaceId, pageId, action }`, or `null` when it is a
 * handshake, a non-page event, or missing the workspace/page ids (ignored, never a throw).
 */
export const parseNotionEvent = (body: unknown): ParsedNotionEvent | null => {
  const b = body as NotionWebhookBody
  const action = eventAction(b?.type)
  if (action === null) return null
  const workspaceId = typeof b.workspace_id === "string" ? b.workspace_id : null
  const pageId = typeof b.entity?.id === "string" ? b.entity.id : null
  if (workspaceId === null || pageId === null) return null
  return { workspaceId, pageId, action }
}

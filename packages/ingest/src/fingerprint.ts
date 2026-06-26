/**
 * Content fingerprint (PRD §4.0 / §4.2 / §4.10).
 *
 * `fingerprint = sha256(normalizeForFingerprint(markdown))` — chosen over
 * `sha256(raw bytes)` precisely so that formatting drift (whitespace, case) on a
 * re-capture of the same content still dedups. This fingerprint is the basis of
 * the durable dedup backstop: the `(tenant_id, scope, fingerprint)` UNIQUE index
 * on `documents` (invariant 15).
 *
 * Deterministic: identical content always yields the identical fingerprint, and
 * content that differs only in whitespace/case yields the SAME fingerprint.
 */

/**
 * Aggressive, formatting-insensitive normalization used ONLY for the dedup
 * fingerprint: collapse every whitespace run (including newlines) to a single
 * space, trim, and lowercase. This is intentionally lossy — never store its
 * output as a body (use `normalize` from `normalize.ts` for that).
 */
export const normalizeForFingerprint = (text: string): string =>
  text.replace(/\s+/g, " ").trim().toLowerCase()

/** Lower-case hex encoding of a byte buffer. */
const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")

/**
 * Compute the content fingerprint: SHA-256 (WebCrypto, available in Workers and
 * Bun) of the fingerprint-normalized content, hex-encoded. Async because
 * `crypto.subtle.digest` is async.
 */
export const fingerprint = async (content: string): Promise<string> => {
  const bytes = new TextEncoder().encode(normalizeForFingerprint(content))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return toHex(digest)
}

/**
 * A Cloudflare Workflows instance id is capped at 64 characters (charset
 * `[a-zA-Z0-9_-]`). Our logical deterministic ids (e.g. `ingest-${tenantId}-${fp}`)
 * run well over that, so hash the logical id to a 64-char hex digest: deterministic
 * (same logical id → same instance id, preserving idempotency) and within the
 * length + charset limit. The logical id (tenant + content) keeps instances unique
 * per tenant; durable dedup still rests on the (tenant,scope,fingerprint) UNIQUE
 * index, not the instance id (invariant 15).
 */
export const workflowInstanceId = async (logical: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(logical))
  return toHex(digest)
}

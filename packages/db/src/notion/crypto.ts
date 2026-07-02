/**
 * Reversible token encryption for stored Notion OAuth bot tokens (docs/notion-integration-plan.md
 * §2, §7). Unlike the vault credential (SHA-256, non-decryptable), the Notion token must be
 * decryptable — the Brain calls Notion AS the client. AES-GCM via `crypto.subtle` keyed by the
 * `NOTION_TOKEN_ENC_KEY` Worker secret (declared/consumed DEVICE_FLOW_SECRET-style). Web Crypto
 * only (no Node `crypto`), so the same code runs on Workers and under `bun test`.
 *
 * Wire format of `encryptToken`: base64( iv[12] || ciphertext ). `NOTION_TOKEN_ENC_KEY` may be any
 * string — it is SHA-256-hashed to a fixed 256-bit AES key, so key length/encoding is irrelevant.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const IV_BYTES = 12 // AES-GCM standard nonce length

const toBase64 = (bytes: Uint8Array): string => {
  const chars: string[] = []
  for (const byte of bytes) chars.push(String.fromCharCode(byte))
  return btoa(chars.join(""))
}

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Derive a stable 256-bit AES-GCM key from an arbitrary-length secret string. */
const deriveKey = async (secret: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret))
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

/** Encrypt `plaintext` under `secret`. Returns base64( iv || ciphertext ). */
export const encryptToken = async (secret: string, plaintext: string): Promise<string> => {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  )
  const cipherBytes = new Uint8Array(cipher)
  const combined = new Uint8Array(IV_BYTES + cipherBytes.length)
  combined.set(iv, 0)
  combined.set(cipherBytes, IV_BYTES)
  return toBase64(combined)
}

/**
 * Decrypt a `base64( iv || ciphertext )` blob under `secret`. Throws on a bad key / tampered
 * ciphertext (AES-GCM authenticates), so callers can treat any throw as "unusable token".
 */
export const decryptToken = async (secret: string, blob: string): Promise<string> => {
  const key = await deriveKey(secret)
  const combined = fromBase64(blob)
  const iv = combined.slice(0, IV_BYTES)
  const cipherBytes = combined.slice(IV_BYTES)
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes)
  return decoder.decode(plain)
}

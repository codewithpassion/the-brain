/**
 * WebCrypto primitives for the auth spine (PRD §7.1/§7.2) — base64url, SHA-256, HMAC, and
 * the stateless `bdev_` machine-token codec. Everything here runs on `crypto.subtle` /
 * `crypto.getRandomValues`, which are identical on Cloudflare Workers and Bun (so the same
 * code is exercised under `bun test`). No Node `crypto` import — Web Crypto only.
 *
 * `bdev_` is STATELESS: the `tenantId` (and the full scope/capability grant) is baked into
 * HMAC-signed claims, so the token alone identifies the tenant with NO D1 lookup and NO
 * `bdev_` table (PRD §7.1, LOCKED DECISION). Tampering with any claim invalidates the MAC.
 */
import type { Capability, Role } from "@brain/shared"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const toBase64Url = (bytes: Uint8Array): string => {
  const chars: string[] = []
  for (const byte of bytes) chars.push(String.fromCharCode(byte))
  return btoa(chars.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Current time in whole seconds (token `iat`/`exp` unit). */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** SHA-256 of `input` as lowercase hex — the `bk_` API-key `key_hash` (PRD §7.1). */
export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input))
  const bytes = new Uint8Array(digest)
  const hex: string[] = []
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"))
  return hex.join("")
}

/** A fresh `${prefix}` + 256 bits of base64url randomness (the raw, shown-once credential). */
export const randomToken = (prefix: string): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `${prefix}${toBase64Url(bytes)}`
}

const importHmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])

/** The HMAC-signed claims a `bdev_` token carries (PRD §7.2; tenantId baked in). */
export interface MachineTokenClaims {
  userId: string
  tenantId: string
  role: Role
  /** DATA-partition grant (bounded by the minter at mint time). `'*'` = all tenant scopes. */
  allowedScopes: readonly string[] | "*"
  /** CAPABILITY axis (read|write|admin), bounded by the minter. */
  capabilities: readonly Capability[]
  readOnly: boolean
  iat: number
  /** Optional expiry (seconds); absent ⇒ non-expiring. */
  exp?: number
}

/** Sign claims into a `bdev_${body}.${mac}` token (HMAC-SHA256 over the base64url body). */
export const signMachineToken = async (
  secret: string,
  claims: MachineTokenClaims,
): Promise<string> => {
  const body = toBase64Url(encoder.encode(JSON.stringify(claims)))
  const key = await importHmacKey(secret)
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return `bdev_${body}.${toBase64Url(new Uint8Array(signature))}`
}

/**
 * Verify a `bdev_` token and return its claims, or `null` on ANY failure (bad prefix,
 * malformed shape, bad MAC, expired). The signature check uses `crypto.subtle.verify`
 * (constant-time) over the exact base64url body that was signed — a single flipped claim
 * byte changes the body and fails the MAC.
 */
export const verifyMachineToken = async (
  secret: string,
  token: string,
  now: number,
): Promise<MachineTokenClaims | null> => {
  if (!token.startsWith("bdev_")) return null
  const rest = token.slice("bdev_".length)
  const dot = rest.indexOf(".")
  if (dot < 0) return null
  const body = rest.slice(0, dot)
  const mac = rest.slice(dot + 1)
  try {
    const key = await importHmacKey(secret)
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(mac), encoder.encode(body))
    if (!valid) return null
    const claims = JSON.parse(decoder.decode(fromBase64Url(body))) as MachineTokenClaims
    if (typeof claims.userId !== "string" || typeof claims.tenantId !== "string") return null
    if (typeof claims.exp === "number" && claims.exp <= now) return null
    return claims
  } catch {
    return null
  }
}

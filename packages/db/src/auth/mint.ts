/**
 * Token minting + `bk_` API-key resolution (PRD §7.1/§7.2).
 *
 * The escalation guard (PRD §7.1 iter-3 fix): a minted credential's grant is the
 * INTERSECTION of the request with the MINTER's own grant — a restricted minter can only
 * ever produce a subset of its own access, so widening is structurally impossible. This
 * applies to BOTH axes (DATA-partition `allowedScopes` AND `capabilities`) and to `readOnly`
 * (a read-only minter only mints read-only credentials).
 */
import type { Capability, Principal } from "@brain/shared"
import { PrincipalSchema } from "@brain/shared"
import { eq } from "drizzle-orm"
import { apiKeys } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { parseCapabilities, parseScopeGrant } from "./principal"
import {
  type MachineTokenClaims,
  nowSeconds,
  randomToken,
  sha256Hex,
  signMachineToken,
} from "./tokens"

/**
 * Intersect a requested DATA-partition grant with the minter's. `minter === '*'` is the
 * identity (the request passes through, `'*'` or finite); a restricted minter caps a `'*'`
 * request to its OWN finite grant and otherwise keeps only the requested scopes it holds.
 */
export const intersectScopes = (
  requested: readonly string[] | "*",
  minter: readonly string[] | "*",
): readonly string[] | "*" => {
  if (minter === "*") return requested
  if (requested === "*") return [...minter]
  const allowed = new Set(minter)
  return requested.filter((scope) => allowed.has(scope))
}

/** Intersect requested capabilities with the minter's (default: the minter's full set). */
export const intersectCapabilities = (
  requested: readonly Capability[] | undefined,
  minter: readonly Capability[],
): readonly Capability[] => {
  if (!requested) return [...minter]
  const allowed = new Set(minter)
  return requested.filter((capability) => allowed.has(capability))
}

export interface MintApiKeyInput {
  name: string
  /** Requested DATA-partition grant; intersected DOWN to the minter's. Default `'*'`. */
  requestedScopes?: readonly string[] | "*"
  /** Requested capabilities; intersected DOWN to the minter's. Default: minter's set. */
  requestedCapabilities?: readonly Capability[]
  /** Request a read-only key; forced read-only if the minter is read-only. */
  readOnly?: boolean
  /** Optional ISO-8601 expiry stored on the key. */
  expiresAt?: string
}

export interface MintedApiKey {
  /** The raw `bk_` token — shown to the caller ONCE; only its SHA-256 hash is stored. */
  token: string
  keyId: string
}

/**
 * Mint a `bk_` API key (PRD §7.1). Generates a random token, stores only its SHA-256 hash,
 * pins `allowed_scopes` to `intersect(requested, minter.allowedScopes)` (NULL ⇔ `'*'`, only
 * possible when the minter itself is `'*'`), stores the bounded capabilities as the key's
 * `scopes` JSON, and binds the key to the minter's tenant. Returns the raw token + key id.
 */
export const mintApiKey = async (
  db: BrainDrizzle,
  minter: Principal,
  input: MintApiKeyInput,
): Promise<MintedApiKey> => {
  const token = randomToken("bk_")
  const keyHash = await sha256Hex(token)
  const keyId = crypto.randomUUID()
  const allowedScopes = intersectScopes(input.requestedScopes ?? "*", minter.allowedScopes)
  const capabilities = intersectCapabilities(input.requestedCapabilities, minter.capabilities)
  const readOnly = (input.readOnly ?? false) || minter.readOnly
  await db.insert(apiKeys).values({
    id: keyId,
    tenantId: minter.tenantId,
    userId: minter.userId,
    name: input.name,
    keyHash,
    keyPrefix: token.slice(0, 11),
    scopes: JSON.stringify(capabilities),
    allowedScopes: allowedScopes === "*" ? null : JSON.stringify(allowedScopes),
    readOnly: readOnly ? 1 : 0,
    createdAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  })
  return { token, keyId }
}

export interface MintMachineTokenInput {
  /** Requested DATA-partition grant; intersected DOWN to the minter's. Default `'*'`. */
  requestedScopes?: readonly string[] | "*"
  /** Requested capabilities; intersected DOWN to the minter's. Default: minter's set. */
  requestedCapabilities?: readonly Capability[]
  /** Request a read-only token; forced read-only if the minter is read-only. */
  readOnly?: boolean
  /** Optional lifetime in seconds; absent ⇒ non-expiring. */
  ttlSeconds?: number
}

/**
 * Mint a stateless `bdev_` machine token (PRD §7.1 LOCKED DECISION: one per tenant, tenantId
 * baked into HMAC-signed claims). The grant is bounded by the minter on both axes; `tenantId`
 * and `userId` come from the minter. There is NO D1 write — the token is self-describing.
 */
export const mintMachineToken = async (
  secret: string,
  minter: Principal,
  input: MintMachineTokenInput = {},
): Promise<string> => {
  const allowedScopes = intersectScopes(input.requestedScopes ?? "*", minter.allowedScopes)
  const capabilities = intersectCapabilities(input.requestedCapabilities, minter.capabilities)
  const readOnly = (input.readOnly ?? false) || minter.readOnly
  const iat = nowSeconds()
  const claims: MachineTokenClaims = {
    userId: minter.userId,
    tenantId: minter.tenantId,
    role: readOnly ? "readonly" : minter.role,
    allowedScopes,
    capabilities,
    readOnly,
    iat,
    ...(input.ttlSeconds ? { exp: iat + input.ttlSeconds } : {}),
  }
  return signMachineToken(secret, claims)
}

/**
 * Resolve a `bk_` API key to a `Principal` (PRD §7.2). Looks the key up by its SHA-256 hash
 * (never the raw token), returns `null` for unknown / revoked / expired keys (no partial
 * trust). `allowedScopes` comes from the key's stored grant (NULL ⇒ `'*'`); `capabilities`
 * from the key's `scopes` JSON; `readOnly` from the key's flag. Validated through
 * `PrincipalSchema` before it escapes.
 */
export const resolveApiKeyPrincipal = async (
  db: BrainDrizzle,
  token: string,
): Promise<Principal | null> => {
  const keyHash = await sha256Hex(token)
  const rows = await db
    .select({
      tenantId: apiKeys.tenantId,
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      allowedScopes: apiKeys.allowedScopes,
      readOnly: apiKeys.readOnly,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.revokedAt) return null
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null
  const readOnly = row.readOnly === 1
  return PrincipalSchema.parse({
    tenantId: row.tenantId,
    userId: row.userId,
    teamIds: [],
    role: readOnly ? "readonly" : "member",
    allowedScopes: row.allowedScopes === null ? "*" : parseScopeGrant(row.allowedScopes),
    capabilities: parseCapabilities(row.scopes),
    readOnly,
  })
}

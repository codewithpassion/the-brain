/**
 * CLI OAuth 2.1 device-flow server logic (RFC 8628).
 *
 * All D1 + KV access lives here (invariant 2 — apps/api may not name raw binding types).
 * The route layer (apps/api/src/device-flow/routes.ts) calls these, passing `env`.
 */
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { cliAuthSessions, cliRefreshTokens } from "../schema"
import type { ClerkVerifier } from "./clerk"
import { createClerkVerifier } from "./clerk"
import { AuthError } from "./errors"
import { mintApiKey } from "./mint"
import { autoProvisionOrg, loadMembershipPrincipal } from "./principal"
import { nowSeconds, randomToken, sha256Hex } from "./tokens"

const DEVICE_CODE_EXPIRES_IN = 900 // 15 minutes
const ACCESS_TOKEN_EXPIRES_IN = 3600 // 1 hour
const REFRESH_TOKEN_EXPIRES_IN = 7776000 // 90 days
const POLL_INTERVAL = 5 // seconds

/**
 * Short memorable user code like `ABCD-EFGH`.
 * Uses a reduced alphabet (no 0/O/1/I) to minimise transcription errors.
 */
const generateUserCode = (): string => {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 32 chars, no O/0/I/1
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => alpha[b % alpha.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`
}

/** ISO-8601 UTC string for `nowSec + deltaSeconds`. */
const isoFuture = (nowSec: number, deltaSeconds: number): string =>
  new Date((nowSec + deltaSeconds) * 1000).toISOString()

/** POST /device_authorization response (snake_case matches RFC 8628 + CLI contract). */
export interface DeviceAuthResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface TokenSuccess {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: "Bearer"
}

export interface TokenError {
  error: string
  error_description: string
}

/** POST /device_authorization — insert a new pending device session. */
export const createDeviceSession = async (
  env: BrainBindings,
  origin: string,
): Promise<DeviceAuthResponse> => {
  const db = drizzle(env.DB)
  const deviceCode = randomToken("dc_")
  const userCode = generateUserCode()
  const now = nowSeconds()

  await db.insert(cliAuthSessions).values({
    id: crypto.randomUUID(),
    deviceCode,
    userCode,
    status: "pending",
    expiresAt: isoFuture(now, DEVICE_CODE_EXPIRES_IN),
    pollInterval: POLL_INTERVAL,
    createdAt: new Date(now * 1000).toISOString(),
  })

  const verificationUri = `${origin}/activate`
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_EXPIRES_IN,
    interval: POLL_INTERVAL,
  }
}

/**
 * POST /activate — approve a pending session (Clerk-authenticated approver).
 * Mints a `bk_` access token + refresh token and stores them on the session row.
 * Throws `AuthError` on any credential or session validation failure.
 */
export const approveDeviceSession = async (
  env: BrainBindings,
  userCode: string,
  clerkVerifier: ClerkVerifier | undefined,
  authHeader: string | undefined,
): Promise<void> => {
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!bearer) throw new AuthError(401, "missing bearer credential")

  const verifier = clerkVerifier ?? createClerkVerifier(env)
  const identity = await verifier.verify(bearer)
  if (!identity) throw new AuthError(401, "invalid Clerk token")
  const { userId, email } = identity

  const db = drizzle(env.DB)

  const rows = await db
    .select()
    .from(cliAuthSessions)
    .where(eq(cliAuthSessions.userCode, userCode.toUpperCase()))
    .limit(1)
  const session = rows[0]
  if (!session) throw new AuthError(404, "unknown user_code")

  const now = nowSeconds()
  if (Date.parse(session.expiresAt) <= now * 1000) throw new AuthError(400, "device code expired")
  if (session.status !== "pending") throw new AuthError(400, "device code already used")

  // Auto-provision the user's own org (idempotent on concurrent first-logins) then build minter.
  const tenantId = await autoProvisionOrg(db, userId, email ?? userId)
  const minter = await loadMembershipPrincipal(db, userId, tenantId)
  if (!minter) throw new AuthError(500, "membership not found after provision")

  const tokenExpiresAt = isoFuture(now, ACCESS_TOKEN_EXPIRES_IN)
  const { token: accessToken } = await mintApiKey(db, minter, {
    name: "CLI device-flow key",
    expiresAt: tokenExpiresAt,
  })

  const rawRefreshToken = randomToken("rt_")
  const refreshHash = await sha256Hex(rawRefreshToken)
  await db.insert(cliRefreshTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: refreshHash,
    expiresAt: isoFuture(now, REFRESH_TOKEN_EXPIRES_IN),
    createdAt: new Date(now * 1000).toISOString(),
  })

  // Store raw tokens on the session so the first successful poll can return them exactly once.
  await db
    .update(cliAuthSessions)
    .set({
      status: "approved",
      tenantId,
      userId,
      accessToken,
      refreshToken: rawRefreshToken,
      tokenExpiresAt,
    })
    .where(eq(cliAuthSessions.id, session.id))
}

/**
 * POST /token (device_code grant) — poll until the user approves.
 * `slow_down` is returned only while the session is still pending (the final exchange poll
 * must succeed immediately, so rate-limiting does not apply to the approved→consumed step).
 */
export const exchangeDeviceToken = async (
  env: BrainBindings,
  deviceCode: string,
): Promise<TokenSuccess | TokenError> => {
  const db = drizzle(env.DB)
  const now = nowSeconds()

  const rows = await db
    .select()
    .from(cliAuthSessions)
    .where(eq(cliAuthSessions.deviceCode, deviceCode))
    .limit(1)
  const session = rows[0]

  if (!session || Date.parse(session.expiresAt) <= now * 1000) {
    return { error: "expired_token", error_description: "device code expired" }
  }

  if (session.status === "pending") {
    const kvKey = `last_polled:${deviceCode}`
    const interval = session.pollInterval ?? POLL_INTERVAL
    const lastStr = await env.OAUTH_KV.get(kvKey)
    const tooFast = lastStr !== null && now - Number(lastStr) < interval
    // KV minimum expirationTtl is 60s; use the full device-code lifetime so the key expires
    // when the session does and never lives beyond it.
    await env.OAUTH_KV.put(kvKey, String(now), { expirationTtl: DEVICE_CODE_EXPIRES_IN })
    if (tooFast) return { error: "slow_down", error_description: "polling too fast" }
    return { error: "authorization_pending", error_description: "user has not yet approved" }
  }

  if (session.status === "consumed") {
    return { error: "access_denied", error_description: "session already consumed" }
  }

  if (session.status !== "approved") {
    return { error: "access_denied", error_description: "session denied" }
  }

  if (!(session.accessToken && session.refreshToken && session.tokenExpiresAt)) {
    return { error: "server_error", error_description: "missing tokens on approved session" }
  }

  // Consume before returning to prevent a double-exchange race.
  await db
    .update(cliAuthSessions)
    .set({ status: "consumed" })
    .where(eq(cliAuthSessions.id, session.id))

  const expiresIn = Math.max(
    0,
    Math.floor((Date.parse(session.tokenExpiresAt) - now * 1000) / 1000),
  )

  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: expiresIn,
    token_type: "Bearer",
  }
}

/** POST /token (refresh_token grant) — validate old token, rotate to fresh pair. */
export const refreshDeviceToken = async (
  env: BrainBindings,
  rawRefreshToken: string,
): Promise<TokenSuccess | TokenError> => {
  const db = drizzle(env.DB)
  const now = nowSeconds()
  const tokenHash = await sha256Hex(rawRefreshToken)

  const rows = await db
    .select()
    .from(cliRefreshTokens)
    .where(eq(cliRefreshTokens.tokenHash, tokenHash))
    .limit(1)
  const row = rows[0]

  if (!row || row.revokedAt !== null || Date.parse(row.expiresAt) <= now * 1000) {
    return { error: "invalid_grant", error_description: "refresh token invalid or expired" }
  }

  const { userId } = row
  const tenantId = `org_${userId}`
  const minter = await loadMembershipPrincipal(db, userId, tenantId)
  if (!minter) {
    return { error: "invalid_grant", error_description: "no active membership" }
  }

  // Revoke old token first (minimise window before new one is issued).
  await db
    .update(cliRefreshTokens)
    .set({ revokedAt: new Date(now * 1000).toISOString() })
    .where(eq(cliRefreshTokens.id, row.id))

  const tokenExpiresAt = isoFuture(now, ACCESS_TOKEN_EXPIRES_IN)
  const { token: accessToken } = await mintApiKey(db, minter, {
    name: "CLI device-flow key (refreshed)",
    expiresAt: tokenExpiresAt,
  })

  const newRawRefreshToken = randomToken("rt_")
  const newRefreshHash = await sha256Hex(newRawRefreshToken)
  await db.insert(cliRefreshTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: newRefreshHash,
    expiresAt: isoFuture(now, REFRESH_TOKEN_EXPIRES_IN),
    createdAt: new Date(now * 1000).toISOString(),
  })

  return {
    access_token: accessToken,
    refresh_token: newRawRefreshToken,
    expires_in: ACCESS_TOKEN_EXPIRES_IN,
    token_type: "Bearer",
  }
}

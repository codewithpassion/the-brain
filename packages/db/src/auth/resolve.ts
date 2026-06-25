/**
 * `resolvePrincipal` — the ONE edge resolver (PRD §7.2, invariant 17). Runs ONCE per request
 * at the Worker edge and reduces ANY credential to a validated `Principal`; no bare token
 * travels below the edge. Resolution chain, first match wins:
 *   1. Clerk JWT (Bearer, not `bdev_`/`bk_`)  → active-tenant pin → membership → Principal
 *   2. `bdev_` HMAC machine token             → tenantId baked in claims → Principal
 *   3. `bk_` API key                          → SHA-256 hash lookup → Principal
 * Throws a typed `AuthError` (carrying an HTTP status) on every failure — 401 by default.
 */
import type { Principal } from "@brain/shared"
import { PrincipalSchema } from "@brain/shared"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { memberships } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { type ClerkIdentity, type ClerkVerifier, createClerkVerifier } from "./clerk"
import { AuthError } from "./errors"
import { resolveApiKeyPrincipal } from "./mint"
import { autoProvisionOrg, loadMembershipPrincipal, resolveTenantSelector } from "./principal"
import { nowSeconds, verifyMachineToken } from "./tokens"

/** Options bag — makes the Clerk verifier, DB, and active-tenant pin injectable for tests. */
export interface ResolvePrincipalOptions {
  /** Override the Clerk verifier (tests inject a local-key verifier; default: remote JWKS). */
  clerkVerifier?: ClerkVerifier
  /** Override the Drizzle DB (tests pass a bun:sqlite instance; default: `drizzle(env.DB)`). */
  db?: BrainDrizzle
  /** Active tenant from a signed `/mcp/<slug>` path (MCP surface). Highest precedence. */
  activeTenantSlug?: string
  /** Active tenant from a server-side session pin (dashboard surface). Lowest precedence. */
  sessionPin?: string
}

/**
 * The active-tenant selector for the Clerk-JWT path (PRD §7.2). A JWT alone does not name a
 * tenant, so the active tenant is resolved from a SINGLE pinned mechanism per surface, in
 * precedence order: explicit path slug (`/mcp/<slug>`) → validated `X-Brain-Tenant` header
 * (REST) → server-side session pin (dashboard). Returns `null` when none is supplied — the
 * caller turns that into a 401, NEVER a silent first-membership default (invariant 17).
 */
export const activeTenant = (
  request: Request,
  options?: { activeTenantSlug?: string; sessionPin?: string },
): string | null => {
  if (options?.activeTenantSlug) return options.activeTenantSlug
  const header = request.headers.get("X-Brain-Tenant")?.trim()
  if (header) return header
  if (options?.sessionPin) return options.sessionPin
  return null
}

/** Clerk-JWT branch: identity → active tenant (or first-login auto-provision) → Principal. */
const resolveClerkPrincipal = async (
  db: BrainDrizzle,
  request: Request,
  identity: ClerkIdentity,
  options: ResolvePrincipalOptions,
): Promise<Principal> => {
  const existing = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .where(eq(memberships.userId, identity.userId))
    .limit(1)
  if (existing.length === 0) {
    // Brand-new user, no org at all → auto-provision own org (org == user) and bind to it.
    const tenantId = await autoProvisionOrg(db, identity.userId, identity.email ?? identity.userId)
    const principal = await loadMembershipPrincipal(db, identity.userId, tenantId)
    if (!principal) throw new AuthError(500, "auto-provision produced no membership")
    return principal
  }
  // User HAS membership(s) → an active tenant MUST be named; never a silent default.
  const selector = activeTenant(request, options)
  if (selector === null) throw new AuthError(401, "active tenant required")
  const tenantId = await resolveTenantSelector(db, selector)
  if (tenantId === null) throw new AuthError(401, "unknown active tenant")
  const principal = await loadMembershipPrincipal(db, identity.userId, tenantId)
  if (!principal) throw new AuthError(401, "not a member of the requested tenant")
  return principal
}

export const resolvePrincipal = async (
  env: BrainBindings,
  request: Request,
  options: ResolvePrincipalOptions = {},
): Promise<Principal> => {
  const db = options.db ?? drizzle(env.DB)
  const bearer = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!bearer) throw new AuthError(401, "missing bearer credential")

  // 1. Clerk JWT — anything that is not a canonical `bdev_`/`bk_` prefix.
  if (!(bearer.startsWith("bdev_") || bearer.startsWith("bk_"))) {
    const verifier = options.clerkVerifier ?? createClerkVerifier(env)
    const identity = await verifier.verify(bearer)
    if (!identity) throw new AuthError(401, "invalid Clerk token")
    return resolveClerkPrincipal(db, request, identity, options)
  }

  // 2. `bdev_` HMAC machine token — stateless; tenantId baked into the signed claims.
  if (bearer.startsWith("bdev_")) {
    const claims = await verifyMachineToken(env.DEVICE_FLOW_SECRET, bearer, nowSeconds())
    if (!claims) throw new AuthError(401, "invalid machine token")
    return PrincipalSchema.parse({
      tenantId: claims.tenantId,
      userId: claims.userId,
      teamIds: [],
      role: claims.role,
      allowedScopes: claims.allowedScopes,
      capabilities: claims.capabilities,
      readOnly: claims.readOnly,
    })
  }

  // 3. `bk_` API key — SHA-256 hash lookup, tenant-bound.
  const principal = await resolveApiKeyPrincipal(db, bearer)
  if (!principal) throw new AuthError(401, "invalid API key")
  return principal
}

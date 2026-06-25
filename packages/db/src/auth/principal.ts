/**
 * Principal construction from D1 tenancy rows (PRD §7.2) — the canonical builder, the
 * multi-row membership aggregation, the first-login auto-provision, and the active-tenant
 * selector → tenantId resolution. Every public path that returns a `Principal` validates it
 * through `PrincipalSchema.parse` (the §7.2 shape is the last guard before the edge).
 */
import type { Capability, Principal, Role } from "@brain/shared"
import { PrincipalSchema } from "@brain/shared"
import { and, eq, or } from "drizzle-orm"
import { memberships, orgs } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { AuthError } from "./errors"
import { sha256Hex } from "./tokens"

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, readonly: 0 }

/** Coerce a stored role string to a `Role`, failing CLOSED to least-privilege `readonly`. */
const asRole = (value: string): Role =>
  value === "owner" || value === "admin" || value === "member" ? value : "readonly"

/**
 * Capabilities derived from membership rank (PRD §7.2): owner/admin → read|write|admin;
 * member → read|write; readonly → read. The `bk_` API-key path overrides this from the
 * key's stored CAPABILITY scopes; machine tokens carry capabilities in their claims.
 */
export const capabilitiesForRole = (role: Role): Capability[] => {
  if (role === "readonly") return ["read"]
  if (role === "member") return ["read", "write"]
  return ["read", "write", "admin"]
}

/** Parse a stored DATA-partition grant; fail CLOSED to `[]` (no scopes), NEVER `'*'`. */
export const parseScopeGrant = (json: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Parse a stored CAPABILITY grant (read|write|admin); fail closed to `['read']`. */
export const parseCapabilities = (json: string): readonly Capability[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return ["read"]
    const caps = parsed.filter(
      (x): x is Capability => x === "read" || x === "write" || x === "admin",
    )
    return caps.length > 0 ? caps : ["read"]
  } catch {
    return ["read"]
  }
}

/** The already-resolved membership facts the pure builder needs (PRD §7.2). */
export interface MembershipForPrincipal {
  userId: string
  role: Role
  allowedScopes: readonly string[] | "*"
}

/**
 * The canonical `Principal` builder (PRD §7.2). Pure: takes an org, an already-aggregated
 * membership, and the user's teamIds. `allowedScopes` is the DATA axis (verbatim from the
 * membership); `capabilities` is the CAPABILITY axis (derived from role); `readOnly` is
 * `role === 'readonly'`. The result is parsed through `PrincipalSchema` before it escapes.
 */
export const principalFromMembership = (
  org: { id: string },
  membership: MembershipForPrincipal,
  teamIds: readonly string[],
): Principal =>
  PrincipalSchema.parse({
    tenantId: org.id,
    userId: membership.userId,
    teamIds,
    role: membership.role,
    allowedScopes: membership.allowedScopes,
    capabilities: capabilitiesForRole(membership.role),
    readOnly: membership.role === "readonly",
  })

interface MembershipRow {
  role: string
  teamId: string | null
  allowedScopes: string | null
}

/**
 * Aggregate a user's membership rows within ONE tenant into a single resolved grant
 * (PRD §7.2 `principalFromMembership`). Role = the HIGHEST of the rows. `allowedScopes` is
 * `'*'` iff the user is owner/admin OR ANY row grants `'*'` (a NULL `allowed_scopes`);
 * otherwise it is the UNION of the finite per-row grants — never `[]` collapsing a wildcard.
 * Returns `null` when the user has no membership in the tenant (→ 401 upstream).
 */
export const aggregateMemberships = (
  rows: readonly MembershipRow[],
): { role: Role; allowedScopes: readonly string[] | "*"; teamIds: string[] } | null => {
  if (rows.length === 0) return null
  let topRole: Role = "readonly"
  for (const row of rows) {
    const role = asRole(row.role)
    if (ROLE_RANK[role] > ROLE_RANK[topRole]) topRole = role
  }
  const teamIds = rows.map((row) => row.teamId).filter((id): id is string => id !== null)
  const wildcard =
    topRole === "owner" || topRole === "admin" || rows.some((row) => row.allowedScopes === null)
  if (wildcard) return { role: topRole, allowedScopes: "*", teamIds }
  const grants = new Set<string>()
  for (const row of rows) {
    if (row.allowedScopes === null) continue
    for (const scope of parseScopeGrant(row.allowedScopes)) grants.add(scope)
  }
  return { role: topRole, allowedScopes: [...grants], teamIds }
}

/** Load + aggregate a user's memberships in one tenant → a `Principal`, or `null` if none. */
export const loadMembershipPrincipal = async (
  db: BrainDrizzle,
  userId: string,
  tenantId: string,
): Promise<Principal | null> => {
  const rows = await db
    .select({
      role: memberships.role,
      teamId: memberships.teamId,
      allowedScopes: memberships.allowedScopes,
    })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
  const agg = aggregateMemberships(rows)
  if (!agg) return null
  return principalFromMembership(
    { id: tenantId },
    { userId, role: agg.role, allowedScopes: agg.allowedScopes },
    agg.teamIds,
  )
}

// org == user in v1: both the org id AND the slug are deterministic, INJECTIVE functions of
// the Clerk subject — so "this slug exists" ⟺ "this exact user's org exists". Deriving the
// slug from anything lossy (e.g. an email local-part) would let two distinct users collide on
// the UNIQUE slug index and mint a Principal bound to a tenant with no `orgs` row.
const orgIdForUser = (userId: string): string => `org_${userId}`
const membershipIdFor = (tenantId: string, userId: string): string => `mem_${tenantId}_${userId}`
const slugForUser = async (userId: string): Promise<string> =>
  `u-${(await sha256Hex(userId)).slice(0, 16)}`

/**
 * Auto-provision the user's own org on first Clerk login (PRD LOCKED DECISION: org == user,
 * owner membership with `allowed_scopes = '*'`). Idempotent under concurrent first-requests:
 * the deterministic org id + UNIQUE slug and the deterministic membership PK make both
 * inserts no-ops on conflict, so a duplicate request creates nothing new. The two inserts run
 * sequentially (the test backend, bun:sqlite, has no `db.batch`; on D1 each statement is
 * atomic and a partial provision self-heals on the next idempotent request). After inserting,
 * the org row is re-read by its deterministic id and provisioning fails CLOSED if absent —
 * a Principal is NEVER bound to a tenant without an `orgs` row. Returns the tenantId.
 */
export const autoProvisionOrg = async (
  db: BrainDrizzle,
  userId: string,
  displayName: string,
): Promise<string> => {
  const tenantId = orgIdForUser(userId)
  const slug = await slugForUser(userId)
  await db.insert(orgs).values({ id: tenantId, name: displayName, slug }).onConflictDoNothing()
  await db
    .insert(memberships)
    .values({
      id: membershipIdFor(tenantId, userId),
      tenantId,
      userId,
      teamId: null,
      role: "owner",
      allowedScopes: null,
    })
    .onConflictDoNothing()
  const found = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, tenantId)).limit(1)
  if (found.length === 0) throw new AuthError(500, "org auto-provision failed")
  return tenantId
}

/**
 * Resolve an active-tenant selector (a slug — or, defensively, an org id) to a tenantId.
 * Returns `null` when no org matches. The chosen value is ALWAYS re-checked against
 * `memberships` afterward, so a forged/guessed selector for a tenant the user is not a member
 * of is non-leaky (→ 401), not a trust boundary (PRD §7.2).
 */
export const resolveTenantSelector = async (
  db: BrainDrizzle,
  selector: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(or(eq(orgs.slug, selector), eq(orgs.id, selector)))
    .limit(1)
  return rows[0]?.id ?? null
}

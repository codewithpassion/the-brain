/**
 * OAuth 2.1 authorization-state helpers — the `OAUTH_KV` chokepoint for the Worker's
 * `/authorize` → `/callback` CSRF state. Follows invariant 2 (only `packages/db` names
 * raw KV bindings); `apps/api` calls these functions instead of touching `env.OAUTH_KV`
 * directly.
 *
 * Stored under: `oauth:state:<random_hex_token>` with a 10-minute TTL.
 *
 * Also exports `listOrgsForUserId` — used by the `/authorize/orgs` endpoint to populate
 * the org picker before the user submits the final `/callback` POST.
 */
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { memberships, orgs } from "../schema"

const STATE_PREFIX = "oauth:state:"
const STATE_TTL_SECONDS = 600

/**
 * Store a pending OAuth authorization state. The `oauthStateJson` is the JSON-encoded
 * parsed authorization request from `env.OAUTH_PROVIDER.parseAuthRequest()`.
 */
export const storeOAuthState = (
  env: BrainBindings,
  stateToken: string,
  oauthStateJson: string,
): Promise<void> =>
  env.OAUTH_KV.put(`${STATE_PREFIX}${stateToken}`, oauthStateJson, {
    expirationTtl: STATE_TTL_SECONDS,
  })

/**
 * Load a pending OAuth authorization state. Returns `null` if the token is unknown or
 * has expired (the KV TTL auto-cleans after 10 minutes).
 */
export const loadOAuthState = (env: BrainBindings, stateToken: string): Promise<string | null> =>
  env.OAUTH_KV.get(`${STATE_PREFIX}${stateToken}`)

/**
 * Delete a used OAuth authorization state (one-time use — burn after reading at /callback).
 */
export const deleteOAuthState = (env: BrainBindings, stateToken: string): Promise<void> =>
  env.OAUTH_KV.delete(`${STATE_PREFIX}${stateToken}`)

/**
 * List all orgs the given user is a member of (for the OAuth `/authorize` org picker).
 * Queries `memberships JOIN orgs` by `userId` — cross-tenant by design, safe because it
 * returns only the caller's own memberships. Returns an empty array for brand-new users
 * who have not yet auto-provisioned their personal org. Deduplicates by org id, keeping
 * the highest role (mirrors `listOrgsCore` / `aggregateMemberships`).
 *
 * Used by `POST /authorize/orgs` in `apps/api`. The DB lookup stays inside `packages/db`
 * so `apps/api` never names a raw binding directly (invariant 2).
 */
export const listOrgsForUserId = async (
  env: BrainBindings,
  userId: string,
): Promise<{ id: string; slug: string; name: string; role: string }[]> => {
  const db = drizzle(env.DB)
  const rows = await db
    .select({ id: orgs.id, slug: orgs.slug, name: orgs.name, role: memberships.role })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.tenantId, orgs.id))
    .where(eq(memberships.userId, userId))
  // Deduplicate by org id, keeping the highest role.
  const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1, readonly: 0 }
  const byId = new Map<string, { id: string; slug: string; name: string; role: string }>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    if (!existing || (ROLE_RANK[row.role] ?? 0) > (ROLE_RANK[existing.role] ?? 0)) {
      byId.set(row.id, { id: row.id, slug: row.slug, name: row.name, role: row.role })
    }
  }
  return [...byId.values()]
}

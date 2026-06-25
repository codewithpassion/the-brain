/**
 * Queue-message tenant validation + fail-closed Principal reconstruction (PRD §8.6, invariant 18).
 *
 * Internal Worker↔Queue hops use native bindings (no shared HTTP secret), but a consumer must
 * STILL validate the message's `tenant_id` against a REAL `orgs` row before it touches any tenant
 * data — a forged/stale/garbage `tenant_id` must fail CLOSED (→ the message is rejected and, after
 * retry-exhaustion, lands in the DLQ). This module is the single discriminator the `brain-backfill`
 * and `brain-reembed` consumers call.
 *
 * Living in `packages/db` is correct: it reads `orgs`/`memberships` and reconstructs a `Principal`,
 * all of which require the raw `env.DB` only this package may touch (invariant 2). The `*Db`
 * functions take the `BrainDrizzle` handle directly so they unit-test against bun:sqlite; the
 * `env`-taking wrappers are what the `apps/api` consumers call (they never touch `env.DB` itself).
 */
import type { Principal } from "@brain/shared"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { loadMembershipPrincipal, principalFromMembership } from "../auth"
import type { BrainBindings } from "../env"
import { orgs } from "../schema"
import type { BrainDrizzle } from "../scoped/db"

/** The minimal tenant identity a validated message resolves to. */
export interface ValidatedTenant {
  id: string
}

/** The tenant-carrying fields every backfill/reembed message shares. */
export interface TenantBearingMessage {
  tenantId: string
  /** Optional authorship for the reconstructed Principal; absent ⇒ a system principal. */
  userId?: string
}

/**
 * Look up `tenantId` in `orgs` (the trust boundary). Returns the org when it EXISTS, else `null`
 * (fail-closed — invariant 18). A `tenant_id` that names no org is rejected before any scoped
 * read/write. The db-level core, so it unit-tests directly against bun:sqlite.
 */
export const findOrg = async (
  db: BrainDrizzle,
  tenantId: string | null | undefined,
): Promise<ValidatedTenant | null> => {
  if (typeof tenantId !== "string" || tenantId.length === 0) return null
  const rows = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, tenantId)).limit(1)
  return rows[0] ?? null
}

/**
 * Reconstruct the consumer's `Principal` from the message, fail-closed (invariant 18). The
 * db-level core (see `principalFromMessage` for the call-site contract).
 */
export const principalFromMessageDb = async (
  db: BrainDrizzle,
  message: TenantBearingMessage,
): Promise<Principal | null> => {
  const tenant = await findOrg(db, message.tenantId)
  if (tenant === null) return null
  if (message.userId !== undefined) {
    return loadMembershipPrincipal(db, message.userId, tenant.id)
  }
  return principalFromMembership(
    { id: tenant.id },
    { userId: "system", role: "member", allowedScopes: "*" },
    [],
  )
}

/** `findOrg` over the live D1 binding — the validator the `apps/api` consumers call. */
export const tenantFromMessage = (
  env: BrainBindings,
  tenantId: string | null | undefined,
): Promise<ValidatedTenant | null> => findOrg(drizzle(env.DB), tenantId)

/**
 * Reconstruct the consumer's `Principal` from the message, fail-closed (invariant 18):
 *   1. the `tenant_id` MUST resolve to a real `orgs` row (`findOrg`), else `null`;
 *   2. when the message carries a `userId`, the user MUST have a real membership in that tenant
 *      (`loadMembershipPrincipal`, `null` for a non-member) — so a message can't mint authority for
 *      a user who was removed from the org;
 *   3. otherwise a SYSTEM principal scoped to the validated tenant drives the durable backfill
 *      (full data scope, read|write; never `owner`/`admin`, never auto-instruction).
 * A `null` return is the consumer's signal to reject the message to the DLQ.
 */
export const principalFromMessage = (
  env: BrainBindings,
  message: TenantBearingMessage,
): Promise<Principal | null> => principalFromMessageDb(drizzle(env.DB), message)

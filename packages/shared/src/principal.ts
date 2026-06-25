import { z } from "zod"
import { CapabilitySchema, RoleSchema } from "./enums"

/**
 * The canonical `Principal` — the resolved identity carried below the edge
 * (PRD §1.4 / §7.2). `resolvePrincipal()` runs once per request at the Worker
 * edge and reduces ANY credential to this one immutable shape; no bare token
 * travels below the edge.
 *
 * Two axes are kept strictly separate (PRD §7.2, iteration-2 fix):
 *   - `allowedScopes` — the DATA-partition axis (client/project scopes the
 *     principal may touch). `'*'` = all tenant scopes (the default).
 *   - `capabilities` — the read|write|admin authorization axis, sourced
 *     separately and consumed by `scopeSatisfied`. NEVER fed into the
 *     data-partition predicate.
 *
 * This schema is the source of truth; the `Principal` type is inferred from it.
 * The shape mirrors PRD §7.2 byte-for-byte (7 fields, readonly arrays).
 */
export const PrincipalSchema = z.object({
  /** The hard tenant boundary (= org id); never optional. */
  tenantId: z.string(),
  /** Authorship / actor. */
  userId: z.string(),
  /** Teams the user belongs to within this tenant. */
  teamIds: z.array(z.string()).readonly(),
  role: RoleSchema,
  /**
   * DATA-partition axis: scopes the principal may touch.
   * `'*'` = all tenant scopes (the default — Persona C "staff move freely").
   */
  allowedScopes: z.union([z.array(z.string()).readonly(), z.literal("*")]),
  /**
   * CAPABILITY axis (NOT a data partition): read|write|admin. Sourced from the
   * API key's stored scopes JSON or derived from role; consumed by
   * `scopeSatisfied`.
   */
  capabilities: z.array(CapabilitySchema).readonly(),
  /** True if `role === 'readonly'` OR the credential itself is read-only. */
  readOnly: z.boolean(),
})

export type Principal = z.infer<typeof PrincipalSchema>

/**
 * The credential family a `Principal` was resolved from (PRD §7.2 resolution
 * chain: Clerk JWT → `bdev_` HMAC machine token → `bk_` API key). This is the
 * standalone discriminated `AuthMethod` contract; `resolvePrincipal` (Phase-1
 * `packages/db`) produces it. It is intentionally NOT a field on `Principal`,
 * which keeps the canonical §7.2 shape intact.
 */
export const AUTH_METHOD_KINDS = ["clerk-jwt", "bdev-hmac", "bk-apikey"] as const
export type AuthMethodKind = (typeof AUTH_METHOD_KINDS)[number]

export const AuthMethodSchema = z.discriminatedUnion("kind", [
  /** OAuth 2.1 / Clerk JWT — `jose.jwtVerify` vs JWKS, issuer-checked. */
  z.object({
    kind: z.literal("clerk-jwt"),
    /** Active tenant from the pinned per-surface mechanism, never the JWT alone. */
    tenantId: z.string(),
  }),
  /** `bdev_` HMAC-SHA256 machine token; one per tenant, `tenantId` baked in. */
  z.object({
    kind: z.literal("bdev-hmac"),
    tenantId: z.string(),
  }),
  /** `bk_` API key (SHA-256 hashed, tenant-bound). */
  z.object({
    kind: z.literal("bk-apikey"),
    keyId: z.string(),
    readOnly: z.boolean(),
  }),
])

export type AuthMethod = z.infer<typeof AuthMethodSchema>

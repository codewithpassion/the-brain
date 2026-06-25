/**
 * Admin op CONTRACTS + bound handlers (PRD §7.1/§7.2, §9.2.2 "Admin scope only").
 *
 * `mint_api_key` (scope-bounded `bk_` minting — never escalates past the minter), `get_token_spend`
 * (the tenant's window spend from the `token_spend` ledger), and `memberships` (list/inspect this
 * tenant's memberships). All are `capability: "admin"` and fail CLOSED via `scopeSatisfied` BEFORE
 * touching data — a non-admin (or read-only) principal never reaches a query.
 *
 * Unlike the search/graph `BoundOp`s (which receive pre-built `ScopedServices`), admin handlers
 * receive `{ env, principal }` and build their OWN minimal deps: `mint_api_key` needs the raw
 * `BrainDrizzle` (the auth `mintApiKey` signature), which the scoped bundle deliberately never
 * exposes. Building `drizzle(env.DB)` here is legal — `packages/db` is the ONE sanctioned home of
 * raw bindings (invariant 2); the handlers never hand a raw binding back out.
 */
import {
  type AnyOpDef,
  type Capability,
  CapabilitySchema,
  defineOp,
  MONTHLY_COST_CEILING_USD,
  type OpRegistry,
  type Principal,
  scopeSatisfied,
} from "@brain/shared"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"
import { AuthError } from "../auth/errors"
import { mintApiKey } from "../auth/mint"
import type { BrainBindings } from "../env"
import { memberships as membershipsTable } from "../schema"
import { type BrainDrizzle, ScopedDB } from "../scoped/db"
import { monthlyWindow, USD_PER_NEURON } from "../search/ports"

/** The per-request deps an admin handler builds from (`env` + the resolved `Principal`). */
export interface AdminOpContext {
  env: BrainBindings
  principal: Principal
}

/** A frozen `OpDef` contract paired with its admin runtime handler (mirrors search `BoundOp`). */
export interface AdminBoundOp<I, O> {
  def: AnyOpDef
  handler: (ctx: AdminOpContext, input: I) => Promise<O>
}

/** Fail CLOSED with 403 when the principal lacks the admin capability (or is read-only). */
const assertAdmin = (principal: Principal): void => {
  if (!scopeSatisfied("admin", principal)) {
    throw new AuthError(403, "admin capability required")
  }
}

// ── Op contracts (handler-free; registered into the shared registry) ──────────────

const ScopeGrantSchema = z.union([z.array(z.string()), z.literal("*")])

/** `mint_api_key` — issue a scope-bounded `bk_` key (intersected DOWN to the minter; no escalation). */
export const MINT_API_KEY_OP = defineOp({
  name: "mint_api_key",
  description: "Mint a bk_ API key bounded to a subset of the caller's own scopes + capabilities.",
  capability: "admin",
  readOnly: false,
  input: z.object({
    name: z.string().min(1),
    requestedScopes: ScopeGrantSchema.optional(),
    requestedCapabilities: z.array(CapabilitySchema).optional(),
    readOnly: z.boolean().optional(),
    expiresAt: z.string().optional(),
  }),
  output: z.object({ token: z.string(), keyId: z.string() }),
})

/** `get_token_spend` — the tenant's window spend from the `token_spend` ledger (tenant-scoped). */
export const GET_TOKEN_SPEND_OP = defineOp({
  name: "get_token_spend",
  description: "Report this tenant's AI spend (neurons + USD) for a monthly window vs the ceiling.",
  capability: "admin",
  readOnly: true,
  input: z.object({ window: z.string().optional() }),
  output: z.object({
    window: z.string(),
    neurons: z.number(),
    usd: z.number(),
    ceilingUsd: z.number(),
  }),
})

/** `memberships` — list/inspect this tenant's memberships (owner/admin only). */
export const MEMBERSHIPS_OP = defineOp({
  name: "memberships",
  description: "List the memberships of the caller's tenant (owner/admin only).",
  capability: "admin",
  readOnly: true,
  input: z.object({ userId: z.string().optional() }),
  output: z.object({
    memberships: z.array(
      z.object({
        userId: z.string(),
        role: z.string(),
        teamId: z.string().nullable(),
        allowedScopes: z.string().nullable(),
      }),
    ),
  }),
})

// ── Bound handlers ────────────────────────────────────────────────────────────

export interface MintApiKeyOpInput {
  name: string
  requestedScopes?: readonly string[] | "*"
  requestedCapabilities?: readonly Capability[]
  readOnly?: boolean
  expiresAt?: string
}

/**
 * `mint_api_key` — the minter's grant is the HARD ceiling: `mintApiKey` intersects the request
 * with `minter.{allowedScopes,capabilities}` and ORs `readOnly`, so a restricted admin can only
 * ever produce a SUBSET of its own access (PRD §7.1 iter-3 escalation fix). This op is a thin,
 * gated wrapper; the no-escalation proof lives in `mintApiKey`.
 */
/**
 * The core of `mint_api_key`, operating on a `BrainDrizzle` (the seam the bound handler builds via
 * `drizzle(env.DB)` and the unit tests pass a bun:sqlite Drizzle into). The minter's grant is the
 * HARD ceiling: `mintApiKey` intersects the request with `minter.{allowedScopes,capabilities}` and
 * ORs `readOnly`, so a restricted admin can only ever produce a SUBSET of its own access (PRD §7.1
 * iter-3 escalation fix). This op is a thin, gated wrapper; the no-escalation proof lives in
 * `mintApiKey`.
 */
export const mintApiKeyCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: MintApiKeyOpInput,
): Promise<{ token: string; keyId: string }> => {
  assertAdmin(principal)
  return mintApiKey(db, principal, {
    name: input.name,
    ...(input.requestedScopes !== undefined ? { requestedScopes: input.requestedScopes } : {}),
    ...(input.requestedCapabilities !== undefined
      ? { requestedCapabilities: input.requestedCapabilities }
      : {}),
    ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  })
}

export const mintApiKeyOp: AdminBoundOp<MintApiKeyOpInput, { token: string; keyId: string }> = {
  def: MINT_API_KEY_OP,
  handler: (ctx, input) => mintApiKeyCore(drizzle(ctx.env.DB), ctx.principal, input),
}

export interface TokenSpendOpOutput {
  window: string
  neurons: number
  usd: number
  ceilingUsd: number
}

/** `get_token_spend` core — tenant-scoped sum via `ScopedDB` (tenant_id is FORCED; never cross-tenant). */
export const getTokenSpendCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { window?: string },
): Promise<TokenSpendOpOutput> => {
  assertAdmin(principal)
  const window = input.window ?? monthlyWindow()
  const neurons = await new ScopedDB(db, principal).readWindowSpendNeurons(window)
  return { window, neurons, usd: neurons * USD_PER_NEURON, ceilingUsd: MONTHLY_COST_CEILING_USD }
}

export const getTokenSpendOp: AdminBoundOp<{ window?: string }, TokenSpendOpOutput> = {
  def: GET_TOKEN_SPEND_OP,
  handler: (ctx, input) => getTokenSpendCore(drizzle(ctx.env.DB), ctx.principal, input),
}

export interface MembershipOpRow {
  userId: string
  role: string
  teamId: string | null
  allowedScopes: string | null
}

/** `memberships` core — read THIS tenant's membership rows (tenant_id pinned to `principal.tenantId`). */
export const membershipsCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { userId?: string },
): Promise<{ memberships: MembershipOpRow[] }> => {
  assertAdmin(principal)
  const tenantFilter = eq(membershipsTable.tenantId, principal.tenantId)
  const where =
    input.userId !== undefined
      ? and(tenantFilter, eq(membershipsTable.userId, input.userId))
      : tenantFilter
  const rows = await db
    .select({
      userId: membershipsTable.userId,
      role: membershipsTable.role,
      teamId: membershipsTable.teamId,
      allowedScopes: membershipsTable.allowedScopes,
    })
    .from(membershipsTable)
    .where(where)
  return { memberships: rows }
}

export const membershipsOp: AdminBoundOp<{ userId?: string }, { memberships: MembershipOpRow[] }> =
  {
    def: MEMBERSHIPS_OP,
    handler: (ctx, input) => membershipsCore(drizzle(ctx.env.DB), ctx.principal, input),
  }

/** Every bound admin op. */
export const ADMIN_OPS = [mintApiKeyOp, getTokenSpendOp, membershipsOp] as const

/** Register the admin op CONTRACTS into a shared `OpRegistry` (handlers bind in the surface layer). */
export const registerAdminOps = (registry: OpRegistry): OpRegistry => {
  for (const op of ADMIN_OPS) registry.register(op.def)
  return registry
}

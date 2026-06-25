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
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"
import { AuthError } from "../auth/errors"
import { mintApiKey } from "../auth/mint"
import type { BrainBindings } from "../env"
import {
  backfillRuns,
  chunks,
  documents,
  entities,
  facts,
  memberships as membershipsTable,
  memoryAudit,
  sessions as sessionsTable,
} from "../schema"
import { type BrainDrizzle, ScopedDB } from "../scoped/db"
import { scopePredicate } from "../scoped/predicates"
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

// ── Shared limit schema for list ops ──────────────────────────────────────
const listLimitInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((v) => Math.min(v, 200)),
})

// ── LIST_DOCUMENTS_OP ─────────────────────────────────────────────────────

/** `list_documents` — newest-first tenant doc list for the dashboard. */
export const LIST_DOCUMENTS_OP = defineOp({
  name: "list_documents",
  description: "List this tenant's documents, newest first (dashboard read view).",
  capability: "read",
  readOnly: true,
  input: listLimitInput,
  output: z.object({
    documents: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        title: z.string().nullable(),
        status: z.string(),
        chunkCount: z.number().int(),
        createdAt: z.string().nullable(),
      }),
    ),
  }),
})

export type ListDocumentsRow = {
  id: string
  slug: string
  title: string | null
  status: string
  chunkCount: number
  createdAt: string | null
}

export const listDocumentsCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { limit?: number },
): Promise<{ documents: ListDocumentsRow[] }> => {
  const limit = input.limit ?? 50
  const rows = await db
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      status: documents.status,
      chunkCount: documents.chunkCount,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(eq(documents.tenantId, principal.tenantId), scopePredicate(principal, documents.scope)),
    )
    .orderBy(desc(documents.createdAt))
    .limit(limit)
  return {
    documents: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title ?? null,
      status: r.status,
      chunkCount: r.chunkCount ?? 0,
      createdAt: r.createdAt ?? null,
    })),
  }
}

export const listDocumentsOp: AdminBoundOp<{ limit?: number }, { documents: ListDocumentsRow[] }> =
  {
    def: LIST_DOCUMENTS_OP,
    handler: (ctx, input) => listDocumentsCore(drizzle(ctx.env.DB), ctx.principal, input),
  }

// ── LIST_SESSIONS_OP ──────────────────────────────────────────────────────

/** `list_sessions` — newest-activity-first tenant session list for the dashboard (admin only). */
export const LIST_SESSIONS_OP = defineOp({
  name: "list_sessions",
  description:
    "List this tenant's sessions, newest activity first (admin dashboard view — returns all users' sessions).",
  capability: "admin",
  readOnly: true,
  input: listLimitInput,
  output: z.object({
    sessions: z.array(
      z.object({
        id: z.string(),
        client: z.string(),
        title: z.string().nullable(),
        status: z.string(),
        turnCount: z.number().int(),
        lastActivityAt: z.string(),
        startedAt: z.string(),
      }),
    ),
  }),
})

export type ListSessionRow = {
  id: string
  client: string
  title: string | null
  status: string
  turnCount: number
  lastActivityAt: string
  startedAt: string
}

export const listSessionsCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { limit?: number },
): Promise<{ sessions: ListSessionRow[] }> => {
  assertAdmin(principal)
  const limit = input.limit ?? 50
  const rows = await db
    .select({
      id: sessionsTable.id,
      client: sessionsTable.client,
      title: sessionsTable.title,
      status: sessionsTable.status,
      turnCount: sessionsTable.turnCount,
      lastActivityAt: sessionsTable.lastActivityAt,
      startedAt: sessionsTable.startedAt,
    })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.tenantId, principal.tenantId),
        scopePredicate(principal, sessionsTable.scope),
      ),
    )
    .orderBy(desc(sessionsTable.lastActivityAt))
    .limit(limit)
  return { sessions: rows.map((r) => ({ ...r, title: r.title ?? null })) }
}

export const listSessionsOp: AdminBoundOp<{ limit?: number }, { sessions: ListSessionRow[] }> = {
  def: LIST_SESSIONS_OP,
  handler: (ctx, input) => listSessionsCore(drizzle(ctx.env.DB), ctx.principal, input),
}

// ── LIST_BACKFILL_RUNS_OP ─────────────────────────────────────────────────

/** `list_backfill_runs` — newest-first tenant job/sync run list for the dashboard. */
export const LIST_BACKFILL_RUNS_OP = defineOp({
  name: "list_backfill_runs",
  description: "List this tenant's backfill/sync runs, newest first (jobs dashboard view).",
  capability: "read",
  readOnly: true,
  input: listLimitInput,
  output: z.object({
    runs: z.array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        kind: z.string(),
        direction: z.string(),
        status: z.string(),
        attempts: z.number().int(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
  }),
})

export type ListBackfillRunRow = {
  id: string
  sourceId: string
  kind: string
  direction: string
  status: string
  attempts: number
  createdAt: string
  updatedAt: string
}

export const listBackfillRunsCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { limit?: number },
): Promise<{ runs: ListBackfillRunRow[] }> => {
  const limit = input.limit ?? 50
  const rows = await db
    .select({
      id: backfillRuns.id,
      sourceId: backfillRuns.sourceId,
      kind: backfillRuns.kind,
      direction: backfillRuns.direction,
      status: backfillRuns.status,
      attempts: backfillRuns.attempts,
      createdAt: backfillRuns.createdAt,
      updatedAt: backfillRuns.updatedAt,
    })
    .from(backfillRuns)
    .where(eq(backfillRuns.tenantId, principal.tenantId))
    .orderBy(desc(backfillRuns.createdAt))
    .limit(limit)
  return { runs: rows }
}

export const listBackfillRunsOp: AdminBoundOp<{ limit?: number }, { runs: ListBackfillRunRow[] }> =
  {
    def: LIST_BACKFILL_RUNS_OP,
    handler: (ctx, input) => listBackfillRunsCore(drizzle(ctx.env.DB), ctx.principal, input),
  }

// ── LIST_AUDIT_OP ─────────────────────────────────────────────────────────

/** `list_audit` — newest-first tenant memory audit log for the dashboard (admin only). */
export const LIST_AUDIT_OP = defineOp({
  name: "list_audit",
  description:
    "List this tenant's memory audit entries, newest first (admin dashboard view — returns all users' audit entries).",
  capability: "admin",
  readOnly: true,
  input: listLimitInput,
  output: z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        action: z.string(),
        targetId: z.string().nullable(),
        at: z.number().int(),
      }),
    ),
  }),
})

export type ListAuditEntry = {
  id: string
  userId: string
  action: string
  targetId: string | null
  at: number
}

export const listAuditCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { limit?: number },
): Promise<{ entries: ListAuditEntry[] }> => {
  assertAdmin(principal)
  const limit = input.limit ?? 50
  const rows = await db
    .select({
      id: memoryAudit.id,
      userId: memoryAudit.userId,
      action: memoryAudit.action,
      targetId: memoryAudit.targetId,
      at: memoryAudit.at,
    })
    .from(memoryAudit)
    .where(eq(memoryAudit.tenantId, principal.tenantId))
    .orderBy(desc(memoryAudit.at))
    .limit(limit)
  return { entries: rows.map((r) => ({ ...r, targetId: r.targetId ?? null })) }
}

export const listAuditOp: AdminBoundOp<{ limit?: number }, { entries: ListAuditEntry[] }> = {
  def: LIST_AUDIT_OP,
  handler: (ctx, input) => listAuditCore(drizzle(ctx.env.DB), ctx.principal, input),
}

// ── GET_STATS_OP ──────────────────────────────────────────────────────────

/** `get_stats` — full tenant aggregate counts + current-month spend vs ceiling (admin only). */
export const GET_STATS_OP = defineOp({
  name: "get_stats",
  description:
    "Tenant-wide aggregate counts (docs/chunks/entities/sessions/facts) + current-month token spend vs ceiling (admin only).",
  capability: "admin",
  readOnly: true,
  input: z.object({}),
  output: z.object({
    documents: z.number().int(),
    chunks: z.number().int(),
    entities: z.number().int(),
    sessions: z.number().int(),
    facts: z.number().int(),
    tokenSpendNeurons: z.number(),
    monthlyCeilingUsd: z.number(),
  }),
})

export interface GetStatsOutput {
  documents: number
  chunks: number
  entities: number
  sessions: number
  facts: number
  tokenSpendNeurons: number
  monthlyCeilingUsd: number
}

export const getStatsCore = async (
  db: BrainDrizzle,
  principal: Principal,
): Promise<GetStatsOutput> => {
  assertAdmin(principal)
  const tid = principal.tenantId
  const [docsRes, chunksRes, entitiesRes, sessionsRes, factsRes] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(documents).where(eq(documents.tenantId, tid)),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(chunks)
      .where(and(eq(chunks.tenantId, tid), isNull(chunks.deletedAt))),
    db.select({ count: sql<number>`COUNT(*)` }).from(entities).where(eq(entities.tenantId, tid)),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(sessionsTable)
      .where(eq(sessionsTable.tenantId, tid)),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(facts)
      .where(and(eq(facts.tenantId, tid), isNull(facts.expiredAt))),
  ])
  const tokenSpendNeurons = await new ScopedDB(db, principal).readWindowSpendNeurons(
    monthlyWindow(),
  )
  return {
    documents: Number(docsRes[0]?.count ?? 0),
    chunks: Number(chunksRes[0]?.count ?? 0),
    entities: Number(entitiesRes[0]?.count ?? 0),
    sessions: Number(sessionsRes[0]?.count ?? 0),
    facts: Number(factsRes[0]?.count ?? 0),
    tokenSpendNeurons,
    monthlyCeilingUsd: MONTHLY_COST_CEILING_USD,
  }
}

export const getStatsOp: AdminBoundOp<Record<string, never>, GetStatsOutput> = {
  def: GET_STATS_OP,
  handler: (ctx, _input) => getStatsCore(drizzle(ctx.env.DB), ctx.principal),
}

/** Every bound admin op. */
export const ADMIN_OPS = [
  mintApiKeyOp,
  getTokenSpendOp,
  membershipsOp,
  listDocumentsOp,
  listSessionsOp,
  listBackfillRunsOp,
  listAuditOp,
  getStatsOp,
] as const

/** Register the admin op CONTRACTS into a shared `OpRegistry` (handlers bind in the surface layer). */
export const registerAdminOps = (registry: OpRegistry): OpRegistry => {
  for (const op of ADMIN_OPS) registry.register(op.def)
  return registry
}

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
  orgs as orgsTable,
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

// ── CREATE_ORG_OP ─────────────────────────────────────────────────────────────

/**
 * `create_org` — create a new org with the calling user as OWNER. Any authenticated user can call
 * this; it does not modify the caller's current tenant, it creates a brand-new one. `slug` defaults
 * to a slugified `name` if omitted. On slug conflict the op fails with a clear error (no silent
 * upsert). Auditable: the caller's userId is stored as `created_by` on the new org row.
 */
export const CREATE_ORG_OP = defineOp({
  name: "create_org",
  description: "Create a new org and become its owner. Returns the new org id + slug.",
  capability: "write",
  readOnly: false,
  // rest-only: cross-tenant by nature (creates a brand-new tenant). Exposing on mcp/cli would let
  // a bk_ API key (scoped to the caller's current tenant) or a bdev_ machine token create
  // unrelated tenants, which is outside the key's intended tenant scope.
  surfaces: ["rest"],
  input: z.object({
    name: z.string().min(1).max(128),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
        "slug must be lowercase alphanumeric with hyphens",
      )
      .optional(),
  }),
  output: z.object({ id: z.string(), slug: z.string() }),
})

export interface CreateOrgInput {
  name: string
  slug?: string
}

/** Derive a URL-safe slug from a name. */
const slugifyName = (name: string): string => {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return s.length > 0 ? s : "org"
}

/** Membership id for a new org: same deterministic pattern as auto-provision. */
const newMembershipId = (tenantId: string, userId: string): string => `mem_${tenantId}_${userId}`

export const createOrgCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: CreateOrgInput,
): Promise<{ id: string; slug: string }> => {
  const slug = input.slug ?? slugifyName(input.name)
  // Check slug uniqueness before inserting (gives a clear error vs a raw constraint error).
  const existing = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .where(eq(orgsTable.slug, slug))
    .limit(1)
  if (existing.length > 0) {
    throw new AuthError(409, `slug "${slug}" is already taken`)
  }
  const id = crypto.randomUUID()
  await db.insert(orgsTable).values({
    id,
    name: input.name,
    slug,
    createdBy: principal.userId,
  })
  await db.insert(membershipsTable).values({
    id: newMembershipId(id, principal.userId),
    tenantId: id,
    userId: principal.userId,
    teamId: null,
    role: "owner",
    allowedScopes: null, // NULL = '*' (unrestricted)
  })
  return { id, slug }
}

export const createOrgOp: AdminBoundOp<CreateOrgInput, { id: string; slug: string }> = {
  def: CREATE_ORG_OP,
  handler: (ctx, input) => createOrgCore(drizzle(ctx.env.DB), ctx.principal, input),
}

// ── LIST_ORGS_OP ──────────────────────────────────────────────────────────────

/**
 * `list_orgs` — list all orgs the calling user is a member of. This op is intentionally
 * cross-tenant: it reads `memberships` by `user_id` (not `tenant_id`) so it returns the full set
 * of orgs regardless of which tenant is currently active. This is safe — it only returns the
 * caller's own memberships, never another user's. Powers the dashboard org switcher.
 */
export const LIST_ORGS_OP = defineOp({
  name: "list_orgs",
  description:
    "List all orgs the current user is a member of (cross-org; reads memberships by user_id, not tenant_id). Powers the org switcher.",
  capability: "read",
  readOnly: true,
  // rest-only: cross-tenant enumeration is intentional for the dashboard switcher but should not
  // be reachable via bk_ API keys (which are scoped to a single tenant) or bdev_ machine tokens.
  surfaces: ["rest"],
  input: z.object({}),
  output: z.object({
    orgs: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        role: z.string(),
      }),
    ),
  }),
})

export interface OrgListRow {
  id: string
  slug: string
  name: string
  role: string
}

/**
 * `list_orgs` core — reads memberships by `principal.userId` across ALL tenants, then JOINs
 * orgs to resolve slug + name. Cross-tenant by design and safe: it returns only the caller's
 * own memberships. The highest role per org is surfaced (mirrors `aggregateMemberships`).
 */
export const listOrgsCore = async (
  db: BrainDrizzle,
  principal: Principal,
): Promise<{ orgs: OrgListRow[] }> => {
  const rows = await db
    .select({
      id: orgsTable.id,
      slug: orgsTable.slug,
      name: orgsTable.name,
      role: membershipsTable.role,
    })
    .from(membershipsTable)
    .innerJoin(orgsTable, eq(membershipsTable.tenantId, orgsTable.id))
    .where(eq(membershipsTable.userId, principal.userId))
  // Deduplicate by org id, keeping the highest role (mirrors aggregateMemberships).
  const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1, readonly: 0 }
  const byId = new Map<string, OrgListRow>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    const existingRank = existing ? (ROLE_RANK[existing.role] ?? 0) : -1
    const rowRank = ROLE_RANK[row.role] ?? 0
    if (!existing || rowRank > existingRank) {
      byId.set(row.id, { id: row.id, slug: row.slug, name: row.name, role: row.role })
    }
  }
  return { orgs: [...byId.values()] }
}

export const listOrgsOp: AdminBoundOp<Record<string, never>, { orgs: OrgListRow[] }> = {
  def: LIST_ORGS_OP,
  handler: (ctx, _input) => listOrgsCore(drizzle(ctx.env.DB), ctx.principal),
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
  createOrgOp,
  listOrgsOp,
] as const

/** Register the admin op CONTRACTS into a shared `OpRegistry` (handlers bind in the surface layer). */
export const registerAdminOps = (registry: OpRegistry): OpRegistry => {
  for (const op of ADMIN_OPS) registry.register(op.def)
  return registry
}

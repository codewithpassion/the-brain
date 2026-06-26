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
  apiKeys,
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

/** `list_documents` — newest-first tenant doc list for the dashboard, with optional filters. */
export const LIST_DOCUMENTS_OP = defineOp({
  name: "list_documents",
  description:
    "List this tenant's documents, newest first (dashboard read view). Filterable by tag, path prefix, and created_at date range.",
  capability: "read",
  readOnly: true,
  input: listLimitInput.extend({
    tag: z.string().optional(), // filter: document has this tag (exact match within JSON array)
    path: z.string().optional(), // filter: document path equals or is under this prefix
    since: z.string().optional(), // filter: created_at >= this ISO date string
    until: z.string().optional(), // filter: created_at <= this ISO date string
  }),
  output: z.object({
    documents: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        title: z.string().nullable(),
        status: z.string(),
        chunkCount: z.number().int(),
        userId: z.string(), // authorship — the user who ingested the document
        createdAt: z.string().nullable(),
        tags: z.array(z.string()),
        path: z.string().nullable(),
      }),
    ),
  }),
})

export interface ListDocumentsInput {
  limit?: number
  tag?: string
  path?: string
  since?: string
  until?: string
}

export type ListDocumentsRow = {
  id: string
  slug: string
  title: string | null
  status: string
  chunkCount: number
  userId: string
  createdAt: string | null
  tags: string[]
  path: string | null
}

export const listDocumentsCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: ListDocumentsInput,
): Promise<{ documents: ListDocumentsRow[] }> => {
  const limit = input.limit ?? 50
  const rows = await db
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      status: documents.status,
      chunkCount: documents.chunkCount,
      userId: documents.userId,
      createdAt: documents.createdAt,
      tags: documents.tags,
      path: documents.path,
    })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, principal.tenantId),
        scopePredicate(principal, documents.scope),
        // tag filter: JSON array contains the given tag (exact element match)
        input.tag !== undefined
          ? sql`EXISTS (SELECT 1 FROM json_each(${documents.tags}) WHERE value = ${input.tag})`
          : undefined,
        // path filter: exact match OR true child (prefix + "/")
        input.path !== undefined
          ? sql`(${documents.path} = ${input.path} OR ${documents.path} LIKE ${`${input.path}/%`})`
          : undefined,
        // date range filters on created_at (ISO 8601 sorts lexicographically)
        input.since !== undefined ? sql`${documents.createdAt} >= ${input.since}` : undefined,
        input.until !== undefined ? sql`${documents.createdAt} <= ${input.until}` : undefined,
      ),
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
      userId: r.userId,
      createdAt: r.createdAt ?? null,
      tags: JSON.parse(r.tags ?? "[]") as string[],
      path: r.path ?? null,
    })),
  }
}

export const listDocumentsOp: AdminBoundOp<ListDocumentsInput, { documents: ListDocumentsRow[] }> =
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
        userId: z.string(), // authorship — the user who owns the session
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
  userId: string
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
      userId: sessionsTable.userId,
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
    createdBy: principal.userId, // owner created their own membership when creating the org
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

// ── SEARCH_USER_BY_EMAIL_OP ───────────────────────────────────────────────────

/**
 * Internal shape of a Clerk BAPI user object (only the fields we consume).
 * `GET https://api.clerk.com/v1/users?email_address=<email>` → array of these.
 */
interface ClerkBapiEmailAddress {
  id: string
  email_address: string
}

interface ClerkBapiUser {
  id: string
  email_addresses: ClerkBapiEmailAddress[]
  primary_email_address_id: string | null
  first_name: string | null
  last_name: string | null
  image_url: string
}

export interface ClerkUserResult {
  userId: string
  email: string
  firstName?: string
  lastName?: string
  imageUrl?: string
}

/** `search_user_by_email` — look up a Brain user by email via the Clerk Backend API. */
export const SEARCH_USER_BY_EMAIL_OP = defineOp({
  name: "search_user_by_email",
  description:
    "Look up a Brain user by email address via the Clerk Backend API. Returns user info or null if not found (they must have signed in at least once).",
  capability: "admin",
  readOnly: true,
  surfaces: ["rest"],
  input: z.object({ email: z.string().email() }),
  output: z.object({
    user: z
      .object({
        userId: z.string(),
        email: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        imageUrl: z.string().optional(),
      })
      .nullable(),
  }),
})

/**
 * `search_user_by_email` core — fetches from the Clerk BAPI. Injectable `fetcher` (default =
 * global `fetch`) lets tests pass a stub without network access.
 */
export const searchUserByEmailCore = async (
  clerkSecretKey: string | undefined,
  email: string,
  fetcher: typeof fetch = fetch,
): Promise<ClerkUserResult | null> => {
  if (!clerkSecretKey) {
    throw new AuthError(500, "CLERK_SECRET_KEY is not configured")
  }
  const url = `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`
  const resp = await fetcher(url, {
    headers: { Authorization: `Bearer ${clerkSecretKey}` },
  })
  if (!resp.ok) {
    throw new AuthError(502, `Clerk BAPI error: ${resp.status}`)
  }
  // The Clerk BAPI returns a bare array in most documented examples, but some versions wrap it in
  // { data: [...] }. Tolerate both so a future Clerk update doesn't silently break lookups.
  const payload = (await resp.json()) as ClerkBapiUser[] | { data: ClerkBapiUser[] }
  const users = Array.isArray(payload)
    ? payload
    : ((payload as { data?: ClerkBapiUser[] }).data ?? [])
  if (users.length === 0) return null
  const user = users[0]
  if (user === undefined) return null
  const primaryEmail =
    user.email_addresses.find((e) => e.id === user.primary_email_address_id)?.email_address ??
    user.email_addresses[0]?.email_address ??
    email
  return {
    userId: user.id,
    email: primaryEmail,
    ...(user.first_name ? { firstName: user.first_name } : {}),
    ...(user.last_name ? { lastName: user.last_name } : {}),
    ...(user.image_url ? { imageUrl: user.image_url } : {}),
  }
}

export const searchUserByEmailOp: AdminBoundOp<
  { email: string },
  { user: ClerkUserResult | null }
> = {
  def: SEARCH_USER_BY_EMAIL_OP,
  handler: (ctx, input) =>
    searchUserByEmailCore(ctx.env.CLERK_SECRET_KEY, input.email).then((user) => ({ user })),
}

// ── ADD_MEMBER_OP ─────────────────────────────────────────────────────────────

/** `add_member` — add a Brain user to the active org by email (owner/admin only). */
export const ADD_MEMBER_OP = defineOp({
  name: "add_member",
  description:
    "Add a Brain user to the active org by email (owner/admin only). The user must have signed in at least once. Rejects duplicates.",
  capability: "admin",
  readOnly: false,
  surfaces: ["rest"],
  input: z.object({
    email: z.string().email(),
    role: z.enum(["owner", "admin", "member", "readonly"]),
    allowedScopes: ScopeGrantSchema.optional(),
  }),
  output: z.object({ userId: z.string(), membershipId: z.string() }),
})

export interface AddMemberInput {
  email: string
  role: "owner" | "admin" | "member" | "readonly"
  allowedScopes?: readonly string[] | "*"
}

export const addMemberCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: AddMemberInput,
  clerkSecretKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ userId: string; membershipId: string }> => {
  assertAdmin(principal)

  // Resolve email → Clerk userId via the BAPI.
  const clerkUser = await searchUserByEmailCore(clerkSecretKey, input.email, fetcher)
  if (!clerkUser) {
    throw new AuthError(404, "no Brain user with that email — they must sign in once first")
  }

  const { userId } = clerkUser
  const membershipId = `mem_${principal.tenantId}_${userId}`

  // Reject duplicates (same user already a member of this tenant).
  const existing = await db
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(eq(membershipsTable.tenantId, principal.tenantId), eq(membershipsTable.userId, userId)),
    )
    .limit(1)
  if (existing.length > 0) {
    throw new AuthError(409, `user ${userId} is already a member of this org`)
  }

  const allowedScopes =
    input.allowedScopes !== undefined
      ? input.allowedScopes === "*"
        ? null
        : JSON.stringify(input.allowedScopes)
      : null // NULL = '*' (unrestricted)

  await db.insert(membershipsTable).values({
    id: membershipId,
    tenantId: principal.tenantId,
    userId,
    teamId: null,
    role: input.role,
    allowedScopes,
    createdBy: principal.userId, // the admin who added this member
  })

  // Audit: actor = principal.userId, target = the newly added userId.
  await db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: principal.tenantId,
    userId: principal.userId,
    action: "member.add",
    targetId: userId,
    at: Date.now(),
  })

  return { userId, membershipId }
}

export const addMemberOp: AdminBoundOp<AddMemberInput, { userId: string; membershipId: string }> = {
  def: ADD_MEMBER_OP,
  handler: (ctx, input) =>
    addMemberCore(drizzle(ctx.env.DB), ctx.principal, input, ctx.env.CLERK_SECRET_KEY),
}

// ── UPDATE_MEMBER_OP ──────────────────────────────────────────────────────────

/** `update_member` — update a member's role or allowed scopes (owner/admin only). */
export const UPDATE_MEMBER_OP = defineOp({
  name: "update_member",
  description:
    "Update a member's role or allowed scopes in the active org (owner/admin only). Protects the last owner from demotion.",
  capability: "admin",
  readOnly: false,
  surfaces: ["rest"],
  input: z.object({
    userId: z.string().min(1),
    role: z.enum(["owner", "admin", "member", "readonly"]).optional(),
    allowedScopes: ScopeGrantSchema.optional(),
  }),
  output: z.object({ userId: z.string(), updated: z.boolean() }),
})

export interface UpdateMemberInput {
  userId: string
  role?: "owner" | "admin" | "member" | "readonly"
  allowedScopes?: readonly string[] | "*"
}

/** Count owner-role memberships in this tenant (for the last-owner guard). */
const countOwners = async (db: BrainDrizzle, tenantId: string): Promise<number> => {
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(membershipsTable)
    .where(and(eq(membershipsTable.tenantId, tenantId), eq(membershipsTable.role, "owner")))
  return Number(rows[0]?.count ?? 0)
}

export const updateMemberCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: UpdateMemberInput,
): Promise<{ userId: string; updated: boolean }> => {
  assertAdmin(principal)

  // Fetch the current membership to check role.
  const existing = await db
    .select({ id: membershipsTable.id, role: membershipsTable.role })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.tenantId, principal.tenantId),
        eq(membershipsTable.userId, input.userId),
      ),
    )
    .limit(1)

  if (existing.length === 0) {
    throw new AuthError(404, `user ${input.userId} is not a member of this org`)
  }

  const current = existing[0]
  if (current === undefined)
    throw new AuthError(404, `user ${input.userId} is not a member of this org`)

  // Last-owner guard: prevent demoting the last owner.
  if (current.role === "owner" && input.role !== undefined && input.role !== "owner") {
    const ownerCount = await countOwners(db, principal.tenantId)
    if (ownerCount <= 1) {
      throw new AuthError(409, "cannot demote the last owner of the org")
    }
  }

  if (input.role === undefined && input.allowedScopes === undefined) {
    return { userId: input.userId, updated: false }
  }

  await db
    .update(membershipsTable)
    .set({
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.allowedScopes !== undefined
        ? {
            allowedScopes: input.allowedScopes === "*" ? null : JSON.stringify(input.allowedScopes),
          }
        : {}),
    })
    .where(
      and(
        eq(membershipsTable.tenantId, principal.tenantId),
        eq(membershipsTable.userId, input.userId),
      ),
    )

  const diff: Record<string, unknown> = {}
  if (input.role !== undefined) diff.role = input.role
  if (input.allowedScopes !== undefined) diff.allowedScopes = input.allowedScopes

  await db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: principal.tenantId,
    userId: principal.userId,
    action: "member.update",
    targetId: input.userId,
    at: Date.now(),
    diff: JSON.stringify(diff),
  })

  return { userId: input.userId, updated: true }
}

export const updateMemberOp: AdminBoundOp<UpdateMemberInput, { userId: string; updated: boolean }> =
  {
    def: UPDATE_MEMBER_OP,
    handler: (ctx, input) => updateMemberCore(drizzle(ctx.env.DB), ctx.principal, input),
  }

// ── REMOVE_MEMBER_OP ──────────────────────────────────────────────────────────

/** `remove_member` — remove a member from the active org (owner/admin only). */
export const REMOVE_MEMBER_OP = defineOp({
  name: "remove_member",
  description:
    "Remove a member from the active org (owner/admin only). Protects the last owner from removal.",
  capability: "admin",
  readOnly: false,
  surfaces: ["rest"],
  input: z.object({ userId: z.string().min(1) }),
  output: z.object({ userId: z.string(), removed: z.boolean() }),
})

export const removeMemberCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { userId: string },
): Promise<{ userId: string; removed: boolean }> => {
  assertAdmin(principal)

  // Fetch the current membership to check role.
  const existing = await db
    .select({ id: membershipsTable.id, role: membershipsTable.role })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.tenantId, principal.tenantId),
        eq(membershipsTable.userId, input.userId),
      ),
    )
    .limit(1)

  if (existing.length === 0) {
    return { userId: input.userId, removed: false }
  }

  const current = existing[0]
  if (current === undefined) return { userId: input.userId, removed: false }

  // Last-owner guard: prevent removing the last owner.
  if (current.role === "owner") {
    const ownerCount = await countOwners(db, principal.tenantId)
    if (ownerCount <= 1) {
      throw new AuthError(409, "cannot remove the last owner of the org")
    }
  }

  await db
    .delete(membershipsTable)
    .where(
      and(
        eq(membershipsTable.tenantId, principal.tenantId),
        eq(membershipsTable.userId, input.userId),
      ),
    )

  await db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: principal.tenantId,
    userId: principal.userId,
    action: "member.remove",
    targetId: input.userId,
    at: Date.now(),
  })

  return { userId: input.userId, removed: true }
}

export const removeMemberOp: AdminBoundOp<
  { userId: string },
  { userId: string; removed: boolean }
> = {
  def: REMOVE_MEMBER_OP,
  handler: (ctx, input) => removeMemberCore(drizzle(ctx.env.DB), ctx.principal, input),
}

// ── LIST_API_KEYS_OP ──────────────────────────────────────────────────────────

/** `list_api_keys` — REDACTED tenant key listing (no key_hash, no raw token). */
export const LIST_API_KEYS_OP = defineOp({
  name: "list_api_keys",
  description:
    "List this tenant's API keys (REDACTED — no key_hash, no raw token). Admin only. read-only.",
  capability: "admin",
  readOnly: true,
  surfaces: ["rest"],
  input: z.object({}),
  output: z.object({
    keys: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        keyPrefix: z.string(),
        scopes: z.array(z.string()),
        allowedScopes: z.string().nullable(),
        readOnly: z.boolean(),
        createdAt: z.string().nullable(),
        lastUsedAt: z.string().nullable(),
        revokedAt: z.string().nullable(),
      }),
    ),
  }),
})

export interface ApiKeyRow {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  allowedScopes: string | null
  readOnly: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

export const listApiKeysCore = async (
  db: BrainDrizzle,
  principal: Principal,
): Promise<{ keys: ApiKeyRow[] }> => {
  assertAdmin(principal)
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      allowedScopes: apiKeys.allowedScopes,
      readOnly: apiKeys.readOnly,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, principal.tenantId))
    .orderBy(desc(apiKeys.createdAt))
  return {
    keys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      scopes: JSON.parse(r.scopes) as string[],
      allowedScopes: r.allowedScopes,
      readOnly: r.readOnly === 1,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    })),
  }
}

export const listApiKeysOp: AdminBoundOp<Record<string, never>, { keys: ApiKeyRow[] }> = {
  def: LIST_API_KEYS_OP,
  handler: (ctx, _input) => listApiKeysCore(drizzle(ctx.env.DB), ctx.principal),
}

// ── CREATE_API_KEY_OP ─────────────────────────────────────────────────────────

/** `create_api_key` — tenant-admin CRUD entry for minting a `bk_` key (one-clear-create-path). */
export const CREATE_API_KEY_OP = defineOp({
  name: "create_api_key",
  description:
    "Mint a bk_ API key bound to the active tenant. Returns the raw token ONCE — store it immediately. Admin only.",
  capability: "admin",
  readOnly: false,
  surfaces: ["rest"],
  input: z.object({
    name: z.string().min(1),
    scopes: z.array(CapabilitySchema).optional(),
    allowedScopes: ScopeGrantSchema.optional(),
    readOnly: z.boolean().optional(),
  }),
  output: z.object({
    token: z.string(),
    keyId: z.string(),
    keyPrefix: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
  }),
})

export interface CreateApiKeyInput {
  name: string
  scopes?: readonly Capability[]
  allowedScopes?: readonly string[] | "*"
  readOnly?: boolean
}

export interface CreateApiKeyOutput {
  token: string
  keyId: string
  keyPrefix: string
  name: string
  scopes: string[]
}

/**
 * `create_api_key` core — calls `mintApiKey` (the one minting path; no duplication), writes an
 * `apikey.create` audit row, and returns the raw token ONCE alongside the stored metadata. The
 * `scopes` input maps to capabilities (`requestedCapabilities`); `allowedScopes` is the
 * DATA-partition grant (`requestedScopes`). The escalation guard lives in `mintApiKey`.
 */
export const createApiKeyCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: CreateApiKeyInput,
): Promise<CreateApiKeyOutput> => {
  assertAdmin(principal)
  const { token, keyId } = await mintApiKey(db, principal, {
    name: input.name,
    ...(input.scopes !== undefined ? { requestedCapabilities: input.scopes } : {}),
    ...(input.allowedScopes !== undefined ? { requestedScopes: input.allowedScopes } : {}),
    ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
  })
  await db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: principal.tenantId,
    userId: principal.userId,
    action: "apikey.create",
    targetId: keyId,
    at: Date.now(),
  })
  // Read back the stored scopes (intersection happened inside mintApiKey).
  const rows = await db
    .select({ scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1)
  const storedScopes = rows[0]?.scopes ? (JSON.parse(rows[0].scopes) as string[]) : []
  return { token, keyId, keyPrefix: token.slice(0, 11), name: input.name, scopes: storedScopes }
}

export const createApiKeyOp: AdminBoundOp<CreateApiKeyInput, CreateApiKeyOutput> = {
  def: CREATE_API_KEY_OP,
  handler: (ctx, input) => createApiKeyCore(drizzle(ctx.env.DB), ctx.principal, input),
}

// ── REVOKE_API_KEY_OP ─────────────────────────────────────────────────────────

/** `revoke_api_key` — set `revoked_at` on an api_key row (tenant-scoped; no-op if not in tenant). */
export const REVOKE_API_KEY_OP = defineOp({
  name: "revoke_api_key",
  description:
    "Revoke a bk_ API key for the active tenant. No-op if keyId is not in this tenant. Admin only.",
  capability: "admin",
  readOnly: false,
  surfaces: ["rest"],
  input: z.object({ keyId: z.string().min(1) }),
  output: z.object({ keyId: z.string(), revoked: z.boolean() }),
})

export const revokeApiKeyCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { keyId: string },
): Promise<{ keyId: string; revoked: boolean }> => {
  assertAdmin(principal)
  const existing = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.tenantId, principal.tenantId)))
    .limit(1)
  if (existing.length === 0) {
    return { keyId: input.keyId, revoked: false } // not in this tenant — no-op
  }
  const now = new Date().toISOString()
  await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.tenantId, principal.tenantId)))
  await db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: principal.tenantId,
    userId: principal.userId,
    action: "apikey.revoke",
    targetId: input.keyId,
    at: Date.now(),
  })
  return { keyId: input.keyId, revoked: true }
}

export const revokeApiKeyOp: AdminBoundOp<{ keyId: string }, { keyId: string; revoked: boolean }> =
  {
    def: REVOKE_API_KEY_OP,
    handler: (ctx, input) => revokeApiKeyCore(drizzle(ctx.env.DB), ctx.principal, input),
  }

// ── INGEST_DOCUMENT_OP ────────────────────────────────────────────────────────

/**
 * `ingest_document` — ingest a document (text/markdown or text/plain) into the knowledge
 * base with optional namespace path and tags. Capability `write`; surfaces all three.
 * The full pipeline (fingerprint → R2 → documents row → chunk → embed → index) runs via the
 * BATCH_INGEST Workflow when the binding is present, or inline otherwise. Handler lives in
 * `packages/surface/src/catalog.ts` (it needs `ScopedServices` for R2/AI/Vectorize).
 */
export const INGEST_DOCUMENT_OP = defineOp({
  name: "ingest_document",
  description:
    "Ingest a text document into the knowledge base. Accepts text/markdown or text/plain. " +
    "Supports optional namespace path (e.g. /project/x) and tags array for filtering. " +
    "Returns accepted (workflow-dispatched) or indexed (inline) status.",
  capability: "write",
  readOnly: false,
  input: z.object({
    content: z.string().min(1),
    title: z.string().optional(),
    path: z.string().optional(),
    tags: z.array(z.string()).optional(),
    contentType: z.enum(["text/markdown", "text/plain"]).optional().default("text/markdown"),
  }),
  output: z.object({
    documentId: z.string().nullable(),
    slug: z.string(),
    status: z.enum(["accepted", "indexed", "duplicate"]),
    chunkCount: z.number().int(),
  }),
})

/** Every bound admin op. */
export const ADMIN_OPS = [
  mintApiKeyOp,
  listApiKeysOp,
  createApiKeyOp,
  revokeApiKeyOp,
  getTokenSpendOp,
  membershipsOp,
  listDocumentsOp,
  listSessionsOp,
  listBackfillRunsOp,
  listAuditOp,
  getStatsOp,
  createOrgOp,
  listOrgsOp,
  searchUserByEmailOp,
  addMemberOp,
  updateMemberOp,
  removeMemberOp,
] as const

/** Register the admin op CONTRACTS into a shared `OpRegistry` (handlers bind in the surface layer). */
export const registerAdminOps = (registry: OpRegistry): OpRegistry => {
  for (const op of ADMIN_OPS) registry.register(op.def)
  // ingest_document: registered separately; handler lives in the surface catalog (needs ScopedServices)
  registry.register(INGEST_DOCUMENT_OP)
  return registry
}

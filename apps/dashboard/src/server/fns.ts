/**
 * The `createServerFn` data layer — the ONLY bridge between the browser and `apps/api`. Every handler
 * runs server-side, resolves the credential + tenant pin via `brain.ts`, and dispatches a single
 * registered op. The browser calls these isomorphic functions; it never sees a bearer or names a
 * tenant (invariant 17). Read fns return a `{ ok }` envelope so the UI degrades (API down, or a
 * non-admin hitting an admin op) instead of throwing into the error boundary.
 */
import { createServerFn } from "@tanstack/react-start"
import { brainCall, resolveBrainAuth } from "./brain"
import { foldDocuments } from "./derive"
import type {
  BrainSessionInfo,
  BrainStats,
  DerivedDocument,
  FindOrphansResult,
  ListAuditResult,
  ListBackfillRunsResult,
  ListEntitiesResult,
  ListSessionsResult,
  MembershipsResult,
  RecallResult,
  SearchResult,
  ThinkResult,
  TokenSpend,
  TraversalResult,
} from "./types"

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : "request failed",
})

/** The server-pinned tenant identity for the indicator (no secrets leave the server). */
export const getSessionInfo = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<BrainSessionInfo>> => {
    try {
      const { tenant, userId } = await resolveBrainAuth()
      return { ok: true, data: { tenant, userId } }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `think` — answer + evidence + citations over the tenant's ingested corpus. */
export const think = createServerFn({ method: "POST" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }): Promise<Result<ThinkResult>> => {
    try {
      const out = await brainCall<ThinkResult>("think", true, { query: data.query, topK: 12 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/**
 * Documents view — DERIVED from a `search` (v1 exposes no list-documents op). Distinct documents are
 * folded from the hits (best score + a representative snippet per document). Honestly NOT a full
 * catalog: it lists documents MATCHING the query.
 */
export const listDocuments = createServerFn({ method: "POST" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }): Promise<Result<DerivedDocument[]>> => {
    try {
      const out = await brainCall<SearchResult>("search", true, { query: data.query, topK: 50 })
      return { ok: true, data: foldDocuments(out.hits) }
    } catch (error) {
      return fail(error)
    }
  })

/** `get_token_spend` (admin) — the tenant's monthly AI spend vs the ceiling. */
export const getTokenSpend = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<TokenSpend>> => {
    try {
      const out = await brainCall<TokenSpend>("get_token_spend", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `memberships` (admin) — this tenant's membership rows. */
export const getMemberships = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<MembershipsResult>> => {
    try {
      const out = await brainCall<MembershipsResult>("memberships", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

// --- Graph ops ---

/** `list_entities` — all entities in the knowledge graph. */
export const getEntities = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListEntitiesResult>> => {
    try {
      const out = await brainCall<ListEntitiesResult>("list_entities", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `search_entities` — search entities by query string. */
export const searchEntities = createServerFn({ method: "POST" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }): Promise<Result<ListEntitiesResult>> => {
    try {
      const out = await brainCall<ListEntitiesResult>("search_entities", true, {
        query: data.query,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `traverse_graph` — neighbors of a seed entity. */
export const traverseGraph = createServerFn({ method: "POST" })
  .validator((d: { seedId: string }) => d)
  .handler(async ({ data }): Promise<Result<TraversalResult>> => {
    try {
      const out = await brainCall<TraversalResult>("traverse_graph", true, { seedId: data.seedId })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `find_orphans` — entities with no links. */
export const findOrphans = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<FindOrphansResult>> => {
    try {
      const out = await brainCall<FindOrphansResult>("find_orphans", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

// --- Session ops ---

/** `list_sessions` — recent conversation sessions. */
export const getSessions = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListSessionsResult>> => {
    try {
      const out = await brainCall<ListSessionsResult>("list_sessions", true, { limit: 50 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `recall` — retrieve facts from session memory by query. */
export const recallQuery = createServerFn({ method: "POST" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }): Promise<Result<RecallResult>> => {
    try {
      const out = await brainCall<RecallResult>("recall", true, { query: data.query })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Audit ops ---

/** `list_audit` — append-only audit log entries, newest first. */
export const getAudit = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListAuditResult>> => {
    try {
      const out = await brainCall<ListAuditResult>("list_audit", true, { limit: 100 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

// --- Jobs ops ---

/** `list_backfill_runs` — backfill / re-embed job history. */
export const getBackfillRuns = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListBackfillRunsResult>> => {
    try {
      const out = await brainCall<ListBackfillRunsResult>("list_backfill_runs", true, { limit: 50 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

// --- Aggregate stats ---

/** `get_stats` — document/chunk/entity/session/fact counts plus spend ceiling. */
export const getBrainStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<BrainStats>> => {
    try {
      const out = await brainCall<BrainStats>("get_stats", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

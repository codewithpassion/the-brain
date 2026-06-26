/**
 * The `createServerFn` data layer — the ONLY bridge between the browser and `apps/api`. Every handler
 * runs server-side, resolves the credential + tenant pin via `brain.ts`, and dispatches a single
 * registered op. The browser calls these isomorphic functions; it never sees a bearer or names a
 * tenant (invariant 17). Read fns return a `{ ok }` envelope so the UI degrades (API down, or a
 * non-admin hitting an admin op) instead of throwing into the error boundary.
 */
import { env } from "cloudflare:workers"
import { createServerFn } from "@tanstack/react-start"
import { brainCall, resolveBrainAuth } from "./brain"
import { foldDocuments } from "./derive"
import type {
  AddMemberResult,
  BrainSessionInfo,
  BrainStats,
  CreateApiKeyResult,
  CreateOrgResult,
  DerivedDocument,
  FindOrphansResult,
  ListApiKeysResult,
  ListAuditResult,
  ListBackfillRunsResult,
  ListDocumentsResult,
  ListEntitiesResult,
  ListOrgsResult,
  ListSessionsResult,
  MembershipsResult,
  RecallResult,
  RemoveMemberResult,
  RevokeApiKeyResult,
  SearchResult,
  SearchUserByEmailResult,
  ThinkResult,
  TokenSpend,
  TraversalResult,
  UpdateMemberResult,
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

/** `list_documents` — the full document catalog for this tenant. */
export const getDocuments = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListDocumentsResult>> => {
    try {
      const out = await brainCall<ListDocumentsResult>("list_documents", true, { limit: 100 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** Content search — DERIVED from a `search` hit-fold; used by the documents search box. */
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

// --- Document upload ---

/** Ingest result returned by the API `/documents` endpoint. */
export interface IngestResult {
  documentId: string | null
  slug: string
  status: "indexed" | "accepted" | "duplicate"
  chunkCount: number
  deduped?: boolean
}

/**
 * Upload a document to the brain via the `/documents` endpoint. The `body` field is
 * always base64-encoded so the server fn transport (JSON) handles binary content types
 * (PDF, DOCX, images) correctly. Text bodies are base64-encoded in the browser too,
 * for a uniform decode path server-side.
 */
export const ingestDocument = createServerFn({ method: "POST" })
  .validator((d: { contentType: string; body: string; slug?: string; title?: string }) => d)
  .handler(async ({ data }): Promise<Result<IngestResult>> => {
    try {
      const { token, tenant } = await resolveBrainAuth()
      const apiBase = (process.env.BRAIN_API_URL ?? "http://localhost:8787").replace(/\/$/, "")

      // Decode base64 body → Uint8Array (works for both text and binary content).
      const binaryStr = atob(data.body)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

      const params = new URLSearchParams()
      if (data.slug) params.set("slug", data.slug)
      if (data.title) params.set("title", data.title)
      const qs = params.size > 0 ? `?${params.toString()}` : ""

      const res = await env.BRAIN_API.fetch(`${apiBase}/documents${qs}`, {
        method: "POST",
        headers: {
          "content-type": data.contentType,
          authorization: `Bearer ${token}`,
          "x-brain-tenant": tenant,
        },
        body: bytes,
      })
      if (!res.ok) {
        const payload = (await res.json()) as Record<string, unknown>
        throw new Error(String(payload.error ?? `ingest failed (${res.status})`))
      }
      const result = (await res.json()) as IngestResult
      return { ok: true, data: result }
    } catch (error) {
      return fail(error)
    }
  })

// --- Org management ---

/**
 * `list_orgs` — all orgs the current user is a member of (cross-org; reads memberships by
 * user_id, not tenant_id). Powers the org switcher dropdown.
 */
export const listOrgs = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListOrgsResult>> => {
    try {
      const out = await brainCall<ListOrgsResult>("list_orgs", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/**
 * `create_org` — create a new org with the calling user as owner. Returns `{id, slug}`.
 * On slug conflict the API returns a 409 error surfaced as `{ok: false}`.
 */
export const createOrg = createServerFn({ method: "POST" })
  .validator((d: { name: string; slug?: string }) => d)
  .handler(async ({ data }): Promise<Result<CreateOrgResult>> => {
    try {
      const out = await brainCall<CreateOrgResult>("create_org", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Membership management ---

/**
 * `search_user_by_email` (admin) — look up a Brain user by email via Clerk BAPI.
 * Returns the user info or null if they haven't signed in yet.
 */
export const searchUserByEmail = createServerFn({ method: "POST" })
  .validator((d: { email: string }) => d)
  .handler(async ({ data }): Promise<Result<SearchUserByEmailResult>> => {
    try {
      const out = await brainCall<SearchUserByEmailResult>("search_user_by_email", true, {
        email: data.email,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/**
 * `add_member` (admin) — add a Brain user to the active org by email.
 */
export const addMember = createServerFn({ method: "POST" })
  .validator((d: { email: string; role: string; allowedScopes?: string[] | "*" }) => d)
  .handler(async ({ data }): Promise<Result<AddMemberResult>> => {
    try {
      const out = await brainCall<AddMemberResult>("add_member", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/**
 * `update_member` (admin) — update a member's role or allowed scopes.
 */
export const updateMember = createServerFn({ method: "POST" })
  .validator((d: { userId: string; role?: string; allowedScopes?: string[] | "*" }) => d)
  .handler(async ({ data }): Promise<Result<UpdateMemberResult>> => {
    try {
      const out = await brainCall<UpdateMemberResult>("update_member", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/**
 * `remove_member` (admin) — remove a member from the active org.
 */
export const removeMember = createServerFn({ method: "POST" })
  .validator((d: { userId: string }) => d)
  .handler(async ({ data }): Promise<Result<RemoveMemberResult>> => {
    try {
      const out = await brainCall<RemoveMemberResult>("remove_member", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- API key management ---

/** `list_api_keys` (admin) — REDACTED tenant key listing (no key_hash, no raw token). */
export const listApiKeys = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListApiKeysResult>> => {
    try {
      const out = await brainCall<ListApiKeysResult>("list_api_keys", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `create_api_key` (admin) — mint a bk_ key bound to the active tenant. Returns raw token ONCE. */
export const createApiKey = createServerFn({ method: "POST" })
  .validator(
    (d: { name: string; scopes?: string[]; allowedScopes?: string[] | "*"; readOnly?: boolean }) =>
      d,
  )
  .handler(async ({ data }): Promise<Result<CreateApiKeyResult>> => {
    try {
      const out = await brainCall<CreateApiKeyResult>("create_api_key", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `revoke_api_key` (admin) — set revoked_at on a key row (tenant-scoped; no-op if not in tenant). */
export const revokeApiKey = createServerFn({ method: "POST" })
  .validator((d: { keyId: string }) => d)
  .handler(async ({ data }): Promise<Result<RevokeApiKeyResult>> => {
    try {
      const out = await brainCall<RevokeApiKeyResult>("revoke_api_key", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- CLI device-flow activation ---

/**
 * Approve a pending CLI device-flow session (POST /activate on the API). The Clerk session token
 * is attached server-side; the user_code comes from the dashboard URL's `?user_code=` param.
 * Routes through the BRAIN_API service binding (same pattern as brainCall's authFetch).
 */
export const activateCliCode = createServerFn({ method: "POST" })
  .validator((d: { userCode: string }) => d)
  .handler(async ({ data }): Promise<Result<{ ok: boolean }>> => {
    try {
      const { token } = await resolveBrainAuth()
      const apiBase = (process.env.BRAIN_API_URL ?? "http://localhost:8787").replace(/\/$/, "")
      const res = await env.BRAIN_API.fetch(`${apiBase}/activate`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${token}`,
        },
        body: new URLSearchParams({ user_code: data.userCode }).toString(),
      })
      if (!res.ok) {
        const body = (await res.json()) as Record<string, unknown>
        throw new Error(String(body.error ?? `activation failed (${res.status})`))
      }
      return { ok: true, data: { ok: true } }
    } catch (error) {
      return fail(error)
    }
  })

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
  ConfirmNotionConnectionResult,
  ConnectNotionResult,
  CreateApiKeyResult,
  CreateOrgResult,
  CreateVaultCredentialResult,
  DeleteDocumentResult,
  DerivedDocument,
  DisconnectNotionResult,
  DocumentDetail,
  FactsBrowseResult,
  FindOrphansResult,
  ForgetFactResult,
  ListApiKeysResult,
  ListAuditResult,
  ListBackfillRunsResult,
  ListDocumentsResult,
  ListDreamRunsResult,
  ListEntitiesResult,
  ListEntityEdgesResult,
  ListNotionConnectionsResult,
  ListOrgsResult,
  ListSessionsResult,
  ListVaultCredentialsResult,
  MembershipsResult,
  MemoryForgetResult,
  MemoryHistoryResult,
  MemoryItem,
  MemoryListResult,
  MemoryRevision,
  MemoryRollbackResult,
  MemorySetResult,
  OkfExportResult,
  OkfFile,
  OkfImportResult,
  PendingReviewsResult,
  RecallResult,
  RemoveMemberResult,
  ReprocessDocumentResult,
  ResolveContradictionResult,
  RevokeApiKeyResult,
  RevokeVaultCredentialResult,
  SearchResult,
  SearchUserByEmailResult,
  SessionContextResult,
  ThinkResult,
  TokenSpend,
  TraversalResult,
  UpdateDocumentResult,
  UpdateMemberResult,
  WikiListEntry,
  WikiPageDetail,
  WikiRevisionFull,
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
  .validator((d: { query: string; path?: string }) => d)
  .handler(async ({ data }): Promise<Result<ThinkResult>> => {
    try {
      const out = await brainCall<ThinkResult>("think", true, {
        query: data.query,
        topK: 12,
        ...(data.path ? { path: data.path } : {}),
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `list_documents` — the full document catalog for this tenant, with optional filters. */
export const getDocuments = createServerFn({ method: "POST" })
  .validator((d: { tag?: string; path?: string; since?: string; until?: string }) => d)
  .handler(async ({ data }): Promise<Result<ListDocumentsResult>> => {
    try {
      const out = await brainCall<ListDocumentsResult>("list_documents", true, {
        limit: 100,
        ...(data.tag ? { tag: data.tag } : {}),
        ...(data.path ? { path: data.path } : {}),
        ...(data.since ? { since: data.since } : {}),
        ...(data.until ? { until: data.until } : {}),
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

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

/** `list_entities` — all entities in the knowledge graph (maps canonicalName → name). */
export const getEntities = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListEntitiesResult>> => {
    try {
      const raw = await brainCall<{
        entities: Array<{
          id: string
          kind: string
          canonicalName: string
          mentionCount: number
        }>
      }>("list_entities", true, {})
      return {
        ok: true,
        data: {
          entities: raw.entities.map((e) => ({
            id: e.id,
            name: e.canonicalName,
            kind: e.kind,
            mentionCount: e.mentionCount,
          })),
        },
      }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `list_entity_edges` — all entity-relation edges in the knowledge graph. */
export const getEntityEdges = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListEntityEdgesResult>> => {
    try {
      const out = await brainCall<ListEntityEdgesResult>("list_entity_edges", true, { limit: 1000 })
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
      const out = await brainCall<TraversalResult>("traverse_graph", true, {
        target: data.seedId,
        graph: "entity",
        depth: 2,
        direction: "both",
      })
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

/** `add_tag` — attach a tag to a doc-graph page (by slug or id). Write op. */
export const addGraphTag = createServerFn({ method: "POST" })
  .validator((d: { target: string; tag: string }) => d)
  .handler(async ({ data }): Promise<Result<{ pageId: string; tag: string }>> => {
    try {
      const out = await brainCall<{ pageId: string; tag: string }>("add_tag", false, {
        target: data.target,
        tag: data.tag,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `add_link` — create a typed link between two doc-graph pages (by slug or id). Write op. */
export const addGraphLink = createServerFn({ method: "POST" })
  .validator((d: { from: string; to: string; linkType?: string }) => d)
  .handler(
    async ({
      data,
    }): Promise<Result<{ fromId: string; toId: string; linkType: string; context: string }>> => {
      try {
        const out = await brainCall<{
          fromId: string
          toId: string
          linkType: string
          context: string
        }>("add_link", false, {
          from: data.from,
          to: data.to,
          ...(data.linkType !== undefined && data.linkType !== ""
            ? { linkType: data.linkType }
            : {}),
        })
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

/** `list_dream_runs` — Dream engine run history (consolidation counts). */
export const getDreamRuns = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListDreamRunsResult>> => {
    try {
      const out = await brainCall<ListDreamRunsResult>("list_dream_runs", true, { limit: 50 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `list_pending_reviews` — Dream contradictions awaiting human review (with hydrated facts). */
export const getPendingReviews = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<PendingReviewsResult>> => {
    try {
      const out = await brainCall<PendingReviewsResult>("list_pending_reviews", true, { limit: 50 })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `resolve_contradiction` — keep one fact (expire the rest) or dismiss a Dream contradiction. */
export const resolveContradiction = createServerFn({ method: "POST" })
  .validator((d: { reviewId: string; action: "keep" | "dismiss"; keepFactId?: number }) => d)
  .handler(async ({ data }): Promise<Result<ResolveContradictionResult>> => {
    try {
      const out = await brainCall<ResolveContradictionResult>("resolve_contradiction", false, {
        reviewId: data.reviewId,
        action: data.action,
        ...(data.keepFactId !== undefined ? { keepFactId: data.keepFactId } : {}),
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

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
  .validator(
    (d: {
      contentType: string
      body: string
      slug?: string
      title?: string
      tags?: string
      path?: string
    }) => d,
  )
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
      if (data.tags) params.set("tags", data.tags)
      if (data.path) params.set("path", data.path)
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

/**
 * `add_thought` — capture a quick thought as a small note under `brain/thoughts/<yyyy-mm>`
 * (tag `thought`). Runs through the same ingest spine as `ingest_document`, so the result
 * shape is identical.
 */
export const addThought = createServerFn({ method: "POST" })
  .validator((d: { thought: string; tags?: string[] }) => d)
  .handler(async ({ data }): Promise<Result<IngestResult>> => {
    try {
      const out = await brainCall<IngestResult>("add_thought", true, {
        thought: data.thought,
        ...(data.tags && data.tags.length > 0 ? { tags: data.tags } : {}),
      })
      return { ok: true, data: out }
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

// --- Document ops ---

/** `get_document` — fetch a single document by id with full body. */
export const getDocument = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<Result<DocumentDetail>> => {
    try {
      const out = await brainCall<DocumentDetail>("get_document", true, {
        documentId: data.documentId,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `reprocess_document` — re-queue a document for ingestion. */
export const reprocessDocument = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<Result<ReprocessDocumentResult>> => {
    try {
      const out = await brainCall<ReprocessDocumentResult>("reprocess_document", false, {
        documentId: data.documentId,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `update_document` — replace a document's content and optionally its content type. */
export const updateDocument = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; content: string; contentType?: string }) => d)
  .handler(async ({ data }): Promise<Result<UpdateDocumentResult>> => {
    try {
      const out = await brainCall<UpdateDocumentResult>("update_document", false, {
        documentId: data.documentId,
        content: data.content,
        ...(data.contentType ? { contentType: data.contentType } : {}),
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `delete_document` — permanently delete a document and its chunks/embeddings. */
export const deleteDocument = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<Result<DeleteDocumentResult>> => {
    try {
      const out = await brainCall<DeleteDocumentResult>("delete_document", false, {
        documentId: data.documentId,
      })
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

// --- Vault credential management ---

/** `list_vault_credentials` (admin) — list WebDAV credentials for Obsidian vault sync. */
export const listVaultCredentials = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListVaultCredentialsResult>> => {
    try {
      const out = await brainCall<ListVaultCredentialsResult>("list_vault_credentials", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `create_vault_credential` (admin) — mint a WebDAV username+password for Obsidian sync. Returns password ONCE. */
export const createVaultCredential = createServerFn({ method: "POST" })
  .validator((d: { label?: string }) => d)
  .handler(async ({ data }): Promise<Result<CreateVaultCredentialResult>> => {
    try {
      const out = await brainCall<CreateVaultCredentialResult>(
        "create_vault_credential",
        false,
        data,
      )
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `revoke_vault_credential` (admin) — revoke a WebDAV credential by username. */
export const revokeVaultCredential = createServerFn({ method: "POST" })
  .validator((d: { username: string }) => d)
  .handler(async ({ data }): Promise<Result<RevokeVaultCredentialResult>> => {
    try {
      const out = await brainCall<RevokeVaultCredentialResult>(
        "revoke_vault_credential",
        false,
        data,
      )
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Notion connection management ---

/** `list_notion_connections` (admin) — list connected Notion workspaces (no token). */
export const listNotionConnections = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ListNotionConnectionsResult>> => {
    try {
      const out = await brainCall<ListNotionConnectionsResult>("list_notion_connections", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `connect_notion` (admin) — start the OAuth flow; returns an authorize URL (or configured:false). */
export const connectNotion = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<ConnectNotionResult>> => {
    try {
      const out = await brainCall<ConnectNotionResult>("connect_notion", false, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `confirm_notion_connection` (admin) — same-principal confirm that persists a pending connection. */
export const confirmNotion = createServerFn({ method: "POST" })
  .validator((d: { confirmToken: string }) => d)
  .handler(async ({ data }): Promise<Result<ConfirmNotionConnectionResult>> => {
    try {
      const out = await brainCall<ConfirmNotionConnectionResult>(
        "confirm_notion_connection",
        false,
        data,
      )
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `disconnect_notion` (admin) — revoke a Notion workspace connection (stops sync). */
export const disconnectNotion = createServerFn({ method: "POST" })
  .validator((d: { workspaceId: string }) => d)
  .handler(async ({ data }): Promise<Result<DisconnectNotionResult>> => {
    try {
      const out = await brainCall<DisconnectNotionResult>("disconnect_notion", false, data)
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Memory ops ---

// Raw shapes returned by the API (frontmatter is Record<string,unknown> which TanStack cannot
// validate for serializability — we extract what the UI needs and drop frontmatter before returning).
interface RawMemoryItem {
  slug: string
  pageId: string
  type: string
  title: string
  visibility: string
  scope: string | null
  frontmatter: Record<string, unknown>
  body: string
  version: number
  createdAt: string
  updatedAt: string
}
interface RawRevision {
  revisionId: number
  version: number
  type: string
  title: string
  visibility: string
  reason: string | null
  authorUserId: string | null
  frontmatter: Record<string, unknown>
  body: string
  createdAt: string
}
const toMemoryItem = (r: RawMemoryItem): MemoryItem => ({
  slug: r.slug,
  pageId: r.pageId,
  type: r.type,
  title: r.title,
  visibility: r.visibility,
  scope: r.scope,
  tags: Array.isArray(r.frontmatter.tags) ? (r.frontmatter.tags as string[]) : [],
  body: r.body,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})
const toRevision = (r: RawRevision): MemoryRevision => ({
  revisionId: r.revisionId,
  version: r.version,
  type: r.type,
  title: r.title,
  visibility: r.visibility,
  reason: r.reason,
  authorUserId: r.authorUserId,
  body: r.body,
  createdAt: r.createdAt,
})

/** `memory_list` — list live agent-memory items, optionally under a path. */
export const memoryList = createServerFn({ method: "POST" })
  .validator((d: { path?: string; prefix?: boolean; limit?: number }) => d)
  .handler(async ({ data }): Promise<Result<MemoryListResult>> => {
    try {
      const out = await brainCall<{ memories: RawMemoryItem[] }>("memory_list", true, {
        ...(data.path ? { path: data.path } : {}),
        ...(data.prefix !== undefined ? { prefix: data.prefix } : {}),
        ...(data.limit !== undefined ? { limit: data.limit } : {}),
      })
      return { ok: true, data: { memories: out.memories.map(toMemoryItem) } }
    } catch (error) {
      return fail(error)
    }
  })

/** `memory_get` — load a single memory item by slug. */
export const memoryGet = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<Result<{ memory: MemoryItem | null }>> => {
    try {
      const out = await brainCall<{ memory: RawMemoryItem | null }>("memory_get", true, {
        slug: data.slug,
      })
      return { ok: true, data: { memory: out.memory ? toMemoryItem(out.memory) : null } }
    } catch (error) {
      return fail(error)
    }
  })

/** `memory_set` — create or update a memory item (appends a version; unchanged = no-op). */
export const memorySet = createServerFn({ method: "POST" })
  .validator(
    (d: {
      slug: string
      type: string
      body: string
      title?: string
      description?: string
      resource?: string
      tags?: string[]
      visibility?: string
      scope?: string
      teamId?: string
    }) => d,
  )
  .handler(async ({ data }): Promise<Result<MemorySetResult>> => {
    try {
      const out = await brainCall<MemorySetResult>("memory_set", false, {
        slug: data.slug,
        type: data.type,
        body: data.body,
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.resource !== undefined ? { resource: data.resource } : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
        ...(data.visibility !== undefined ? { visibility: data.visibility } : {}),
        ...(data.scope !== undefined ? { scope: data.scope } : {}),
        ...(data.teamId !== undefined ? { teamId: data.teamId } : {}),
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `memory_history` — a memory item's full version history, newest-first. */
export const memoryHistory = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<Result<MemoryHistoryResult>> => {
    try {
      const out = await brainCall<{ versions: RawRevision[] }>("memory_history", true, {
        slug: data.slug,
      })
      return { ok: true, data: { versions: out.versions.map(toRevision) } }
    } catch (error) {
      return fail(error)
    }
  })

/** `memory_rollback` — roll a memory item back to an earlier revision (forward-only). */
export const memoryRollback = createServerFn({ method: "POST" })
  .validator((d: { slug: string; toRevisionId: number }) => d)
  .handler(async ({ data }): Promise<Result<MemoryRollbackResult>> => {
    try {
      const out = await brainCall<MemoryRollbackResult>("memory_rollback", false, {
        slug: data.slug,
        toRevisionId: data.toRevisionId,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `memory_forget` — soft-delete a memory item (history retained). */
export const memoryForget = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<Result<MemoryForgetResult>> => {
    try {
      const out = await brainCall<MemoryForgetResult>("memory_forget", false, {
        slug: data.slug,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `okf_export` — export all memory items as an OKF bundle. */
export const okfExport = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<OkfExportResult>> => {
    try {
      const out = await brainCall<OkfExportResult>("okf_export", true, {})
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  },
)

/** `okf_import` — import an OKF bundle (list of {path,content} files) into agent memory. */
export const okfImport = createServerFn({ method: "POST" })
  .validator((d: { files: OkfFile[] }) => d)
  .handler(async ({ data }): Promise<Result<OkfImportResult>> => {
    try {
      const out = await brainCall<OkfImportResult>("okf_import", false, {
        files: data.files,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Facts browser ops ---

/** `recall` (browse) — retrieve hot-memory facts with optional query/entity/since filters. */
export const recallBrowse = createServerFn({ method: "POST" })
  .validator(
    (d: {
      query?: string
      entitySlug?: string
      since?: string
      includeSuperseded?: boolean
      includeSoftExpired?: boolean
      limit?: number
    }) => d,
  )
  .handler(async ({ data }): Promise<Result<FactsBrowseResult>> => {
    try {
      const out = await brainCall<FactsBrowseResult>("recall", true, {
        ...(data.query ? { query: data.query } : {}),
        ...(data.entitySlug ? { entitySlug: data.entitySlug } : {}),
        ...(data.since ? { since: data.since } : {}),
        ...(data.includeSuperseded ? { includeSuperseded: true } : {}),
        ...(data.includeSoftExpired ? { includeSoftExpired: true } : {}),
        limit: data.limit ?? 100,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `forget_fact` — soft-expire a hot-memory fact. */
export const forgetFact = createServerFn({ method: "POST" })
  .validator((d: { factId: number }) => d)
  .handler(async ({ data }): Promise<Result<ForgetFactResult>> => {
    try {
      const out = await brainCall<ForgetFactResult>("forget_fact", false, {
        factId: data.factId,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Session context ---

/** `get_session_context` — turns, hot-memory facts, and loaded memories for a session. */
export const getSessionContext = createServerFn({ method: "POST" })
  .validator((d: { brainSessionId: string }) => d)
  .handler(async ({ data }): Promise<Result<SessionContextResult>> => {
    try {
      const out = await brainCall<SessionContextResult>("get_session_context", true, {
        brainSessionId: data.brainSessionId,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

// --- Wiki (v3/W4a — view mode) ---

/** `wiki_get_page` — full page detail (body, links, backlinks, tags, timeline, revisions, entity). */
export const wikiGetPage = createServerFn({ method: "POST" })
  .validator((d: { target: string }) => d)
  .handler(async ({ data }): Promise<Result<{ page: WikiPageDetail | null }>> => {
    try {
      const out = await brainCall<{ page: WikiPageDetail | null }>("wiki_get_page", true, {
        target: data.target,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `wiki_page_history` — a page's revision snapshots WITH bodies (for the history/diff panel). */
export const wikiPageHistory = createServerFn({ method: "POST" })
  .validator((d: { target: string; limit?: number }) => d)
  .handler(async ({ data }): Promise<Result<{ revisions: WikiRevisionFull[] | null }>> => {
    try {
      const out = await brainCall<{ revisions: WikiRevisionFull[] | null }>(
        "wiki_page_history",
        true,
        { target: data.target, ...(data.limit ? { limit: data.limit } : {}) },
      )
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

/** `wiki_list_pages` — tree-shaped sidebar listing (namespaces + memory + entities). */
export const wikiListPages = createServerFn({ method: "POST" })
  .validator((d: { namespacePrefix?: string; type?: string; tag?: string; limit?: number }) => d)
  .handler(async ({ data }): Promise<Result<{ pages: WikiListEntry[] }>> => {
    try {
      const out = await brainCall<{ pages: WikiListEntry[] }>("wiki_list_pages", true, {
        ...(data.namespacePrefix ? { namespacePrefix: data.namespacePrefix } : {}),
        ...(data.type ? { type: data.type } : {}),
        ...(data.tag ? { tag: data.tag } : {}),
        limit: data.limit ?? 500,
      })
      return { ok: true, data: out }
    } catch (error) {
      return fail(error)
    }
  })

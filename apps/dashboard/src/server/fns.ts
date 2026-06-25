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
  DerivedDocument,
  MembershipsResult,
  SearchResult,
  ThinkResult,
  TokenSpend,
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

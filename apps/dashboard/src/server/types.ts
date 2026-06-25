/**
 * Client-safe render types — local mirrors of the relevant op output shapes
 * (`packages/shared/src/ops.ts` + `packages/db/src/admin/ops.ts`). Kept dependency-free so route
 * components can import them without pulling any server-only module into the browser bundle. The
 * tRPC catalog erases per-procedure IO inference (see `packages/surface/src/trpc.ts`), so these are
 * the contract we render against; the API still validates every payload with the frozen Zod schema.
 */

export interface SearchHit {
  id: string
  documentId: string
  slug: string
  score: number
  snippet: string
}

export interface ThinkResult {
  answer: string
  evidence: SearchHit[]
  citations: { slug: string; chunkId: string }[]
  gaps: string[]
  warnings: string[]
}

export interface SearchResult {
  hits: SearchHit[]
}

/** A document as DERIVED from search hits (v1 exposes no list-documents op). */
export interface DerivedDocument {
  documentId: string
  slug: string
  topScore: number
  snippet: string
  hitCount: number
}

export interface TokenSpend {
  window: string
  neurons: number
  usd: number
  ceilingUsd: number
}

export interface MembershipRow {
  userId: string
  role: string
  teamId: string | null
  allowedScopes: string | null
}

export interface MembershipsResult {
  memberships: MembershipRow[]
}

/** The server-pinned session identity surfaced to the tenant indicator (no secrets). */
export interface BrainSessionInfo {
  tenant: string
  userId: string
}

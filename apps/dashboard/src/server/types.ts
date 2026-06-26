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

// --- Graph types ---

export interface Entity {
  id: string
  name: string
  kind: string
  mentionCount: number
}

export interface ListEntitiesResult {
  entities: Entity[]
}

export interface TraversalNeighbor {
  id: string
  name: string
  kind: string
  relation: string
}

export interface TraversalResult {
  neighbors: TraversalNeighbor[]
}

export interface FindOrphansResult {
  orphans: Entity[]
}

// --- Session types ---

export interface SessionRow {
  id: string
  client: string
  title: string
  status: string
  turnCount: number
  lastActivityAt: string
  startedAt: string
}

export interface ListSessionsResult {
  sessions: SessionRow[]
}

export interface RecallFact {
  id: string
  content: string
  score?: number
}

export interface RecallResult {
  facts: RecallFact[]
}

// --- Audit types ---

export interface AuditEntry {
  id: string
  userId: string
  action: string
  targetId: string
  at: string
}

export interface ListAuditResult {
  entries: AuditEntry[]
}

// --- Document types ---

export interface DocumentRow {
  id: string
  slug: string
  title: string
  status: string
  chunkCount: number
  createdAt: string
}

export interface ListDocumentsResult {
  documents: DocumentRow[]
}

// --- Jobs types ---

export interface BackfillRun {
  id: string
  sourceId: string
  kind: string
  direction: string
  status: string
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface ListBackfillRunsResult {
  runs: BackfillRun[]
}

// --- Org management ---

export interface OrgRow {
  id: string
  slug: string
  name: string
  role: string
}

export interface ListOrgsResult {
  orgs: OrgRow[]
}

export interface CreateOrgResult {
  id: string
  slug: string
}

// --- Membership management ---

export interface SearchUserResult {
  userId: string
  email: string
  firstName?: string
  lastName?: string
  imageUrl?: string
}

export interface SearchUserByEmailResult {
  user: SearchUserResult | null
}

export interface AddMemberResult {
  userId: string
  membershipId: string
}

export interface UpdateMemberResult {
  userId: string
  updated: boolean
}

export interface RemoveMemberResult {
  userId: string
  removed: boolean
}

// --- API key management ---

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

export interface ListApiKeysResult {
  keys: ApiKeyRow[]
}

export interface CreateApiKeyResult {
  token: string
  keyId: string
  keyPrefix: string
  name: string
  scopes: string[]
}

export interface RevokeApiKeyResult {
  keyId: string
  revoked: boolean
}

// --- Aggregate stats ---

export interface BrainStats {
  documents: number
  chunks: number
  entities: number
  sessions: number
  facts: number
  tokenSpendNeurons: number
  monthlyCeilingUsd: number
}

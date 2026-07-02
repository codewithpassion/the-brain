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

export interface EntityEdge {
  fromId: string
  fromName: string
  fromKind: string
  toId: string
  toName: string
  toKind: string
  kind: string
}

export interface ListEntityEdgesResult {
  edges: EntityEdge[]
}

export interface TraversalResult {
  paths: {
    from_id: string
    to_id: string
    link_type: string
    context: string
    depth: number
    confidence?: number
  }[]
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
  userId: string
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
  userId: string
  createdAt: string
  tags: string[]
  path: string | null
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

/** A Dream engine run (from `list_dream_runs`). */
export interface DreamRun {
  id: string
  kind: string
  status: string
  clustersJudged: number
  merged: number
  superseded: number
  contradictions: number
  kept: number
  neurons: number
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface ListDreamRunsResult {
  runs: DreamRun[]
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

// --- Document detail ---

export interface DocumentDetail {
  id: string
  slug: string
  title: string
  status: string
  contentType: string
  body: string
  chunkCount: number
  tags: string[]
  path: string | null
  scope: string | null
  createdAt: string
  updatedAt: string
}

export interface ReprocessDocumentResult {
  documentId: string
  status: string
}

export interface UpdateDocumentResult {
  documentId: string
  status: string
}

export interface DeleteDocumentResult {
  deleted: boolean
}

// --- Vault credential management ---

export interface VaultCredential {
  username: string
  label: string | null
  createdAt: string
  revokedAt: string | null
}

export interface ListVaultCredentialsResult {
  credentials: VaultCredential[]
}

export interface CreateVaultCredentialResult {
  username: string
  password: string
  endpoint: string
}

export interface RevokeVaultCredentialResult {
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

// --- Memory types (MemorySchema / RevisionSchema mirrors from packages/db/src/memory/ops.ts) ---

/** A single agent-memory item returned by memory_get / memory_list. */
export interface MemoryItem {
  slug: string
  pageId: string
  type: string
  title: string
  visibility: string
  scope: string | null
  /** Tags extracted from OKF frontmatter.tags (always an array, empty when absent). */
  tags: string[]
  body: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface MemoryListResult {
  memories: MemoryItem[]
}

export interface MemorySetResult {
  slug: string
  pageId: string
  version: number
  changed: boolean
}

export interface MemoryForgetResult {
  slug: string
  forgotten: boolean
}

export interface MemoryRollbackResult {
  slug: string
  pageId: string
  version: number
  revertedFrom: number
}

/** A single revision returned by memory_history. */
export interface MemoryRevision {
  revisionId: number
  version: number
  type: string
  title: string
  visibility: string
  reason: string | null
  authorUserId: string | null
  body: string
  createdAt: string
}

export interface MemoryHistoryResult {
  versions: MemoryRevision[]
}

// --- OKF types ---

export interface OkfFile {
  path: string
  content: string
}

export interface OkfExportResult {
  okfVersion: string
  count: number
  files: OkfFile[]
}

export interface OkfImportItem {
  path: string
  status: "imported" | "skipped" | "failed"
  reason?: string
  slug?: string
}

export interface OkfImportResult {
  imported: number
  skipped: number
  failed: number
  okfVersion: string | null
  items: OkfImportItem[]
}

// --- Facts browser types (from RECALL_OP / FORGET_FACT_OP in sessions/ops.ts) ---

/** A hot-memory fact as returned by recall / get_session_context. id is a DB number. */
export interface FactItem {
  id: number
  fact: string
  kind: string
  /** Dream lineage: the fact that superseded this one (present on recall output). */
  supersededBy?: number | null
  /** Dream lineage: the consolidated fact this one was merged into. */
  consolidatedInto?: number | null
}

export interface FactsBrowseResult {
  facts: FactItem[]
}

export interface ForgetFactResult {
  factId: number
  forgotten: boolean
}

// --- Session context (GET_SESSION_CONTEXT_OP output) ---

export interface SessionContextTurn {
  idx: number
  role: string
  content: string | null
}

export interface SessionContextMemory {
  slug: string
  type: string
  title: string
  body: string
  version: number
}

export interface SessionContextResult {
  turns: SessionContextTurn[]
  facts: FactItem[]
  snapshotStubbed: boolean
  memories?: SessionContextMemory[]
}

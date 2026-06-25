/**
 * The single ingestion params shape (PRD §4). Every ingress — upload,
 * pre-chunked, webhook, backfill-Queue consumer — converges on one Workflow
 * with this one shape, re-scoped to The Brain's tenancy model.
 */
export interface IngestionParams {
  // ── tenancy (threads through every row, every vector namespace, every R2 key) ──
  /** Hard boundary; Vectorize namespace; D1 predicate. */
  tenantId: string
  /** Metadata filter. */
  teamId?: string
  /** Project/client sub-partition. */
  scope?: string
  /** Authorship. */
  userId: string

  // ── identity / provenance ──
  /** Pre-allocated nanoid; basis of the deterministic Workflow instance id. */
  documentId: string
  filename: string
  path?: string
  /** Must pass ALLOWED_CONTENT_TYPES. */
  contentType: string
  /** Body lives here, NOT in D1. */
  r2Key: string
  /** 'upload' | 'webhook' | 'gmail' | 'ob1' | 'github' | 'chatgpt' | 'claude-code'. */
  sourceKind?: string
  sourceId?: string
  sourceUri?: string
  /** 'rest' | 'mcp' | 'backfill-queue'. */
  ingestedVia: string

  // ── dedup / re-embed ──
  /** `sha256(normalizeForFingerprint(markdown))`. */
  fingerprint: string
  /** '@cf/baai/bge-m3' for fresh; 'pending' for imported foreign-embedding rows. */
  embeddingModel: string

  // ── chunking ──
  /** Default chosen by contentType (§4.4). */
  strategy?: "paragraph" | "sliding"
  /** Sliding window size (default 512). */
  maxTokens?: number
  /** Sliding overlap (default 64). */
  overlap?: number

  // ── pre-chunked fast path (§4.6) ──
  preChunked?: Array<{
    content: string
    headingPath?: string
    metadata?: Record<string, unknown>
  }>
  tags?: string[]
  metadata?: Record<string, unknown>
}

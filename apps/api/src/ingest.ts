/**
 * `runBatchIngest` — the platform-neutral document ingestion pipeline (PRD §4, the
 * "first vertical slice" Phase 2c). It is a PLAIN async function over the tenant-scoped
 * `ScopedServices` bundle — deliberately NOT bound to the Cloudflare Workflows runtime
 * (which has no local emulation), so the e2e slice test drives it directly against real
 * workerd D1 + R2. The deploy-time `BatchIngestWorkflow` (workflow.ts) wraps it across
 * durable `step.do()` boundaries.
 *
 * Steps (each composes a FROZEN chokepoint — no raw binding is ever touched here):
 *   1. status → `processing`.
 *   2. extract → markdown: passthrough+normalize for `text/markdown|text/plain`
 *      (`toMarkdown`); a clearly-marked TODO hook for binary/HTML via `ai.toMarkdown`
 *      (the CF document converter) is deferred — the slice accepts text only.
 *   3. chunk (`chunkDocument`) + part plan (`planParts`, §4.3 split-on-chunk-boundary).
 *   4. insert chunks (`ScopedDB.insertChunks`, batched@10, FTS via DB triggers).
 *   5. embed in batches of `EMBED_BATCH_SIZE` (50) via the WRITE-path `ai.embedForIndex`
 *      (THROWS on failure → the real Workflow step retries; we never index un-embedded
 *      chunks, invariant 14) → `ScopedVectorize.upsert` (namespace=tenant baked in) →
 *      mark the chunk embedded.
 *   6. KG extraction — a marked NO-OP/TODO (Phase 4; the slice does not need the graph).
 *   7. finalize → `indexed` (+ markdown_preview, chunk_count; invariant 13: D1 holds the
 *      preview only, the body stays in R2).
 *
 * CAP-SAFE HAND-OFFS: the pipeline takes R2 *references* (`r2Key` + `documentId`), never an
 * inline body, and reads/writes bodies through `ScopedR2` itself. So when the future
 * Workflow wrapper splits this across `step.do()` boundaries, no step output (the small
 * `BatchIngestResult` summary, or an R2 key) approaches the 1 MiB step-output cap — the body
 * never crosses a step boundary.
 *
 * IDEMPOTENCY/DEDUP: the durable dedup rests on the `(tenant_id, scope, fingerprint)` UNIQUE
 * index on `documents` (invariant 15), enforced at INSERT time by the `/ingest` route (which
 * catches the conflict → "already ingested"). This function runs only after a fresh
 * `documents` row exists, and uses deterministic chunk ids so a retry replaces, never
 * duplicates.
 */
import type { ScopedServices } from "@brain/db"
import {
  chunkDocument,
  markdownPreview,
  planParts,
  toMarkdown,
  UnsupportedContentTypeError,
} from "@brain/ingest"
import type { Principal } from "@brain/shared"
import { EMBED_BATCH_SIZE, EMBEDDING_MODEL } from "@brain/shared"

/** Per-document ingestion inputs — R2 *references* only (cap-safe), never an inline body. */
export interface BatchIngestParams {
  /** The pre-inserted `documents` row id this run finalizes. */
  documentId: string
  /** Tenant-RELATIVE R2 key of the raw body (`ScopedR2` adds the `${tenantId}/` prefix). */
  r2Key: string
  /** Content type of the raw body; decides extraction + chunking strategy. */
  contentType: string
  /** Mirrored onto every chunk (the `allowedScopes` data-partition gate). */
  scope?: string | null
  /** Mirrored when `visibility === 'team'`. */
  teamId?: string | null
  /** Intra-tenant access tier for the produced chunks (default `world`). */
  visibility?: string
}

/** The serializable payload the deploy-time `BatchIngestWorkflow` carries (workflow.ts). */
export interface BatchIngestWorkflowParams {
  /** The resolved tenant principal (plain serializable object) the run is scoped to. */
  principal: Principal
  /** The per-document ingestion references. */
  ingest: BatchIngestParams
}

export interface BatchIngestResult {
  documentId: string
  chunkCount: number
  status: "indexed" | "failed"
}

/** Deterministic chunk id (`${documentId}:${chunkIndex}`) → retries replace, never duplicate. */
const chunkId = (documentId: string, chunkIndex: number): string => `${documentId}:${chunkIndex}`

export const runBatchIngest = async (
  services: ScopedServices,
  params: BatchIngestParams,
): Promise<BatchIngestResult> => {
  const { documentId } = params

  // 1. status → processing.
  await services.db.updateDocumentStatus(documentId, { status: "processing" })

  // 2. extract → markdown. Body is read from R2 (a staged reference), never passed inline.
  const obj = await services.blobs.get(params.r2Key)
  if (obj === null) {
    await services.db.updateDocumentStatus(documentId, { status: "failed" })
    throw new Error(`ingest: body not found in R2 at "${params.r2Key}"`)
  }
  const raw = await obj.text()

  let markdown: string
  try {
    markdown = toMarkdown(raw, params.contentType)
  } catch (err) {
    if (err instanceof UnsupportedContentTypeError) {
      // TODO(P-later): binary/HTML extraction via the CF document converter (`env.AI.toMarkdown`),
      // surfaced as a new `ScopedServices.ai` chokepoint. The slice accepts text only; a binary
      // body lands here and is marked failed rather than silently dropped.
      await services.db.updateDocumentStatus(documentId, { status: "failed" })
    }
    throw err
  }

  // Empty extraction → failed branch (§4.11): never index a zero-chunk document.
  if (markdown.trim().length === 0) {
    await services.db.updateDocumentStatus(documentId, { status: "failed" })
    return { documentId, chunkCount: 0, status: "failed" }
  }

  // 3. chunk + part plan. `planParts` proves the §4.3 ceilings; slice docs are a single part.
  const docChunks = chunkDocument(markdown, { contentType: params.contentType })
  const parts = planParts(docChunks)
  if (parts.length > 1) {
    // TODO(P-later): materialize each ChunkPart as its own `documents` row sharing
    // `parent_document_id`/`part_index` (§4.3), staging each part body in R2. The slice's
    // small docs never split; we process the single part below.
  }

  // 4. insert chunks (tenant_id forced, FTS5 shadow kept in step by DB triggers).
  const chunkRows = docChunks.map((chunk) => ({
    id: chunkId(documentId, chunk.chunkIndex),
    documentId,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    headingPath: chunk.headingPath,
    tokenCount: chunk.tokenCount,
    scope: params.scope ?? null,
    teamId: params.teamId ?? null,
    visibility: params.visibility ?? "world",
  }))
  await services.db.insertChunks(chunkRows)

  // 5. embed (write-path, throws → Workflow retry) → vectorize upsert → mark embedded.
  const embeddedAt = new Date().toISOString()
  for (let i = 0; i < chunkRows.length; i += EMBED_BATCH_SIZE) {
    const batch = chunkRows.slice(i, i + EMBED_BATCH_SIZE)
    const vectors = await services.ai.embedForIndex(batch.map((row) => row.content))
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j]
      const values = vectors[j]
      if (row === undefined || values === undefined) continue
      // Vector first: if the upsert throws the chunk stays un-embedded (embedded_at NULL),
      // so a retry re-embeds it — we never leave an indexed-but-unvectored chunk.
      await services.vectors.upsert({
        id: row.id,
        values,
        scope: row.scope,
        teamId: row.teamId,
        visibility: row.visibility,
        embeddingModel: EMBEDDING_MODEL,
      })
      await services.db.updateChunkEmbedding(row.id, {
        embeddingModel: EMBEDDING_MODEL,
        embeddedAt,
      })
    }
  }

  // 6. KG extraction — NO-OP (Phase 4: EntityExtractionWorkflow + entity dual-index).
  // TODO(P4): extract entities/relations + entity_mentions and upsert the brain-entities index.

  // 7. finalize → indexed (D1 keeps the preview only — invariant 13).
  await services.db.updateDocumentStatus(documentId, {
    status: "indexed",
    markdownPreview: markdownPreview(markdown),
    chunkCount: chunkRows.length,
    ingestedAt: embeddedAt,
  })

  return { documentId, chunkCount: chunkRows.length, status: "indexed" }
}

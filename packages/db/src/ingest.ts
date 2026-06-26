/**
 * `runBatchIngestCore` — the platform-neutral document ingestion pipeline, MINUS entity
 * extraction (Phase 4 KG). Entity extraction is handled separately in apps/api so this core
 * can run in both the Worker (via runBatchIngest, which adds entity extraction) and the surface
 * catalog's inline fallback (which skips entity extraction). All steps use the frozen
 * `ScopedServices` chokepoints; no raw binding is ever touched here.
 *
 * Steps:
 *   1. status → processing
 *   2. read body from R2 → extract markdown
 *   3. chunk + part plan (oversized docs: single-part slice only for now)
 *   4. insert chunks (tenant_id forced, FTS5 shadow via DB triggers)
 *   5. embed → vectorize upsert → mark embedded
 *   6. finalize → indexed (D1 preview only; body stays in R2)
 */
import {
  chunkDocument,
  markdownPreview,
  planParts,
  toMarkdown,
  UnsupportedContentTypeError,
} from "@brain/ingest"
import { EMBED_BATCH_SIZE, EMBEDDING_MODEL } from "@brain/shared"
import type { ScopedServices } from "./services"

/** Per-document ingestion references — R2 keys only (cap-safe), never an inline body. */
export interface BatchIngestParams {
  documentId: string
  r2Key: string
  contentType: string
  scope?: string | null
  teamId?: string | null
  visibility?: string
  /** Path namespace mirrored onto every produced chunk (e.g. "/project/x"). */
  path?: string | null
}

export interface BatchIngestResult {
  documentId: string
  chunkCount: number
  status: "indexed" | "failed"
}

const chunkId = (documentId: string, chunkIndex: number): string => `${documentId}:${chunkIndex}`

/**
 * Core ingest pipeline (steps 1–6 above, no entity extraction). Returns `{ status: "indexed" }`
 * on success or `{ status: "failed" }` when the body is empty/unsupported.
 */
export const runBatchIngestCore = async (
  services: ScopedServices,
  params: BatchIngestParams,
): Promise<BatchIngestResult> => {
  const { documentId } = params

  // 1. status → processing.
  await services.db.updateDocumentStatus(documentId, { status: "processing" })

  // 2. extract → markdown.
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
      await services.db.updateDocumentStatus(documentId, { status: "failed" })
    }
    throw err
  }

  if (markdown.trim().length === 0) {
    await services.db.updateDocumentStatus(documentId, { status: "failed" })
    return { documentId, chunkCount: 0, status: "failed" }
  }

  // 3. chunk + part plan.
  const docChunks = chunkDocument(markdown, { contentType: params.contentType })
  const parts = planParts(docChunks)
  if (parts.length > 1) {
    // TODO(P-later): materialize each ChunkPart as its own `documents` row.
  }

  // 4. insert chunks (path mirrored from the parent document's path).
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
    path: params.path ?? null,
  }))
  await services.db.insertChunks(chunkRows)

  // 5. embed → vectorize upsert → mark embedded.
  const embeddedAt = new Date().toISOString()
  for (let i = 0; i < chunkRows.length; i += EMBED_BATCH_SIZE) {
    const batch = chunkRows.slice(i, i + EMBED_BATCH_SIZE)
    const vectors = await services.ai.embedForIndex(batch.map((row) => row.content))
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j]
      const values = vectors[j]
      if (row === undefined || values === undefined) continue
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

  // 6. finalize → indexed.
  await services.db.updateDocumentStatus(documentId, {
    status: "indexed",
    markdownPreview: markdownPreview(markdown),
    chunkCount: chunkRows.length,
    ingestedAt: embeddedAt,
  })

  return { documentId, chunkCount: chunkRows.length, status: "indexed" }
}

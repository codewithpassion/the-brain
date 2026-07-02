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
 *   3. chunk + part plan (oversized docs: each part materialized as its own `documents` row)
 *   4. insert chunks (tenant_id forced, FTS5 shadow via DB triggers)
 *   5. embed → vectorize upsert → mark embedded
 *   6. finalize → indexed (D1 preview only; body stays in R2)
 */
import {
  type ChunkPart,
  chunkDocument,
  markdownPreview,
  type PlanPartsOptions,
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
  /**
   * Override the per-part ceilings (§4.3). Defaults to MAX_CHUNKS_PER_DOC / MAX_BODY_BYTES;
   * a caller (or canary) may shrink them to force an oversized-doc split.
   */
  partLimits?: PlanPartsOptions
}

export interface BatchIngestResult {
  documentId: string
  chunkCount: number
  status: "indexed" | "failed"
  /**
   * Child part `documents` ids materialized for an oversized split (§4.3), empty otherwise. The
   * caller runs KG entity extraction over these too, so a split doc's overflow chunks aren't
   * skipped (extraction is keyed per documentId).
   */
  partDocumentIds: string[]
}

const chunkId = (documentId: string, chunkIndex: number): string => `${documentId}:${chunkIndex}`

/** Parse a `documents.tags` JSON column into a string[] (empty on null/malformed). */
const parseTags = (raw: string | null | undefined): string[] => {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}

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
    return { documentId, chunkCount: 0, status: "failed", partDocumentIds: [] }
  }

  // 3. chunk + part plan (§4.3). An oversized doc splits into parts that each honor
  // MAX_CHUNKS_PER_DOC / MAX_BODY_BYTES; each part becomes its OWN `documents` row instead of
  // cramming everything into one. A single-part doc keeps the original document unchanged.
  const docChunks = chunkDocument(markdown, { contentType: params.contentType })
  const parts = planParts(docChunks, params.partLimits)
  const owners = await resolvePartOwners(services, params, documentId, parts)

  // 4. insert chunks per part — each part's chunks are re-indexed 0..m-1 under its own document
  // (path mirrored from the parent document's path). Accumulated flat for the shared embed loop.
  const chunkRows: {
    id: string
    documentId: string
    chunkIndex: number
    content: string
    headingPath: string | null
    tokenCount: number
    scope: string | null
    teamId: string | null
    visibility: string
    path: string | null
  }[] = []
  for (const { documentId: partDocId, part } of owners) {
    const rows = docChunks.slice(part.chunkStart, part.chunkEnd).map((chunk, index) => ({
      id: chunkId(partDocId, index),
      documentId: partDocId,
      chunkIndex: index,
      content: chunk.content,
      headingPath: chunk.headingPath,
      tokenCount: chunk.tokenCount,
      scope: params.scope ?? null,
      teamId: params.teamId ?? null,
      visibility: params.visibility ?? "world",
      path: params.path ?? null,
    }))
    await services.db.insertChunks(rows)
    chunkRows.push(...rows)
  }

  // 5. embed → vectorize upsert → mark embedded (across every part's chunks).
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

  // 6. finalize each part → indexed, with its own preview + chunkCount. The root ALWAYS records
  // its part identity (0/N when split, cleared to null/null when not) so a supersede that goes
  // split→unsplit doesn't leave stale part_index/part_count; children got theirs at insert.
  const split = owners.length > 1
  for (const { documentId: partDocId, part } of owners) {
    const isRoot = partDocId === documentId
    const partText = docChunks
      .slice(part.chunkStart, part.chunkEnd)
      .map((chunk) => chunk.content)
      .join("\n\n")
    await services.db.updateDocumentStatus(partDocId, {
      status: "indexed",
      markdownPreview: isRoot ? markdownPreview(markdown) : markdownPreview(partText),
      chunkCount: part.chunkCount,
      ingestedAt: embeddedAt,
      ...(isRoot ? { partIndex: split ? 0 : null, partCount: split ? owners.length : null } : {}),
    })
  }

  const partDocumentIds = owners.map((o) => o.documentId).filter((id) => id !== documentId)
  return { documentId, chunkCount: chunkRows.length, status: "indexed", partDocumentIds }
}

/**
 * Resolve each planned `ChunkPart` to the `documents` row that owns its chunks (§4.3). Part 0
 * reuses the original `documentId`; each additional part is materialized as a child row
 * (`parent_document_id` + `part_index` + `part_count`) inheriting the parent's scope/team/path.
 * A single-part doc returns just the original — no child rows, behaviour unchanged.
 */
const resolvePartOwners = async (
  services: ScopedServices,
  params: BatchIngestParams,
  documentId: string,
  parts: ChunkPart[],
): Promise<{ documentId: string; part: ChunkPart }[]> => {
  if (parts.length <= 1) {
    const only = parts[0]
    return only ? [{ documentId, part: only }] : []
  }
  const parent = await services.db.getDocumentById(documentId)
  const baseSlug = parent?.slug ?? documentId
  const baseFingerprint = parent?.fingerprint ?? documentId
  // Children inherit the parent's tags so the search tag-filter (which matches on documents.tags)
  // includes a child part's chunks; path is likewise inherited (see below).
  const baseTags = parseTags(parent?.tags)
  const owners: { documentId: string; part: ChunkPart }[] = []
  for (const part of parts) {
    if (part.partIndex === 0) {
      owners.push({ documentId, part })
      continue
    }
    const childId = await services.db.insertDocument({
      slug: `${baseSlug}-p${part.partIndex}`,
      fingerprint: `${baseFingerprint}-p${part.partIndex}`,
      title: parent?.title ?? null,
      contentType: params.contentType,
      scope: params.scope ?? null,
      teamId: params.teamId ?? null,
      path: params.path ?? null,
      tags: baseTags,
      // Inherit provenance from the parent: `origin` keeps a split dream-insight's parts behind the
      // D2 anti-loop filter; `sourceId` so a child-part citation reports the parent's source, not null.
      origin: parent?.origin ?? null,
      sourceId: parent?.sourceId ?? null,
      status: "processing",
      parentDocumentId: documentId,
      partIndex: part.partIndex,
      partCount: parts.length,
    })
    owners.push({ documentId: childId, part })
  }
  return owners
}

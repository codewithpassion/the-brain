/**
 * Stage 2 of the backfill spine — the `brain-backfill` Queue consumer (PRD §8.6, invariants 15, 18).
 *
 * `runBackfillMessage` is the per-message core (testable with NO live queue):
 *   1. Reconstructs the `Principal` from the message's explicit `tenant_id`, FAIL-CLOSED.
 *   2. Drives the item idempotently (invariant 15):
 *
 *   `doc` items (Phase 2 — supersede-by-slug): delegates to `runDocIngestCore` which handles the
 *   three-way branch (fresh insert / no-op resume / supersede) and then calls `runBatchIngest`.
 *   Shared with the Phase-4 `brain-vault-events` consumer so the supersede logic cannot diverge.
 *
 *   `session` items: reads staged `ImportedSession` from R2 + persists via `captureSession`.
 *
 * `handleBackfillQueue` is the deploy-time consumer: per-message `ack`/`retry`.
 */
import { type BackfillServices, createBackfillServices, principalFromMessage } from "@brain/db"
import type { ImportedSession } from "@brain/ingest"
import { runBatchIngest } from "../ingest"
import type { BackfillBindings } from "./bindings"
import { captureSession } from "./capture"
import type { BackfillMessage } from "./messages"

/** Per-message retry backoff before a re-delivery (s08 consumer config `retry_delay:30`). */
export const BACKFILL_RETRY_DELAY = 30

/** A fail-closed rejection (invariant 18): the message must route to the DLQ, not be ack'd. */
export class BackfillRejectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackfillRejectError"
  }
}

/** Phase-1 slug: content-addressed, used when `stableSlug` is absent (non-obsidian or Phase-1). */
const legacyDocSlug = (fingerprint: string): string => `bf-${fingerprint}`

/**
 * Parameters for the supersede-by-slug doc ingest core — shared by the `brain-backfill` consumer
 * (via `runBackfillMessage`) and the `brain-vault-events` consumer (direct call).
 */
export interface DocIngestParams {
  slug: string
  fingerprint: string
  /** Tenant-relative R2 key where the doc body lives (read by `runBatchIngest`). */
  payloadRef: string
  contentType: string
  sourceId?: string
  /** When true, stamps `sourceKind:"obsidian"` on a fresh insert (Phase-2 stable-slug docs). */
  isPhase2?: boolean
  path?: string
  tags?: string[]
  /** Discriminates which consumer created the doc (default `"backfill-queue"`). */
  ingestedVia?: string
}

/**
 * The supersede-by-slug doc ingest core — shared between consumers.
 *
 * Three-way branch (idempotent, invariant 15):
 *   • No existing row → INSERT + ingest (fresh note).
 *   • Existing row, same fingerprint, live → no-op (unchanged note) or resume (non-terminal).
 *   • Existing row, different fingerprint OR soft-deleted → SUPERSEDE: hard-delete old chunks
 *     (freeing PK space so re-ingest can write fresh chunks with the same `docId:idx` ids),
 *     delete old Vectorize vectors, update doc row (new fingerprint, clear deleted_at, status=pending),
 *     then re-ingest. The same doc UUID is reused so Vectorize ids stay ≤41 chars (cap-safe).
 *
 * Note on hard-delete-for-supersede: chunk ids are deterministic (`${docId}:${chunkIndex}`).
 * Soft-deleted rows still hold the PK, so `insertChunks` (`onConflictDoNothing`) would silently
 * skip new content. Hard-delete is the minimal correct solution.
 */
export const runDocIngestCore = async (
  services: BackfillServices,
  params: DocIngestParams,
): Promise<void> => {
  const {
    slug,
    fingerprint,
    payloadRef,
    contentType,
    sourceId,
    isPhase2,
    path,
    tags,
    ingestedVia,
  } = params

  // Look up the existing row by slug FIRST (avoids a spurious INSERT in the common no-op / supersede
  // cases; also avoids hitting the fingerprint unique index for Phase-2 stable slugs).
  const existing = await services.db.getDocumentBySlug(slug)
  let docId: string

  if (existing !== null) {
    const isDeleted = existing.deletedAt !== null
    const sameFingerprint = existing.fingerprint === fingerprint

    if (!isDeleted && sameFingerprint) {
      // Unchanged note, live doc: no-op (terminal status) or resume (non-terminal).
      if (existing.status === "indexed" || existing.status === "failed") return
      docId = existing.id
    } else {
      // Changed content (different fingerprint) OR previously deleted (resurrection): supersede.
      const { chunkIds: oldChunkIds } = await services.db.hardDeleteDocumentChunks(existing.id)
      if (oldChunkIds.length > 0) {
        // Orphan vectors in Vectorize are tolerable (D1 re-check drops them), but explicit
        // deletion keeps the index tidy.
        await services.vectors.deleteVectors(oldChunkIds)
      }
      // Reuse the same UUID so chunkIds stay cap-safe; clear deleted_at for resurrection.
      await services.db.updateDocumentForSupersede(existing.id, {
        fingerprint,
        bodyR2Key: payloadRef,
        deletedAt: null,
      })
      docId = existing.id
    }
  } else {
    // No existing row: insert fresh. May throw on UNIQUE conflict (race or Phase-1 fingerprint
    // collision — see note in doc-string above). Resolve by DB state; never fail-open.
    try {
      docId = await services.db.insertDocument({
        slug,
        fingerprint,
        contentType,
        bodyR2Key: payloadRef,
        status: "pending",
        ...(sourceId !== undefined ? { sourceId } : {}),
        // Phase 2 obsidian docs get sourceKind="obsidian" so the cron reconcile can find them.
        ...(isPhase2 ? { sourceKind: "obsidian" } : {}),
        ingestedVia: ingestedVia ?? "backfill-queue",
        ...(path !== undefined ? { path } : {}),
        ...(tags !== undefined ? { tags } : {}),
      })
    } catch (err) {
      const retry = await services.db.getDocumentBySlug(slug)
      if (retry === null) throw err
      if (retry.status === "indexed" || retry.status === "failed") return
      docId = retry.id
    }
  }

  await runBatchIngest(services, { documentId: docId, r2Key: payloadRef, contentType })
}

/**
 * Process ONE backfill message. Resolves on success OR an idempotent dedup skip; THROWS on a
 * fail-closed reject (bad tenant) or a transient error — both route to the DLQ via retry-exhaustion.
 */
export const runBackfillMessage = async (
  env: BackfillBindings,
  message: BackfillMessage,
): Promise<void> => {
  const principal = await principalFromMessage(env, message)
  if (principal === null) {
    throw new BackfillRejectError(`backfill: unresolved tenant '${message.tenantId}' (fail-closed)`)
  }
  const services = createBackfillServices(env, principal)

  if (message.kind === "session") {
    const obj = await services.blobs.get(message.payloadRef)
    if (obj === null) {
      throw new Error(`backfill: staged session not found at "${message.payloadRef}"`)
    }
    const session = JSON.parse(await obj.text()) as ImportedSession
    await captureSession(services, session)
    return
  }

  // kind === "doc" — delegate to the shared supersede-by-slug core (Phase 2+).
  // UUID document ids are cap-safe: 36 chars → chunkId ≤ 41 chars, under CF's 64-byte cap.
  const contentType = message.contentType ?? "text/markdown"
  const slug =
    message.stableSlug !== undefined ? message.stableSlug : legacyDocSlug(message.fingerprint)
  const isPhase2 = message.stableSlug !== undefined

  await runDocIngestCore(services, {
    slug,
    fingerprint: message.fingerprint,
    payloadRef: message.payloadRef,
    contentType,
    sourceId: message.sourceId,
    isPhase2,
    ...(message.path !== undefined ? { path: message.path } : {}),
    ...(message.tags !== undefined ? { tags: message.tags } : {}),
    // ingestedVia defaults to "backfill-queue" in runDocIngestCore
  })
}

/**
 * The deploy-time `brain-backfill` consumer. Per-message `ack`/`retry` (s08: one poison item must
 * not fail the batch); an exhausted message routes to `brain-backfill-dlq`.
 */
export const handleBackfillQueue = async (
  batch: MessageBatch<BackfillMessage>,
  env: BackfillBindings,
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await runBackfillMessage(env, message.body)
      message.ack()
    } catch {
      message.retry({ delaySeconds: BACKFILL_RETRY_DELAY })
    }
  }
}

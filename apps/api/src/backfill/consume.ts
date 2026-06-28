/**
 * Stage 2 of the backfill spine — the `brain-backfill` Queue consumer (PRD §8.6, invariants 15, 18).
 *
 * `runBackfillMessage` is the per-message core (testable with NO live queue):
 *   1. Reconstructs the `Principal` from the message's explicit `tenant_id`, FAIL-CLOSED.
 *   2. Drives the item idempotently (invariant 15):
 *
 *   `doc` items (Phase 2 — supersede-by-slug):
 *   - If `message.stableSlug` is present (Obsidian Phase-2 doc), the slug is the stable vault path
 *     (e.g. "Projects/Acme/notes"), NOT the Phase-1 `bf-${fingerprint}`. Idempotency rests on
 *     `(tenant_id, slug)` + fingerprint comparison:
 *       • No existing row → INSERT + ingest (fresh note).
 *       • Existing row, same fingerprint, live → no-op (unchanged note) or resume (non-terminal).
 *       • Existing row, different fingerprint OR soft-deleted → SUPERSEDE: hard-delete old chunks
 *         (freeing PK space so re-ingest can write new chunks with the same `docId:idx` ids — see
 *         note below), delete old Vectorize vectors, update doc row (new fingerprint, clear deleted_at,
 *         status=pending), then re-ingest. The same doc UUID is reused so Vectorize ids stay ≤41 chars.
 *       Note on hard-delete-for-supersede: the task specifies "soft-delete the old version's chunks"
 *       but chunk ids are deterministic (`${docId}:${chunkIndex}`). Soft-deleted rows still hold
 *       the PK, so `insertChunks` (which uses `onConflictDoNothing`) would silently skip writing new
 *       content. Hard-delete is the minimal correct solution; it is noted in the Phase-2 report.
 *   - If `message.stableSlug` is absent (Phase-1 or non-obsidian doc), the Phase-1 `bf-${fingerprint}`
 *     slug path is used unchanged (no regression).
 *
 *   `session` items: reads staged `ImportedSession` from R2 + persists via `captureSession`.
 *
 * `handleBackfillQueue` is the deploy-time consumer: per-message `ack`/`retry`.
 */
import { createBackfillServices, principalFromMessage } from "@brain/db"
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

  // kind === "doc": UUID document id (cap-safe: 36 chars → chunkId ≤ 41 chars, under CF's 64-byte cap).
  const contentType = message.contentType ?? "text/markdown"

  // Phase 2: if a stableSlug is present, use it as the document slug (stable across edits).
  // Otherwise fall back to the Phase-1 `bf-${fingerprint}` derivation (no regression).
  const slug =
    message.stableSlug !== undefined ? message.stableSlug : legacyDocSlug(message.fingerprint)
  const isPhase2 = message.stableSlug !== undefined

  // Look up the existing row by slug FIRST (avoids a spurious INSERT attempt in the common
  // supersede / no-op cases; also avoids INSERT on the fingerprint unique index for Phase-2).
  const existing = await services.db.getDocumentBySlug(slug)

  let docId: string

  if (existing !== null) {
    const isDeleted = existing.deletedAt !== null
    const sameFingerprint = existing.fingerprint === message.fingerprint

    if (!isDeleted && sameFingerprint) {
      // Unchanged note, live doc: no-op or resume.
      if (existing.status === "indexed" || existing.status === "failed") return // terminal
      // Non-terminal (pending/processing): prior delivery crashed after insert → resume.
      docId = existing.id
    } else {
      // Changed content (different fingerprint) OR previously deleted (resurrection): supersede.
      // Hard-delete old chunks first so re-ingest can write fresh chunks with the same PK ids.
      const { chunkIds: oldChunkIds } = await services.db.hardDeleteDocumentChunks(existing.id)
      if (oldChunkIds.length > 0) {
        // Delete old Vectorize vectors off-batch; orphan vectors in Vectorize are tolerable
        // (D1 re-check drops them), but explicit deletion keeps the index tidy.
        await services.vectors.deleteVectors(oldChunkIds)
      }
      // Update the doc row: new fingerprint, new body key, status=pending (re-triggers ingest),
      // clear deleted_at (resurrection). The same UUID is reused so chunkIds stay cap-safe.
      await services.db.updateDocumentForSupersede(existing.id, {
        fingerprint: message.fingerprint,
        bodyR2Key: message.payloadRef,
        deletedAt: null,
      })
      docId = existing.id
    }
  } else {
    // No existing row: insert fresh. May throw on UNIQUE conflict (race or Phase-1 fingerprint
    // collision — see note in doc-string above).
    try {
      docId = await services.db.insertDocument({
        // No explicit id — insertDocument generates a UUID; slug uniqueness handles re-delivery.
        slug,
        fingerprint: message.fingerprint,
        contentType,
        bodyR2Key: message.payloadRef,
        status: "pending",
        sourceId: message.sourceId,
        // Phase 2 obsidian docs get sourceKind="obsidian" so the reconcile can find them.
        ...(isPhase2 ? { sourceKind: "obsidian" } : {}),
        ingestedVia: "backfill-queue",
        ...(message.path !== undefined ? { path: message.path } : {}),
        ...(message.tags !== undefined ? { tags: message.tags } : {}),
      })
    } catch (err) {
      // Resolve by DB STATE (invariant: never fail-open on UNIQUE conflicts).
      // If getDocumentBySlug still returns null here, this is either a genuine transient error
      // OR a Phase-1/Phase-2 fingerprint index collision (documented in Phase-2 report).
      // In both cases rethrow → retry → DLQ.
      const retry = await services.db.getDocumentBySlug(slug)
      if (retry === null) throw err
      if (retry.status === "indexed" || retry.status === "failed") return
      docId = retry.id
    }
  }

  await runBatchIngest(services, { documentId: docId, r2Key: message.payloadRef, contentType })
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

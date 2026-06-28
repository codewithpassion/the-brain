/**
 * Stage 2 of the backfill spine — the `brain-backfill` Queue consumer (PRD §8.6, invariants 15, 18).
 *
 * `runBackfillMessage` is the per-message core (testable with NO live queue): it
 *   1. reconstructs the `Principal` from the message's explicit `tenant_id`, FAIL-CLOSED — an
 *      unknown org (or, with a `userId`, a non-member) throws `BackfillRejectError`, so the message
 *      is retried to exhaustion and lands in the DLQ (invariant 18 — never a shared HTTP secret);
 *   2. drives the item idempotently (invariant 15): a `doc` item inserts a `documents` row with a
 *      UUID id (cap-safe: 36 chars → chunkId ≤ 41 chars, under CF's 64-byte Vectorize cap) and a
 *      content-addressed slug (`bf-${fingerprint}`) as the UNIQUE dedup key; a re-delivery hits the
 *      `(tenant_id, slug)` UNIQUE conflict → the catch narrows to that conflict, looks up the
 *      existing doc's status, and re-drives `runBatchIngest` for non-terminal docs (pending /
 *      processing → resume) or skips for terminal docs (indexed / failed → no-op). Transient errors
 *      (timeout, contention) are NOT caught — they rethrow so the queue retries and eventually DLQ;
 *      a `session` item reads the staged `ImportedSession` from R2 and persists it through
 *      `captureSession` (itself marker-gated). At-least-once delivery is therefore idempotent on the
 *      second pass — no double-ingest, no doubled turns.
 *
 * `handleBackfillQueue` is the deploy-time consumer: per-message `ack()`/`retry()` so one poison item
 * never fails the whole batch (and exhausted retries route to `brain-backfill-dlq`).
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

/** Slug-based dedup key stored in D1 (TEXT column — length is fine, not a Vectorize id). */
const docSlug = (fingerprint: string): string => `bf-${fingerprint}`

/**
 * Process ONE backfill message. Resolves on success OR an idempotent dedup skip; THROWS on a
 * fail-closed reject (bad tenant) or a transient error — both of which the consumer routes to the
 * DLQ via retry-exhaustion.
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

  // kind === "doc": UUID document id (cap-safe) + slug-based dedup + runBatchIngest.
  // The UUID (36 chars) produces chunkIds of ≤ 41 chars — safely under CF's 64-byte Vectorize cap.
  // Idempotency rests on the `(tenant_id, slug)` UNIQUE index, NOT the document id (invariant 15).
  const slug = docSlug(message.fingerprint)
  const contentType = message.contentType ?? "text/markdown"
  let docId: string | undefined
  try {
    docId = await services.db.insertDocument({
      // No explicit id — insertDocument generates a UUID; slug uniqueness handles re-delivery.
      slug,
      fingerprint: message.fingerprint,
      contentType,
      bodyR2Key: message.payloadRef,
      status: "pending",
      sourceId: message.sourceId,
      ingestedVia: "backfill-queue",
      // path + tags come from Obsidian (and future) importers via BackfillMessage.
      ...(message.path !== undefined ? { path: message.path } : {}),
      ...(message.tags !== undefined ? { tags: message.tags } : {}),
    })
  } catch (err) {
    // Resolve by DB STATE, not by error-string matching (fragile if the UNIQUE error is wrapped
    // in err.cause). insertDocument's batch is atomic, so a throw means THIS delivery wrote no row.
    // Point-lookup by slug on the (tenant_id, slug) unique index — O(1), avoids a full documents
    // scan (O(N·D) on steady-state where every unchanged note hits this path each enumerator run).
    const existing = await services.db.getDocumentBySlug(slug)
    // No row ⇒ the throw was a genuine transient/unknown failure → rethrow so the queue retries → DLQ.
    if (existing === null) throw err
    // A row exists ⇒ a PRIOR delivery created it (a real dedup conflict).
    if (existing.status === "indexed" || existing.status === "failed") return // terminal → no-op
    // Non-terminal (pending / processing): the prior delivery crashed after insert but before
    // runBatchIngest completed → re-drive ingest with the EXISTING id, not a fresh UUID.
    docId = existing.id
  }
  if (docId === undefined) return // unreachable; all non-throw/non-return paths above assign docId
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

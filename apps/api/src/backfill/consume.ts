/**
 * Stage 2 of the backfill spine — the `brain-backfill` Queue consumer (PRD §8.6, invariants 15, 18).
 *
 * `runBackfillMessage` is the per-message core (testable with NO live queue): it
 *   1. reconstructs the `Principal` from the message's explicit `tenant_id`, FAIL-CLOSED — an
 *      unknown org (or, with a `userId`, a non-member) throws `BackfillRejectError`, so the message
 *      is retried to exhaustion and lands in the DLQ (invariant 18 — never a shared HTTP secret);
 *   2. drives the item idempotently (invariant 15): a `doc` item inserts a `documents` row with a
 *      DETERMINISTIC id + content-addressed slug (re-delivery → PK/`(tenant,slug)` conflict → caught
 *      → no-op) then runs `runBatchIngest`; a `session` item reads the staged `ImportedSession` from
 *      R2 and persists it through `captureSession` (itself marker-gated). At-least-once delivery is
 *      therefore a no-op on the second pass — no double-ingest, no doubled turns.
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

/** Deterministic ingest ids (invariant 15): a re-delivery hits the PK / `(tenant, slug)` conflict. */
const docId = (tenantId: string, fingerprint: string): string => `ingest-${tenantId}-${fingerprint}`
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

  // kind === "doc": deterministic-id documents row + runBatchIngest (mirrors /ingest, index.ts).
  const id = docId(message.tenantId, message.fingerprint)
  const contentType = message.contentType ?? "text/markdown"
  try {
    await services.db.insertDocument({
      id,
      slug: docSlug(message.fingerprint),
      fingerprint: message.fingerprint,
      contentType,
      bodyR2Key: message.payloadRef,
      status: "pending",
      sourceId: message.sourceId,
      ingestedVia: "backfill-queue",
    })
  } catch {
    return // already ingested (the deterministic-id conflict) — idempotent no-op.
  }
  await runBatchIngest(services, { documentId: id, r2Key: message.payloadRef, contentType })
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

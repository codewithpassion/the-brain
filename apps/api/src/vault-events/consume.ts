/**
 * `brain-vault-events` Queue consumer — R2 event notifications → near-real-time vault ingest
 * (Phase 4, docs/obsidian-brain-integration-plan.md §4).
 *
 * `runVaultEventMessage` is the per-message core (testable with NO live queue):
 *   1. Parses the R2 event body (action + object key).
 *   2. Derives tenantId (first key segment) and vault-relative key; skips anything outside
 *      `vault/`, any non-markdown file, and the `Brain/` prefix (loop-avoidance — same exclusion
 *      the cron importer applies).
 *   3. Reconstructs the Principal fail-closed (invariant 18) via `principalFromMessage`.
 *   4. For create/update actions: reads the object body from R2 (via ScopedR2), derives slug/path/
 *      tags using the SAME `pathParts`/`extractTags` helpers as the obsidian importer so cron and
 *      events always resolve to the same document by slug, then drives `runDocIngestCore` (the
 *      shared supersede-by-slug path — no divergent copy of the supersede logic).
 *   5. For delete actions: resolves the doc by stableSlug → soft-delete + vector GC + KG clear.
 *
 * R2 event notification message shape (Cloudflare docs, verified 2026-06-28):
 *   { account, action, bucket, object: { key, size?, eTag? }, eventTime, copySource? }
 *   action: "PutObject" | "CopyObject" | "CompleteMultipartUpload" | "DeleteObject" | ...
 *   object.key: the FULL bucket key = "${tenantId}/vault/<path>.md"
 *   object.eTag: content MD5 (absent on DeleteObject)
 *   object.size: absent on DeleteObject
 *
 * Idempotency: duplicate create events for an unchanged note → same fingerprint
 * ("obsidian:<vaultPath>:<eTag>") → `runDocIngestCore` no-ops (Phase 2 fingerprint gate).
 * The ETag used here matches the `obj.etag` from R2 list (both are content MD5 for single-part
 * PUTs, which markdown notes always are) so cron and events compute the same fingerprint.
 *
 * `handleVaultEventQueue` is the deploy-time consumer: per-message `ack`/`retry`.
 */
import { type BackfillServices, createBackfillServices, principalFromMessage } from "@brain/db"
import { extractTags, pathParts } from "@brain/ingest"
import { BACKFILL_RETRY_DELAY, runDocIngestCore } from "../backfill"
import type { BackfillBindings } from "../backfill/bindings"

// ── R2 event notification shape ───────────────────────────────────────────────────────────────────

/**
 * R2 event notification message body delivered to the queue consumer.
 * Field names verified against https://developers.cloudflare.com/r2/buckets/event-notifications/
 */
export interface R2EventMessage {
  account: string
  /** "PutObject" | "CopyObject" | "CompleteMultipartUpload" | "DeleteObject" | ... */
  action: string
  bucket: string
  object: {
    /** Full bucket key: "${tenantId}/vault/<path>.md" */
    key: string
    /** Object size in bytes; absent on DeleteObject. */
    size?: number
    /** Content ETag (MD5 for single-part PUTs); absent on DeleteObject. */
    eTag?: string
  }
  eventTime: string
  copySource?: { bucket: string; object: string }
}

// ── Constants ─────────────────────────────────────────────────────────────────────────────────────

const VAULT_PREFIX = "vault/"

/**
 * Actions that mean an object was written (create or update). Multipart completion is included
 * because it is how large uploads are finalised; markdown notes never trigger it in practice
 * (Remotely Save uses single-part PUTs), but handling it here keeps the consumer future-proof.
 */
const CREATE_ACTIONS = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload"])

/** Actions that mean an object was removed (explicit delete + lifecycle/TTL expiry). */
const DELETE_ACTIONS = new Set(["DeleteObject", "LifecycleDeletion"])

// ── Error types ───────────────────────────────────────────────────────────────────────────────────

/**
 * A fail-closed rejection (invariant 18): the message must route to the DLQ, not be ack'd.
 * Mirrors `BackfillRejectError` from the backfill consumer.
 */
export class VaultEventRejectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VaultEventRejectError"
  }
}

// ── Pure helpers (exported for unit tests) ────────────────────────────────────────────────────────

/**
 * Split an absolute R2 bucket key into the tenant prefix and tenant-relative vault key.
 * "org_abc/vault/notes.md" → { tenantId: "org_abc", vaultRelKey: "vault/notes.md" }
 * Returns `null` for malformed keys (no slash, empty segments).
 */
export const parseR2Key = (key: string): { tenantId: string; vaultRelKey: string } | null => {
  const slashIdx = key.indexOf("/")
  if (slashIdx <= 0) return null
  const tenantId = key.slice(0, slashIdx)
  const vaultRelKey = key.slice(slashIdx + 1)
  if (vaultRelKey.length === 0) return null
  return { tenantId, vaultRelKey }
}

/**
 * Returns true if the vault-relative key should be processed (is a vault markdown note that is
 * not Brain-authored). Mirrors the obsidian importer's filter in `packages/ingest/src/sources/obsidian.ts`.
 */
export const isVaultNote = (vaultRelKey: string): boolean => {
  if (!vaultRelKey.startsWith(VAULT_PREFIX)) return false
  const vaultPath = vaultRelKey.slice(VAULT_PREFIX.length)
  if (vaultPath.startsWith("Brain/")) return false // loop-avoidance: skip brain-authored notes
  return /\.(md|markdown)$/i.test(vaultPath)
}

// ── Create/update path ────────────────────────────────────────────────────────────────────────────

const runVaultCreate = async (
  services: BackfillServices,
  params: {
    vaultRelKey: string
    vaultPath: string
    eTag: string
    sourceId: string | undefined
  },
): Promise<void> => {
  const { vaultRelKey, vaultPath, eTag, sourceId } = params

  // Read the note body from R2. If it has disappeared since the event was produced (e.g. deleted
  // before this delivery), skip — the delete event will (or already has) cleaned up.
  const obj = await services.blobs.get(vaultRelKey)
  if (obj === null) return
  const content = await obj.text()
  if (content.trim().length === 0) return // empty note — skip

  const tags = extractTags(content)
  const { slug, path } = pathParts(vaultPath)

  // Fingerprint format matches the obsidian importer ("obsidian:<vaultPath>:<etag>") so that cron
  // and events compute identical fingerprints for the same note and can no-op each other's work.
  const fingerprint = `obsidian:${vaultPath}:${eTag}`

  // The vault R2 key IS the payloadRef — ScopedR2 reads the body directly from it during ingest,
  // with no extra staging step (the content is already there).
  await runDocIngestCore(services, {
    slug,
    fingerprint,
    payloadRef: vaultRelKey,
    contentType: "text/markdown",
    ...(sourceId !== undefined ? { sourceId } : {}),
    isPhase2: true,
    path,
    tags,
    ingestedVia: "vault-event",
  })
}

// ── Delete path ───────────────────────────────────────────────────────────────────────────────────

const runVaultDelete = async (services: BackfillServices, vaultPath: string): Promise<void> => {
  const { slug } = pathParts(vaultPath)
  const existing = await services.db.getDocumentBySlug(slug)
  if (existing === null || existing.deletedAt !== null) return // already gone — no-op

  const { chunkIds, partDocumentIds } = await services.db.softDeleteDocument(existing.id)
  if (chunkIds.length > 0) {
    await services.vectors.deleteVectors(chunkIds)
  }
  // Clear KG extraction so the deleted note's entities (incl. split-doc child parts) are no longer queryable.
  await services.graph.clearExtractionForFamily([existing.id, ...partDocumentIds])
}

// ── Per-message core ──────────────────────────────────────────────────────────────────────────────

/**
 * Process ONE R2 vault-event message. Resolves on success (or an idempotent no-op skip); THROWS
 * on a fail-closed reject (unknown tenant) or a transient error — both route to the DLQ via
 * retry-exhaustion.
 *
 * At-least-once safety: a duplicate create event for an unchanged note → same fingerprint →
 * `runDocIngestCore` returns early (no-op). A duplicate delete → doc already soft-deleted → no-op.
 */
export const runVaultEventMessage = async (
  env: BackfillBindings,
  event: R2EventMessage,
): Promise<void> => {
  // ── Parse key and skip non-vault objects ─────────────────────────────────────────────────────
  const parsed = parseR2Key(event.object.key)
  if (parsed === null) return // malformed key — skip silently

  const { tenantId, vaultRelKey } = parsed
  if (!isVaultNote(vaultRelKey)) return // not a vault markdown note — skip

  const vaultPath = vaultRelKey.slice(VAULT_PREFIX.length)

  // ── Fail-closed tenant validation (invariant 18) ─────────────────────────────────────────────
  // tenantId is UNTRUSTED (derived from the object key); principalFromMessage validates it
  // against a real `orgs` row and returns null for unknown tenants (fail-closed).
  const principal = await principalFromMessage(env, { tenantId })
  if (principal === null) {
    throw new VaultEventRejectError(`vault-event: unresolved tenant '${tenantId}' (fail-closed)`)
  }
  const services = createBackfillServices(env, principal)

  // Locate the obsidian source for this tenant so event-ingested docs share the same sourceId as
  // cron-ingested docs. This lets `reconcileObsidianDeletions` find and reconcile them together.
  // If no obsidian source is configured yet, proceed with sourceId=undefined (docs will have
  // sourceKind="obsidian" but no sourceId — cron reconcile won't catch their deletion, but the
  // delete-event path handles that in real-time).
  const activeSources = await services.sources.listActive()
  const obsidianSource = activeSources.find((s) => s.kind === "obsidian")
  const sourceId = obsidianSource?.id

  // ── Route by action ──────────────────────────────────────────────────────────────────────────
  if (DELETE_ACTIONS.has(event.action)) {
    return runVaultDelete(services, vaultPath)
  }

  if (CREATE_ACTIONS.has(event.action)) {
    const eTag = event.object.eTag
    if (eTag === undefined) {
      // A create/update event without an eTag is malformed — skip rather than ingest with
      // an unpredictable fingerprint that would break future idempotency.
      return
    }
    return runVaultCreate(services, { vaultRelKey, vaultPath, eTag, sourceId })
  }

  // Unknown action (e.g. LifecycleDeletion, future types) — skip silently.
}

// ── Deploy-time consumer ──────────────────────────────────────────────────────────────────────────

/**
 * The deploy-time `brain-vault-events` consumer. Per-message `ack`/`retry`; an exhausted message
 * routes to `brain-vault-events-dlq`. Mirrors `handleBackfillQueue`'s error discipline.
 */
export const handleVaultEventQueue = async (
  batch: MessageBatch<R2EventMessage>,
  env: BackfillBindings,
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await runVaultEventMessage(env, message.body)
      message.ack()
    } catch {
      message.retry({ delaySeconds: BACKFILL_RETRY_DELAY })
    }
  }
}

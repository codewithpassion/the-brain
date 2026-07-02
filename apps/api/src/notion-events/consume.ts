/**
 * `brain-notion-events` Queue consumer (docs/notion-integration-plan.md §5, Phase 3) — near-real-time
 * Notion ingest, cloned from `vault-events/consume.ts`. The webhook route verifies the signature and
 * maps `workspace_id → tenant` BEFORE enqueuing; this consumer re-validates the tenant fail-closed
 * (invariant 18), fetches the changed page via the (tenant-scoped, decrypted) bot token, converts it,
 * stages the markdown to R2, and drives the SHARED `runDocIngestCore` (supersede-by-slug,
 * `sourceKind:"notion"`, `ingestedVia:"notion-event"`) — or soft-deletes on archive/delete.
 *
 * All Notion HTTP goes through the injectable `clientFactory` seam (a stub in tests).
 */
import {
  type BackfillServices,
  createBackfillServices,
  getNotionAccessTokenFromEnv,
  notionSourceId,
  principalFromMessage,
} from "@brain/db"
import { type NotionClient, notionPageToDoc, notionSlug } from "@brain/ingest"
import { BACKFILL_RETRY_DELAY, runDocIngestCore } from "../backfill"
import type { BackfillBindings } from "../backfill/bindings"
import { createNotionApiClient } from "../notion/client"

/** A `brain-notion-events` message — one changed/removed Notion page, routed by workspace→tenant. */
export interface NotionEventMessage {
  tenantId: string
  workspaceId: string
  pageId: string
  action: "upsert" | "delete"
}

/** Fail-closed rejection (invariant 18): route to the DLQ, not ack. Mirrors `VaultEventRejectError`. */
export class NotionEventRejectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotionEventRejectError"
  }
}

export interface NotionEventDeps {
  /** DI seam: build a `NotionClient` from a bot token (stubbed in tests). */
  clientFactory?: (token: string) => NotionClient
}

/**
 * Soft-delete the doc for a Notion page (+ vector GC + KG clear) — mirrors `runVaultDelete`.
 * Idempotent (already-deleted/missing → no-op). Shared by the webhook consumer AND the poll sweep's
 * archived-page reconcile.
 */
export const softDeleteNotionPage = async (
  services: BackfillServices,
  pageId: string,
): Promise<void> => {
  const slug = notionSlug(pageId)
  const existing = await services.db.getDocumentBySlug(slug)
  if (existing === null || existing.deletedAt !== null) return
  const { chunkIds } = await services.db.softDeleteDocument(existing.id)
  if (chunkIds.length > 0) await services.vectors.deleteVectors(chunkIds)
  await services.graph.clearPriorExtraction(
    { sourceKind: "document", sourceId: existing.id },
    { gcOrphanedEntities: true },
  )
}

/** Fetch + convert + stage + ingest one page — mirrors `runVaultCreate`. */
const runNotionUpsert = async (
  services: BackfillServices,
  client: NotionClient,
  workspaceId: string,
  pageId: string,
): Promise<void> => {
  const page = await client.getPageContent(pageId)
  if (page.archived === true) return softDeleteNotionPage(services, pageId)

  // SAME mapping as the poll importer (byte-identical slug/fingerprint/path/tags/markdown).
  const doc = notionPageToDoc(page)
  if (doc.content.trim().length === 0) return // empty page — skip

  // Stage the converted markdown, then ingest from that R2 key (same shape as the vault path).
  const payloadRef = `notion/${pageId}.md`
  await services.blobs.put(payloadRef, doc.content)

  await runDocIngestCore(services, {
    slug: doc.slug,
    fingerprint: doc.fingerprint,
    payloadRef,
    contentType: doc.contentType,
    sourceId: notionSourceId(workspaceId),
    isPhase2: true,
    sourceKind: "notion",
    path: doc.path,
    tags: doc.tags,
    ingestedVia: "notion-event",
  })
}

/**
 * Process ONE `brain-notion-events` message. Resolves on success / idempotent no-op; THROWS on a
 * fail-closed reject (unknown tenant) or a transient error — both route to the DLQ.
 */
export const runNotionEventMessage = async (
  env: BackfillBindings,
  message: NotionEventMessage,
  deps: NotionEventDeps = {},
): Promise<void> => {
  const principal = await principalFromMessage(env, { tenantId: message.tenantId })
  if (principal === null) {
    throw new NotionEventRejectError(
      `notion-event: unresolved tenant '${message.tenantId}' (fail-closed)`,
    )
  }
  const services = createBackfillServices(env, principal)

  if (message.action === "delete") {
    return softDeleteNotionPage(services, message.pageId)
  }

  const token = await getNotionAccessTokenFromEnv(env, principal, message.workspaceId)
  if (token === null) return // connection revoked / key unset — nothing to sync.
  const clientFactory = deps.clientFactory ?? ((t: string) => createNotionApiClient({ token: t }))
  await runNotionUpsert(services, clientFactory(token), message.workspaceId, message.pageId)
}

/** The deploy-time `brain-notion-events` consumer. Per-message `ack`/`retry` → `-dlq`. */
export const handleNotionEventQueue = async (
  batch: MessageBatch<NotionEventMessage>,
  env: BackfillBindings,
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await runNotionEventMessage(env, message.body)
      message.ack()
    } catch {
      message.retry({ delaySeconds: BACKFILL_RETRY_DELAY })
    }
  }
}

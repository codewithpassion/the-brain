/**
 * Notion cron poll sweep (docs/notion-integration-plan.md §5, Phase 2) — the NET-NEW scheduled()
 * wiring the plan calls for (obsidian is event-driven, so there was no source-poll sweep to reuse).
 * It rides the EXISTING ingest spine: per tenant, for each active `kind:"notion"` source, build a
 * `NotionImporter` over the (decrypted, tenant-scoped) bot token and drive the FROZEN `runEnumerate`
 * — staging each page's markdown to R2 and enqueuing a `doc` reference onto `brain-backfill`, where
 * the existing consumer ingests it via `runDocIngestCore` (supersede-by-slug, sourceKind:"notion").
 *
 * Anchoring: `sources.last_sync_at` is the delta watermark (the importer's `since`); it advances to
 * the poll-START time on a clean pass (so same-minute edits are re-scanned next tick and the
 * `notion:<pageId>:<last_edited_time>` fingerprint gate no-ops the overlap). `backfill_runs.cursor`
 * handles mid-enumeration resume. All Notion HTTP goes through the injectable `clientFactory` seam.
 */
import {
  createBackfillServices,
  getNotionAccessTokenFromEnv,
  listTenantIds,
  principalFromMessage,
} from "@brain/db"
import { createNotionImporter, type NotionClient } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import { type BackfillMessage, runEnumerate } from "../backfill"
import type { BackfillBindings } from "../backfill/bindings"
import { softDeleteNotionPage } from "../notion-events/consume"
import { createNotionApiClient } from "./client"

export interface NotionPollSweepOptions {
  /** Reference-only dispatch (real `env.BACKFILL_QUEUE.send` at deploy; an array push in tests). */
  enqueue: (message: BackfillMessage) => Promise<void>
  /** DI seam: build a `NotionClient` from a bot token (stubbed in tests; HTTP client at deploy). */
  clientFactory?: (token: string) => NotionClient
  /** Restrict the sweep to these tenants (tests); defaults to all tenants. */
  tenantIds?: string[]
  now?: Date
}

export interface NotionPollSweepResult {
  tenants: number
  sources: number
  enqueued: number
}

/** Parse a source's JSON config for its Notion workspace id (null when malformed/absent). */
const workspaceIdOf = (source: { config: string }): string | null => {
  try {
    const cfg = JSON.parse(source.config) as { workspaceId?: string }
    return typeof cfg.workspaceId === "string" ? cfg.workspaceId : null
  } catch {
    return null
  }
}

/**
 * Poll every tenant's active Notion sources for changed pages and enqueue them for ingest. Fail
 * closed on an unknown tenant; degrade gracefully (no-op) when the token store is unconfigured.
 */
export const runNotionPollSweep = async (
  env: BackfillBindings,
  options: NotionPollSweepOptions,
): Promise<NotionPollSweepResult> => {
  const clientFactory =
    options.clientFactory ?? ((token: string) => createNotionApiClient({ token }))
  const now = options.now ?? new Date()
  const tenantIds = options.tenantIds ?? (await listTenantIds(env))

  let sourcesPolled = 0
  let enqueued = 0

  for (const tenantId of tenantIds) {
    const principal: Principal | null = await principalFromMessage(env, { tenantId })
    if (principal === null) continue // unknown org (race with delete) — fail-closed, skip.
    const services = createBackfillServices(env, principal)

    // Backoff-gated active sources of kind "notion".
    const candidates = (await services.sources.listReenqueuable(now)).filter(
      (s) => s.kind === "notion",
    )
    for (const source of candidates) {
      const workspaceId = workspaceIdOf(source)
      if (workspaceId === null) continue

      // EVERYTHING per-source is inside this try — a decrypt/enumerate failure for ONE source (or
      // tenant) records a backoff for that source and moves on; it must never abort the sweep.
      try {
        const token = await getNotionAccessTokenFromEnv(env, principal, workspaceId)
        if (token === null) {
          // No usable token (key unset or connection revoked) — degrade gracefully, one log line.
          console.log(`notion-poll: skipping source ${source.id} (no active token)`)
          continue
        }

        await services.sources.recordAttempt(source.id, now)
        const pollStart = now.toISOString()
        const importer = createNotionImporter(clientFactory(token), {
          ...(source.lastSyncAt !== null ? { since: source.lastSyncAt } : {}),
          // Close the delete gap opportunistically: if the delta surfaces an archived page,
          // soft-delete its doc (no extra API calls). Webhooks remain the reliable delete channel.
          onArchived: (pageId) => softDeleteNotionPage(services, pageId),
        })

        // Stable per-source run row (mid-enumeration resume); the fingerprint gate makes re-ingest
        // idempotent, so we don't need per-tick uniqueness.
        const runId = `notion-${source.id}`
        const existingRun = await services.runs.get(runId)
        if (existingRun === null) {
          await services.runs.createRun({ id: runId, sourceId: source.id, kind: "doc" })
        }

        const enqueueCounting = async (message: BackfillMessage): Promise<void> => {
          enqueued++
          await options.enqueue(message)
        }
        await runEnumerate({
          runs: services.runs,
          blobs: services.blobs,
          enqueue: enqueueCounting,
          tenantId,
          sourceId: source.id,
          runId,
          kind: "doc",
          importer,
          ...(existingRun?.cursor != null ? { resumeCursor: existingRun.cursor } : {}),
        })
        // Clean pass: advance the delta watermark to the poll-START time (see module doc).
        await services.sources.recordSuccess(source.id, { lastSyncAt: pollStart }, now)
        sourcesPolled++
      } catch (err) {
        // A failed pass (bad ciphertext, Notion error, …) bumps backoff and leaves last_sync_at
        // untouched (re-scan next tick). The NEXT source/tenant still syncs.
        console.log(
          `notion-poll: source ${source.id} failed: ${err instanceof Error ? err.message : "error"}`,
        )
        await services.sources.recordFailure(source.id, now)
      }
    }
  }

  return { tenants: tenantIds.length, sources: sourcesPolled, enqueued }
}

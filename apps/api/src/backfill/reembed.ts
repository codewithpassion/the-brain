/**
 * The re-embed migration — `brain-reembed` Queue (cron-fed) + consumer (PRD §8.7, invariant 12).
 *
 * A cron sweep (`runReembedSweep`) finds every stale/wrong-model/foreign-dimension chunk per tenant
 * (visibility-AGNOSTIC — `ReembedStore` selects them all so private/team chunks aren't left to rot),
 * opens a migration `backfill_runs` row, records the estimated cost up front (the budgeted job),
 * and enqueues one reference per chunk. The consumer (`runReembedMessage`) re-embeds at bge-m3 1024d
 * and upserts the SAME Vectorize id in place (invariant 12: a foreign-dimension vector is RE-EMBEDDED,
 * never copied) — then stamps `embedded_at`/`embedding_model` and records the spend tagged
 * `surface='migration'`, so the migration can't exhaust a tenant's interactive `think` budget.
 *
 * Idempotent under at-least-once delivery: `getCandidate` returns `null` once a chunk is no longer
 * stale, so a re-delivered message is a no-op.
 */
import {
  createBackfillServices,
  listTenantIds,
  principalFromMessage,
  type ReembedCandidate,
} from "@brain/db"
import { EMBEDDING_MODEL } from "@brain/shared"
import { monthlyWindow } from "../ports"
import type { BackfillBindings } from "./bindings"
import type { ReembedMessage } from "./messages"

/** Per-message retry backoff (mirrors the backfill consumer). */
export const REEMBED_RETRY_DELAY = 30

/** Rough neuron cost of re-embedding one chunk (bge-m3): ~1 token per 4 chars, ~1 neuron / token. */
export const estimateReembedNeurons = (content: string): number => Math.ceil(content.length / 4)

export interface ReembedSweepOptions {
  /** Candidates per tenant per sweep (the drain-rate bound). */
  limit?: number
  /** Restrict the sweep to specific tenants (defaults to every org). */
  tenantIds?: string[]
  /** Reference-only dispatch (real `env.REEMBED_QUEUE.send` at deploy; an array push in tests). */
  enqueue: (message: ReembedMessage) => Promise<void>
  now?: Date
}

/** What one sweep enqueued. */
export interface ReembedSweepResult {
  tenants: number
  enqueued: number
  /** Estimated neurons booked across the opened migration runs. */
  estimatedNeurons: number
}

/**
 * Cross-tenant cron sweep. Per tenant: validate → find stale candidates → open a migration run,
 * book the estimated cost, and enqueue one reference per candidate. Returns the roll-up.
 */
export const runReembedSweep = async (
  env: BackfillBindings,
  options: ReembedSweepOptions,
): Promise<ReembedSweepResult> => {
  const tenantIds = options.tenantIds ?? (await listTenantIds(env))
  const window = monthlyWindow(options.now)
  let enqueued = 0
  let estimatedNeurons = 0
  for (const tenantId of tenantIds) {
    const principal = await principalFromMessage(env, { tenantId })
    if (principal === null) continue // unknown org (race with delete) — fail-closed, skip.
    const services = createBackfillServices(env, principal)
    const candidates = await services.reembed.findCandidates(options.limit ?? 50)
    if (candidates.length === 0) continue

    const runId = `reembed-${tenantId}-${window}`
    const existing = await services.runs.get(runId)
    if (existing === null) {
      await services.runs.createRun({ id: runId, sourceId: "reembed", kind: "reembed" })
    }
    const cost = candidates.reduce((sum, c) => sum + estimateReembedNeurons(c.content), 0)
    await services.runs.addStats(runId, { neurons: cost })
    estimatedNeurons += cost

    for (const candidate of candidates) {
      await options.enqueue({ tenantId, chunkId: candidate.id, runId })
      enqueued++
    }
  }
  return { tenants: tenantIds.length, enqueued, estimatedNeurons }
}

/** Re-embed ONE chunk to its SAME vector id (invariant 12). Resolves on success OR an idempotent skip. */
export const runReembedMessage = async (
  env: BackfillBindings,
  message: ReembedMessage,
): Promise<void> => {
  const principal = await principalFromMessage(env, message)
  if (principal === null) {
    throw new Error(`reembed: unresolved tenant '${message.tenantId}' (fail-closed)`)
  }
  const services = createBackfillServices(env, principal)
  const candidate: ReembedCandidate | null = await services.reembed.getCandidate(message.chunkId)
  if (candidate === null) return // already re-embedded (no longer stale) — idempotent no-op.

  const vectors = await services.ai.embedForIndex([candidate.content])
  const values = vectors[0]
  if (values === undefined) throw new Error("reembed: embedForIndex returned no vector")

  // SAME vector id (== chunk id) — re-upsert in place, re-stamping the model from 'pending'/foreign.
  await services.vectors.upsert({
    id: candidate.id,
    values,
    scope: candidate.scope,
    teamId: candidate.teamId,
    visibility: candidate.visibility,
    embeddingModel: EMBEDDING_MODEL,
  })
  // Re-stamp model + DIMS + embedded_at (markReembedded fixes embedding_dims too, so a foreign-dim
  // chunk stops being a candidate — the idempotency guarantee the frozen updateChunkEmbedding lacks).
  await services.reembed.markReembedded(candidate.id, new Date().toISOString())

  // Cost tagged `migration` (can't exhaust the interactive budget) + folded into the run ledger.
  const neurons = estimateReembedNeurons(candidate.content)
  await services.db.recordSpend({
    window: monthlyWindow(),
    model: EMBEDDING_MODEL,
    surface: "migration",
    neurons,
  })
  await services.runs.addStats(message.runId, { processed: 1, neurons })
}

/** The deploy-time `brain-reembed` consumer. Per-message `ack`/`retry` → `brain-reembed-dlq`. */
export const handleReembedQueue = async (
  batch: MessageBatch<ReembedMessage>,
  env: BackfillBindings,
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await runReembedMessage(env, message.body)
      message.ack()
    } catch {
      message.retry({ delaySeconds: REEMBED_RETRY_DELAY })
    }
  }
}

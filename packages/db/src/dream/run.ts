/**
 * `runDreamConsolidation` (v2 W1/D1) — the orchestrator that ties select → judge → apply together
 * under a resumable, budgeted, idempotent-per-day run row (D-i3).
 *
 * BUDGET SLICE (D-i3): before judging each cluster the run checks its OWN spend against a threshold
 * = min(10% of the remaining monthly neuron ceiling, `opts.maxNeurons`); when it trips, the run
 * stops CLEANLY leaving `cursor` at the last-processed cluster key so the next run resumes there.
 * Every judge call records `surface='dream'` spend into `token_spend`.
 *
 * RUN FSM: `success` is TERMINAL and always has `cursor=null` (nothing left). A budget stop sets
 * `status='paused'` with the resume `cursor` (which may itself be null when the stop happened before
 * the first cluster — the status, not the cursor, marks it resumable). The run id is
 * `dream-${tenantId}-${yyyymmdd}` (see `dreamRunId`). A same-day re-run keys the no-op off
 * `status==='success'` ONLY; a `paused`/`failure`/`queued` row is (re-)claimed and resumed, while a
 * `running` (another worker) or `cancelled` row no-ops without claiming. The claim itself is decided
 * by the conditional UPDATE's changed-row count, so two racing workers cannot both proceed.
 *
 * SCOPING (D-i4): every read/write goes through the tenant-forced select/apply/runs helpers built
 * from the Principal — one tenant's dream never touches another's memory.
 */

import type { Principal } from "@brain/shared"
import { EXTRACT_MODEL } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import type { BrainDrizzle, ScopedDB } from "../scoped/db"
import { MONTHLY_NEURON_CEILING, monthlyWindow } from "../search/ports"
import { createScopedServices, type ScopedServices } from "../services"
import { applyCluster } from "./apply"
import { judgeCluster } from "./judge"
import {
  CLAIMABLE_FROM,
  type DreamRunStats,
  type DreamRunStatus,
  DreamRunStore,
  ZERO_DREAM_STATS,
} from "./runs"
import { selectClusters } from "./select"

/** Coarse neuron accounting for a judge call (v1 attribution, mirrors `recordThinkSpend`). */
const CHARS_PER_TOKEN = 4
const GEN_NEURONS_PER_TOKEN = 0.4

/** The deterministic dream run id — the SINGLE source used by the workflow, cron, and op. */
export const dreamRunId = (tenantId: string, now: Date = new Date()): string =>
  `dream-${tenantId}-${now.toISOString().slice(0, 10).replace(/-/g, "")}`

/** The tenant-scoped bundle `runDreamConsolidation` needs (built by `createDreamServices`). */
export interface DreamServices {
  /** For the budget read + spend attribution (`readWindowSpendNeurons` / `recordSpend`). */
  db: ScopedDB
  /** The raw handle for the tenant-forced select/apply helpers (legal inside `@brain/db`). */
  raw: BrainDrizzle
  /** The `dream_runs` lifecycle store. */
  runs: DreamRunStore
  /** The AI slice (embed for residual clustering, genExtract for judging). */
  ai: Pick<ScopedServices["ai"], "embed" | "genExtract">
  /** The resolved principal (tenant forced on every helper). */
  principal: Principal
}

/** Options for one consolidation run. */
export interface DreamConsolidationOptions {
  /** Override the run id (tests). Default `dream-${tenantId}-${yyyymmdd}`. */
  runId?: string
  /** Per-run neuron cap; the effective threshold is `min(10% remaining ceiling, this)`. */
  maxNeurons?: number
  /** Freeze "now" (tests) — ISO string. Default `new Date().toISOString()`. */
  now?: string
}

/** The counts-only run summary (safe as a Workflow step output). */
export interface DreamConsolidationResult {
  runId: string
  status: DreamRunStatus
  /** True when the run was a same-day no-op (already complete). */
  noop: boolean
  /** True when the run resumed from a prior budget-stopped cursor. */
  resumed: boolean
  stats: DreamRunStats
  /** Clusters left unprocessed when the run stopped on budget (0 on clean completion). */
  clustersRemaining: number
}

const estimateClusterNeurons = (chars: number): number =>
  Math.ceil((chars + 200) / CHARS_PER_TOKEN) * GEN_NEURONS_PER_TOKEN

/** Run one fact-consolidation dream. See the module doc for the budget/resume/idempotency model. */
export const runDreamConsolidation = async (
  services: DreamServices,
  opts?: DreamConsolidationOptions,
): Promise<DreamConsolidationResult> => {
  const now = opts?.now ?? new Date().toISOString()
  const runId = opts?.runId ?? dreamRunId(services.principal.tenantId, new Date(now))
  const window = monthlyWindow(new Date(now))

  const existing = await services.runs.get(runId)
  // The DB column is a free `string`; the CHECK constraint guarantees it is a DreamRunStatus.
  const existingStatus = (existing?.status ?? null) as DreamRunStatus | null

  // Same-day no-op keys off `success` ONLY (success is terminal, cursor always null there).
  if (existingStatus === "success") {
    return {
      runId,
      status: "success",
      noop: true,
      resumed: false,
      stats: existing?.stats ?? { ...ZERO_DREAM_STATS },
      clustersRemaining: 0,
    }
  }
  // A `running` (another worker) or `cancelled` row is not claimable → no-op without claiming.
  if (existingStatus !== null && !CLAIMABLE_FROM.includes(existingStatus)) {
    return {
      runId,
      status: existingStatus,
      noop: true,
      resumed: false,
      stats: existing?.stats ?? { ...ZERO_DREAM_STATS },
      clustersRemaining: 0,
    }
  }

  if (existing === null) {
    await services.runs.createRun({ id: runId, kind: "consolidation" })
  }
  const fromStatus: DreamRunStatus = existingStatus ?? "queued"
  const claimed = await services.runs.claim(runId, fromStatus)
  if (!claimed) {
    // Lost the claim race (another worker flipped it to running first) → no-op (drop-don't-error).
    const current = await services.runs.get(runId)
    return {
      runId,
      status: (current?.status ?? "running") as DreamRunStatus,
      noop: true,
      resumed: false,
      stats: current?.stats ?? { ...ZERO_DREAM_STATS },
      clustersRemaining: 0,
    }
  }

  const resumeCursor = existing?.cursor ?? null
  const resumed = existingStatus === "paused" || existingStatus === "failure"
  const stats: DreamRunStats = { ...(existing?.stats ?? ZERO_DREAM_STATS) }

  try {
    const spent = await services.db.readWindowSpendNeurons(window)
    const remaining = Math.max(0, MONTHLY_NEURON_CEILING - spent)
    const threshold = Math.min(remaining * 0.1, opts?.maxNeurons ?? Number.POSITIVE_INFINITY)

    const clusters = await selectClusters(services.raw, services.principal, services.ai)
    const pending = resumeCursor === null ? clusters : clusters.filter((c) => c.key > resumeCursor)

    let runNeurons = 0
    let lastKey = resumeCursor
    let processed = 0
    let stoppedOnBudget = false

    for (const cluster of pending) {
      if (runNeurons >= threshold) {
        stoppedOnBudget = true
        break
      }
      const verdict = await judgeCluster(services.ai, cluster)
      const neurons = estimateClusterNeurons(cluster.facts.reduce((s, f) => s + f.fact.length, 0))
      runNeurons += neurons
      await services.db.recordSpend({
        window,
        model: EXTRACT_MODEL,
        surface: "dream",
        neurons,
      })
      const outcome = await applyCluster(services.raw, services.principal, cluster, verdict, now)
      stats.clustersJudged += 1
      stats.merged += outcome.merged
      stats.superseded += outcome.superseded
      stats.contradictions += outcome.contradictions
      stats.kept += outcome.kept
      stats.skipped += verdict.skipped ? 1 : 0
      stats.neurons += neurons
      lastKey = cluster.key
      processed += 1
      await services.runs.persistProgress(runId, lastKey, stats)
    }

    const clustersRemaining = pending.length - processed
    if (stoppedOnBudget) {
      // Budget stop → PAUSED with the resume cursor (which may be null if we stopped before the
      // first cluster; the `paused` status — not the cursor — is what marks it resumable).
      await services.runs.persistProgress(runId, lastKey, stats)
      await services.runs.finishRun(runId, "paused")
      return { runId, status: "paused", noop: false, resumed, stats, clustersRemaining }
    }
    // Clean completion → SUCCESS with cursor cleared (a same-day re-run then no-ops).
    await services.runs.persistProgress(runId, null, stats)
    await services.runs.finishRun(runId, "success")
    return { runId, status: "success", noop: false, resumed, stats, clustersRemaining: 0 }
  } catch (err) {
    await services.runs.finishRun(
      runId,
      "failure",
      err instanceof Error ? err.message : String(err),
    )
    throw err
  }
}

/**
 * `createDreamServices(env, principal)` — the tenant-scoped bundle the `DreamWorkflow` + the
 * `dream_now` op build. Reuses the full `ScopedServices` (for the budget read/spend + AI slice) and
 * adds the raw handle + the `dream_runs` store. Obtaining the raw `BrainDrizzle` here is legal —
 * `packages/db` is the ONLY package allowed to touch `env.DB` (invariant 2).
 */
export const createDreamServices = (env: BrainBindings, principal: Principal): DreamServices => {
  const base = createScopedServices(env, principal)
  const raw = drizzle(env.DB)
  return {
    db: base.db,
    ai: { embed: base.ai.embed, genExtract: base.ai.genExtract },
    raw,
    runs: new DreamRunStore(raw, principal),
    principal,
  }
}

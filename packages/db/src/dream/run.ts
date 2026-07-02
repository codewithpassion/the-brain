/**
 * `runDreamConsolidation` (v2 W1/D1) — consolidation over the shared `runDreamJob` FSM driver.
 * The driver owns the lifecycle (same-day no-op on `success`, claim-by-changed-rows, resume from a
 * `paused`/`failure` cursor, the budget slice = min(10% remaining ceiling, `maxNeurons`), the
 * paused/success/failure flips). This module supplies only the consolidation-specific work:
 * `selectClusters` → `judgeCluster` → `applyCluster`, recording `surface='dream'` spend per cluster.
 *
 * SCOPING (D-i4): every read/write goes through the tenant-forced select/apply/runs helpers built
 * from the Principal — one tenant's dream never touches another's memory.
 */

import type { Principal } from "@brain/shared"
import { EXTRACT_MODEL } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import type { BrainDrizzle, ScopedDB } from "../scoped/db"
import { monthlyWindow } from "../search/ports"
import { createScopedServices, type ScopedServices } from "../services"
import { applyCluster } from "./apply"
import { runDreamJob } from "./job"
import { judgeCluster } from "./judge"
import { type DreamRunStats, type DreamRunStatus, DreamRunStore } from "./runs"
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

/** Run one fact-consolidation dream over the shared FSM driver. */
export const runDreamConsolidation = async (
  services: DreamServices,
  opts?: DreamConsolidationOptions,
): Promise<DreamConsolidationResult> => {
  const now = opts?.now ?? new Date().toISOString()
  const runId = opts?.runId ?? dreamRunId(services.principal.tenantId, new Date(now))
  const window = monthlyWindow(new Date(now))

  const result = await runDreamJob(services.runs, {
    runId,
    kind: "consolidation",
    ...(opts?.maxNeurons !== undefined ? { maxNeurons: opts.maxNeurons } : {}),
    windowSpentNeurons: () => services.db.readWindowSpendNeurons(window),
    selectItems: () => selectClusters(services.raw, services.principal, services.ai),
    itemKey: (cluster) => cluster.key,
    processItem: async (cluster) => {
      const verdict = await judgeCluster(services.ai, cluster)
      const neurons = estimateClusterNeurons(cluster.facts.reduce((s, f) => s + f.fact.length, 0))
      await services.db.recordSpend({ window, model: EXTRACT_MODEL, surface: "dream", neurons })
      const outcome = await applyCluster(services.raw, services.principal, cluster, verdict, now)
      return {
        neurons,
        statsDelta: {
          clustersJudged: 1,
          merged: outcome.merged,
          superseded: outcome.superseded,
          contradictions: outcome.contradictions,
          kept: outcome.kept,
          skipped: verdict.skipped ? 1 : 0,
          neurons,
        },
        payload: null,
      }
    },
  })

  return {
    runId: result.runId,
    status: result.status,
    noop: result.noop,
    resumed: result.resumed,
    stats: result.stats,
    clustersRemaining: result.itemsRemaining,
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

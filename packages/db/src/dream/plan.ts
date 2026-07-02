/**
 * Dream step-group planning — the SINGLE source for the `kind` set, the reflection run-id
 * suffix, the ordered kind→steps mapping, and status aggregation. Both the `DreamWorkflow`
 * (apps/api) and the inline `dispatchDreamRun` (packages/db) iterate `dreamStepPlan`, so the two
 * dispatch paths cannot diverge on which groups run, in what order, or under which run ids. This
 * module imports nothing from run/reflect/dispatch (no cycles).
 */
import type { DreamRunStatus } from "./runs"

/** Which dream step groups to run. `dedup` is a STANDALONE sweep (not part of `all`). */
export type DreamKind = "consolidation" | "reflection" | "dedup" | "all"

/** The `kind` enum values — one source (op zod + dispatch default read from here). */
export const DREAM_KINDS = ["consolidation", "reflection", "dedup", "all"] as const

/**
 * One step group in a dream run. `consolidation`/`reflection` drive a `dream_runs` row keyed by
 * `runId`; `digest` is a terminal one-shot step (no run row — it writes `agent/digest/daily`), so
 * its `runId` is the base run id it summarizes.
 */
export interface DreamStep {
  group: "consolidation" | "reflection" | "digest" | "dedup"
  runId: string
}

/** The reflection run id — the dispatch (consolidation) run id + a `-reflection` suffix. */
export const reflectionRunId = (baseRunId: string): string => `${baseRunId}-reflection`
/** The dedup run id — the dispatch run id + a `-dedup` suffix (its own `dream_runs` row). */
export const dedupRunId = (baseRunId: string): string => `${baseRunId}-dedup`

/**
 * The ordered step groups for a `kind`, each with its run id derived from the SINGLE dispatch
 * `baseRunId`. Consolidation first (reflection reads consolidated facts), then reflection, then —
 * for the full daily run (`kind='all'`) only — the digest that summarizes both.
 *
 * `dedup` is a STANDALONE sweep (`kind='dedup'`, one step) — deliberately NOT part of `all` yet:
 * it is graph hygiene over the whole entity set, independent of a night's new content, so it runs
 * on its own cadence via `dream_now kind='dedup'`. The nightly `all` can adopt it later.
 */
export const dreamStepPlan = (baseRunId: string, kind: DreamKind): DreamStep[] => {
  if (kind === "dedup") return [{ group: "dedup", runId: dedupRunId(baseRunId) }]
  const steps: DreamStep[] = []
  if (kind !== "reflection") steps.push({ group: "consolidation", runId: baseRunId })
  if (kind !== "consolidation")
    steps.push({ group: "reflection", runId: reflectionRunId(baseRunId) })
  if (kind === "all") steps.push({ group: "digest", runId: baseRunId })
  return steps
}

/** Severity order for aggregating step statuses into one run status (worst wins). */
const STATUS_RANK: Record<DreamRunStatus, number> = {
  failure: 4,
  paused: 3,
  running: 2,
  queued: 1,
  cancelled: 1,
  success: 0,
}

/** Aggregate step statuses to the WORST (failure > paused > running > success). Empty → 'success'. */
export const worstStatus = (statuses: DreamRunStatus[]): DreamRunStatus => {
  let worst: DreamRunStatus = "success"
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
  return worst
}

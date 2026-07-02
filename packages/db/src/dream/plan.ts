/**
 * Dream step-group planning — the SINGLE source for the `kind` set, the reflection run-id
 * suffix, the ordered kind→steps mapping, and status aggregation. Both the `DreamWorkflow`
 * (apps/api) and the inline `dispatchDreamRun` (packages/db) iterate `dreamStepPlan`, so the two
 * dispatch paths cannot diverge on which groups run, in what order, or under which run ids. This
 * module imports nothing from run/reflect/dispatch (no cycles).
 */
import type { DreamRunStatus } from "./runs"

/** Which dream step groups to run. */
export type DreamKind = "consolidation" | "reflection" | "all"

/** The `kind` enum values — one source (op zod + dispatch default read from here). */
export const DREAM_KINDS = ["consolidation", "reflection", "all"] as const

/** One step group in a dream run, with the `dream_runs` row id it drives. */
export interface DreamStep {
  group: "consolidation" | "reflection"
  runId: string
}

/** The reflection run id — the dispatch (consolidation) run id + a `-reflection` suffix. */
export const reflectionRunId = (baseRunId: string): string => `${baseRunId}-reflection`

/**
 * The ordered step groups for a `kind`, each with its run id derived from the SINGLE dispatch
 * `baseRunId`. Consolidation first (reflection reads consolidated facts), then reflection.
 */
export const dreamStepPlan = (baseRunId: string, kind: DreamKind): DreamStep[] => {
  const steps: DreamStep[] = []
  if (kind !== "reflection") steps.push({ group: "consolidation", runId: baseRunId })
  if (kind !== "consolidation")
    steps.push({ group: "reflection", runId: reflectionRunId(baseRunId) })
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

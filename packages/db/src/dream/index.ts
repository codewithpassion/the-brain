/**
 * `@brain/db/dream` — the Dream engine core (v2 W1/D1): candidate selection, cluster judging,
 * non-destructive apply, the resumable/budgeted run orchestrator, the shared dispatch helper, the
 * `dream_runs` lifecycle store, and the `dream_now`/`list_dream_runs` op contracts.
 */
export { type ApplyOutcome, AUTO_MERGE_FLOOR, applyCluster, ID_CHUNK } from "./apply"
export {
  type DreamDispatchEnv,
  type DreamDispatchResult,
  type DreamWorkflowLike,
  dispatchDreamRun,
  isDuplicateInstanceError,
} from "./dispatch"
export { type DreamAction, type DreamVerdict, type JudgeAi, judgeCluster } from "./judge"
export {
  DREAM_NOW_OP,
  DREAM_OP_DEFS,
  LIST_DREAM_RUNS_OP,
  type ListDreamRunRow,
  listDreamRunsCore,
  listDreamRunsOp,
  registerDreamOps,
} from "./ops"
export {
  createDreamServices,
  type DreamConsolidationOptions,
  type DreamConsolidationResult,
  type DreamServices,
  dreamRunId,
  runDreamConsolidation,
} from "./run"
export {
  CLAIMABLE_FROM,
  type CreateDreamRunInput,
  type DreamRunRow,
  type DreamRunStats,
  type DreamRunStatus,
  DreamRunStore,
  ZERO_DREAM_STATS,
} from "./runs"
export {
  type DreamCluster,
  type DreamFact,
  MAX_CLUSTER_SIZE,
  MAX_RESIDUALS_PER_GROUP,
  type SelectAi,
  selectClusters,
} from "./select"

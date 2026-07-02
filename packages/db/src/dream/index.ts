/**
 * `@brain/db/dream` — the Dream engine core (v2 W1): candidate selection, cluster judging,
 * non-destructive apply, reflection, the shared run-FSM driver + step plan, the dispatch helper,
 * the `dream_runs` lifecycle store, and the `dream_now`/`list_dream_runs` op contracts.
 */
export { type ApplyOutcome, AUTO_MERGE_FLOOR, applyCluster, ID_CHUNK } from "./apply"
export {
  createDreamDigestServices,
  DIGEST_SLUG,
  type DreamDigestOptions,
  type DreamDigestResult,
  type DreamDigestServices,
  runDreamDigest,
} from "./digest"
export {
  type DreamDispatchEnv,
  type DreamDispatchResult,
  type DreamWorkflowLike,
  dispatchDreamRun,
  isDuplicateInstanceError,
} from "./dispatch"
export { type DreamJobResult, type DreamJobSpec, type ProcessResult, runDreamJob } from "./job"
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
  DREAM_KINDS,
  type DreamKind,
  type DreamStep,
  dreamStepPlan,
  worstStatus,
} from "./plan"
export {
  createDreamReflectServices,
  type DreamReflectionOptions,
  type DreamReflectionResult,
  type DreamReflectServices,
  runDreamReflection,
  selectReflectionTargets,
} from "./reflect"
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

/**
 * `apps/api` Dream engine glue (v2 W1/D1): the durable `DreamWorkflow`, its binding contract, and
 * the nightly cron sweep. The consolidation logic itself lives in `@brain/db` (`dream/**`).
 */
export type { DreamBindings } from "./bindings"
export {
  type DreamSweepResult,
  runNightlyDreamSweep,
  runSessionContextRefreshSweep,
} from "./cron"
export { DreamWorkflow, type DreamWorkflowParams } from "./workflow"

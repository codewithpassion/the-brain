/**
 * Binding contract the Dream engine cron/dispatch needs (orchestrator wires the real one).
 *
 * `DREAM` is the deploy-only Workflows binding for `DreamWorkflow` — absent locally/in test
 * (Workflows have no pool-workers emulation), so it is OPTIONAL: the nightly cron runs
 * `runDreamConsolidation` inline when it is absent and dispatches the durable workflow when
 * present, exactly like `SESSION_PROMOTE`/`BATCH_INGEST`.
 */
import type { ApiBindings } from "../bindings"
import type { DreamWorkflowParams } from "./workflow"

export type DreamBindings = ApiBindings & {
  /** Deploy-only Workflows binding for `DreamWorkflow`; absent locally (see module doc). */
  DREAM?: Workflow<DreamWorkflowParams>
}

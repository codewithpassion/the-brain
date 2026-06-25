/**
 * Binding contract the session/governance surfaces NEED (orchestrator wires the real ones).
 *
 * `SESSION_PROMOTE` is the deploy-only Workflows binding for `SessionPromoteWorkflow` — absent
 * locally/in test (Workflows have no pool-workers emulation), so it is OPTIONAL: the idle cron
 * runs `runSessionPromote` inline when it is absent and dispatches the durable workflow when
 * present, exactly like `BATCH_INGEST`. When the orchestrator adds it to `wrangler.jsonc` +
 * `ApiBindings`, this optional shape is already satisfied.
 */
import type { ApiBindings } from "../bindings"
import type { SessionPromoteWorkflowParams } from "./workflow"

export type SessionBindings = ApiBindings & {
  /** Deploy-only Workflows binding for `SessionPromoteWorkflow`; absent locally (see module doc). */
  SESSION_PROMOTE?: Workflow<SessionPromoteWorkflowParams>
}

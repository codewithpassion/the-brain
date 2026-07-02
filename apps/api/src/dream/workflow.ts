/**
 * `DreamWorkflow` — the deploy-time durable wrapper around `runDreamConsolidation` (v2 W1/D1).
 *
 * Mirrors `SessionPromoteWorkflow`: re-creates the tenant-scoped `DreamServices` from the
 * serialized `Principal` in the payload, then runs the select→judge→apply loop inside a durable
 * `step.do()` returning a counts-only summary (< 1 MiB, cap-safe). The deterministic instance id
 * `dream-${tenantId}-${yyyymmdd}` (set by the caller at `create()`) makes a duplicate same-day
 * dispatch a no-op (invariant 15); the run row's budget cursor makes a resume idempotent.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import {
  createDreamServices,
  type DreamConsolidationResult,
  runDreamConsolidation,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import type { ApiBindings } from "../bindings"

/** The serializable payload the `DreamWorkflow` carries (runId = the dispatcher's `dreamRunId`). */
export interface DreamWorkflowParams {
  principal: Principal
  runId: string
}

export class DreamWorkflow extends WorkflowEntrypoint<ApiBindings, DreamWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<DreamWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<DreamConsolidationResult> {
    const { principal, runId } = event.payload
    const services = createDreamServices(this.env, principal)
    // The row id MUST equal the dispatcher's runId (== the workflow's logical id) so resume/no-op
    // key off the same row.
    return step.do("dream-consolidation", () => runDreamConsolidation(services, { runId }))
  }
}

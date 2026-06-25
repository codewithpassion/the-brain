/**
 * `SessionPromoteWorkflow` — the deploy-time durable wrapper around `runSessionPromote` (PRD §8.3).
 *
 * Mirrors `BatchIngestWorkflow` (../workflow.ts): re-creates the tenant-scoped `SessionServices`
 * from the serialized `Principal` in the payload, then runs the promote-to-fact + embed loop
 * inside a durable `step.do()`. The deterministic instance id `promote-${tenantId}-${sessionId}`
 * (set by the caller at `create()`) makes a duplicate Stop-hook / racing idle-cron a no-op
 * (invariant 15). A clean-replace writeback + deterministic chunk ids make a retry idempotent.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import {
  createSessionServices,
  runSessionPromote,
  type SessionPromoteParams,
  type SessionPromoteResult,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import type { ApiBindings } from "../bindings"

/** The serializable payload the `SessionPromoteWorkflow` carries. */
export interface SessionPromoteWorkflowParams {
  principal: Principal
  promote: SessionPromoteParams
}

export class SessionPromoteWorkflow extends WorkflowEntrypoint<
  ApiBindings,
  SessionPromoteWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<SessionPromoteWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<SessionPromoteResult> {
    const { principal, promote } = event.payload
    const services = createSessionServices(this.env, principal)
    return step.do("session-promote", () => runSessionPromote(services, promote))
  }
}

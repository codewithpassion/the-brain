/**
 * `BatchIngestWorkflow` — the deploy-time durable wrapper around `runBatchIngest` (PRD §4,
 * Durable execution). Declared so the binding can be bound at DEPLOY; it has NO local
 * pool-workers emulation, so the e2e slice drives `runBatchIngest` directly (the `/ingest`
 * route falls back to the inline call when `env.BATCH_INGEST` is absent).
 *
 * The Workflow re-creates the tenant-scoped `ScopedServices` from the serialized `Principal`
 * in its payload (`createScopedServices(this.env, principal)`), then runs the pipeline inside
 * a durable `step.do()` boundary. The hand-off into the step is R2 *references* + the small
 * `BatchIngestResult` summary out of it — never an inline body — so no step output approaches
 * the 1 MiB cap (see ingest.ts "CAP-SAFE HAND-OFFS"). A real production decomposition would
 * split this into per-phase steps (extract → chunk → embed-batch → finalize), each staging
 * its body in R2 and returning only a reference; the deterministic instance id
 * (`ingest-${tenantId}-${fingerprint}`) + the `(tenant,scope,fingerprint)` UNIQUE dedup make
 * every step idempotent under retry (invariant 15).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { createScopedServices } from "@brain/db"
import type { ApiBindings } from "./bindings"
import { type BatchIngestResult, type BatchIngestWorkflowParams, runBatchIngest } from "./ingest"

export class BatchIngestWorkflow extends WorkflowEntrypoint<
  ApiBindings,
  BatchIngestWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<BatchIngestWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<BatchIngestResult> {
    const { principal, ingest } = event.payload
    const services = createScopedServices(this.env, principal)
    return step.do("batch-ingest", () => runBatchIngest(services, ingest))
  }
}

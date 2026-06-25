/**
 * `ApiBindings` — the Worker env as seen by `apps/api`.
 *
 * The authoritative binding contract is the frozen `BrainBindings` (packages/db). The single
 * api-local extension is the DEPLOY-ONLY `BATCH_INGEST` Workflows binding: it is NOT declared
 * in the test-loaded `wrangler.jsonc` (Workflows have no local pool-workers emulation), so it
 * is OPTIONAL here. When absent (local/test) the `/ingest` route runs `runBatchIngest`
 * inline; when present (deploy) it dispatches the durable `BatchIngestWorkflow`.
 *
 * `Workflow` is a runtime binding type (from `@cloudflare/workers-types`) and is NOT one of
 * the boundary-lint-banned raw binding type names (`D1Database`/`Vectorize`/`R2Bucket`).
 */
import type { BrainBindings } from "@brain/db"
import type { EntityExtractionWorkflowParams } from "./entity-extraction"
import type { BatchIngestWorkflowParams } from "./ingest"

export type ApiBindings = BrainBindings & {
  /** Deploy-only Workflows binding; absent locally (see module doc). */
  BATCH_INGEST?: Workflow<BatchIngestWorkflowParams>
  /** Deploy-only Workflows binding for Phase-4 KG extraction; absent locally. */
  ENTITY_EXTRACTION?: Workflow<EntityExtractionWorkflowParams>
}

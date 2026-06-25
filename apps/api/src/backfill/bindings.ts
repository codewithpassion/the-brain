/**
 * Binding contract the backfill spine NEEDS (orchestrator wires the real ones into
 * `wrangler.jsonc` + `index.ts`).
 *
 * All four are DEPLOY-ONLY and therefore OPTIONAL: Queues + Workflows have no local pool-workers
 * emulation, so the test harness never binds them. The testable functions (`runEnumerate`,
 * `runBackfillMessage`, `runReembedSweep`, `runReembedMessage`) take an INJECTED `enqueue`/run the
 * work inline, so the round-trip is proven without a live queue (exactly like `BATCH_INGEST` for
 * ingest). When the orchestrator adds the bindings, this optional shape is already satisfied.
 *
 *   - `BACKFILL_QUEUE` (+ DLQ `brain-backfill-dlq`) — the enumerated-item dispatch queue.
 *   - `REEMBED_QUEUE`  (+ DLQ `brain-reembed-dlq`)  — the re-embed migration queue (cron-fed).
 *   - `ENUMERATOR` — the `EnumeratorWorkflow` binding (one instance per (tenant, source)).
 *   - the every-N-min `brain-reembed` cron trigger feeding `runReembedSweep`.
 */
import type { ApiBindings } from "../bindings"
import type { EnumeratorWorkflowParams } from "./enumerate"
import type { BackfillMessage, ReembedMessage } from "./messages"

export type BackfillBindings = ApiBindings & {
  /** Deploy-only `brain-backfill` producer binding; absent locally/in test. */
  BACKFILL_QUEUE?: Queue<BackfillMessage>
  /** Deploy-only `brain-reembed` producer binding; absent locally/in test. */
  REEMBED_QUEUE?: Queue<ReembedMessage>
  /** Deploy-only Enumerator Workflows binding; absent locally/in test. */
  ENUMERATOR?: Workflow<EnumeratorWorkflowParams>
}

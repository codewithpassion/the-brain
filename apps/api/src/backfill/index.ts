/**
 * Backfill spine + re-embed migration (PRD §8.6/§8.7) — the `apps/api` surface: the Enumerator
 * Workflow + testable `runEnumerate`, the `brain-backfill`/`brain-reembed` Queue consumers, the
 * re-embed cron sweep, and the importer→capture wiring. Composes the FROZEN `runBatchIngest` (never
 * edits it) and the `@brain/db` backfill stores/validators; declares (does not wire) its bindings.
 */
export type { BackfillBindings } from "./bindings"
export type { CaptureSessionResult, ImportCaptureResult } from "./capture"
export { captureSession, runImportCapture } from "./capture"
export {
  BACKFILL_RETRY_DELAY,
  BackfillRejectError,
  handleBackfillQueue,
  runBackfillMessage,
} from "./consume"
export type {
  EnumerateDeps,
  EnumerateResult,
  EnumeratorWorkflowParams,
  ImporterClient,
} from "./enumerate"
export {
  EnumeratorWorkflow,
  importerForClient,
  listVaultSlugs,
  reconcileObsidianDeletions,
  runEnumerate,
  stageKey,
} from "./enumerate"
export type { BackfillMessage, ReembedMessage } from "./messages"
export {
  estimateReembedNeurons,
  handleReembedQueue,
  REEMBED_RETRY_DELAY,
  type ReembedSweepOptions,
  type ReembedSweepResult,
  runReembedMessage,
  runReembedSweep,
} from "./reembed"

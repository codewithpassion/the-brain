/**
 * Sessions + hot memory (PRD §8) — the capture/finalize/context/recall ops, the promote-to-fact
 * clean-replace writeback, and the tenant-scoped `SessionStore`. Composes the frozen `Scoped*`
 * chokepoints; builds no new raw arms. See the modules for per-op invariants.
 */
export type { AuditExportCursorStore, IdleSession } from "./idle"
export {
  createAuditExportCursorStore,
  findIdleSessions,
  idleCutoff,
  listTenantIds,
} from "./idle"
export type {
  CaptureTurnRequest,
  RecallRequest,
  SessionContext,
} from "./ops"
export {
  CAPTURE_TURN_OP,
  CREATE_SNAPSHOT_OP,
  captureTurn,
  createSnapshot,
  FINALIZE_SESSION_OP,
  FORGET_FACT_OP,
  forgetFact,
  GET_SESSION_CONTEXT_OP,
  getSessionContext,
  LIST_SNAPSHOTS_OP,
  listSnapshots,
  RECALL_OP,
  REVIVE_FACT_OP,
  recall,
  registerSessionOps,
  reviveFact,
  SESSION_OPS,
} from "./ops"
export type { SessionPromoteParams, SessionPromoteResult } from "./promote"
export { runSessionPromote } from "./promote"
export type { SessionServices, SessionServicesOptions } from "./services"
export { createSessionServices } from "./services"
export type {
  CaptureTurnInput,
  CaptureTurnResult,
  PinnedPage,
  PromotedFact,
  RecalledFact,
  RecallQuery,
  SessionRow,
  SessionTurnRow,
  SnapshotManifest,
  SnapshotRow,
} from "./store"
export { SessionStore, TURN_INLINE_MAX, transcriptKey } from "./store"

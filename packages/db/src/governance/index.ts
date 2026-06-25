/**
 * Governance (PRD §7.5/§7.6) — trust promotion (the ONLY path to `instruction`), the audited
 * break-glass exception, and append-only audit export. Composes the frozen `Scoped*`
 * chokepoints + the shared visibility/scope predicates.
 */
export { createBreakGlassAuditSink } from "./audit-sink"
export type { BreakGlassReadResult } from "./ops"
export {
  AUDIT_EXPORT_OP,
  auditExport,
  BREAK_GLASS_READ_OP,
  breakGlassRead,
  GOVERNANCE_OPS,
  MEMORY_REVIEW_OP,
  registerGovernanceOps,
  submitMemoryReview,
} from "./ops"
export type { AuditExportResult, AuditRow, BreakGlassFact } from "./store"
export { GovernanceStore } from "./store"

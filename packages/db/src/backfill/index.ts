/**
 * Backfill spine + re-embed migration (PRD §8.6/§8.7) — the tenant-scoped ops stores, the
 * fail-closed message→tenant/Principal validators, and the `createBackfillServices` factory the
 * `apps/api` Enumerator + queue/cron consumers compose. Builds no new raw arms: every store forces
 * `tenant_id` from the `Principal` and routes atomicity through `db.batch` (invariants 1, 11).
 */
export type { ReembedCandidate } from "./reembed"
export { ReembedStore } from "./reembed"
export type {
  BackfillRunRow,
  CreateRunInput,
  RunStats,
  RunStatus,
} from "./runs"
export { BackfillRunStore, ZERO_STATS } from "./runs"
export type { BackfillServices } from "./services"
export { createBackfillServices } from "./services"
export type { SourceRow } from "./sources"
export { BACKOFF_BASE_MS, isBackoffReady, SourceStore } from "./sources"
export type { TenantBearingMessage, ValidatedTenant } from "./tenant"
export {
  findOrg,
  principalFromMessage,
  principalFromMessageDb,
  tenantFromMessage,
} from "./tenant"

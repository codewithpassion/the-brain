/**
 * `createBackfillServices(env, principal)` — the tenant-scoped bundle the backfill spine
 * (Enumerator, the `brain-backfill`/`brain-reembed` consumers, the re-embed cron) receives
 * (PRD §8.6/§8.7).
 *
 * Built on the FULL `createScopedServices` bundle (so it satisfies `runBatchIngest`'s
 * `ScopedServices` contract — incl. the Phase-4 `entityVectors`/`graph`/`ai.genExtract` the document
 * ingest path now uses), PLUS the `SessionStore`/`GovernanceStore` (backfill drives importer→capture)
 * and the three NET-NEW ops stores this phase owns: `runs` (`backfill_runs` lifecycle), `sources`
 * (sync state + backoff), `reembed` (stale-candidate selection). Obtaining the raw `BrainDrizzle`
 * here is legal — `packages/db` is the ONLY package allowed to touch `env.DB` (invariant 2); `apps/api`
 * never sees a raw binding, only this scoped bundle.
 */
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { GovernanceStore } from "../governance"
import { createScopedServices, type ScopedServices, type ScopedServicesOptions } from "../services"
import { SessionStore } from "../sessions"
import { ReembedStore } from "./reembed"
import { BackfillRunStore } from "./runs"
import { SourceStore } from "./sources"

/** The per-request, tenant-scoped backfill service bundle. */
export interface BackfillServices extends ScopedServices {
  sessions: SessionStore
  governance: GovernanceStore
  runs: BackfillRunStore
  sources: SourceStore
  reembed: ReembedStore
}

export const createBackfillServices = (
  env: BrainBindings,
  principal: Principal,
  options?: ScopedServicesOptions,
): BackfillServices => {
  const base = createScopedServices(env, principal, options)
  const raw = drizzle(env.DB)
  return {
    ...base,
    sessions: new SessionStore(raw, principal),
    governance: new GovernanceStore(raw, principal, options?.breakGlassAudit),
    runs: new BackfillRunStore(raw, principal),
    sources: new SourceStore(raw, principal),
    reembed: new ReembedStore(raw, principal),
  }
}

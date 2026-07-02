/**
 * The nightly Dream cron (v2 W1/D1) — the `0 3 * * *` branch of `scheduled()`.
 *
 * Enumerates every tenant and dispatches a consolidation dream via the SHARED `dispatchDreamRun`
 * helper (workflow-or-inline; the same path `dream_now` uses), with a per-tenant `systemAdmin`
 * Principal (no token, no secret — §7.8; all reads/writes still go through `Scoped*`/the dream
 * helpers). Each tenant is wrapped in its own try/catch so one tenant's failure — whether the
 * workflow dispatch OR the inline run throws — can never abort the sweep; failures are counted.
 */
import { dispatchDreamRun, listTenantIds } from "@brain/db"
import { systemAdmin } from "../sessions"
import type { DreamBindings } from "./bindings"

/** The nightly sweep outcome (logged; the cron caller fires it via `waitUntil`). */
export interface DreamSweepResult {
  dispatched: number
  failed: number
}

/** Dispatch a consolidation dream for every tenant. One tenant's failure never aborts the sweep. */
export const runNightlyDreamSweep = async (env: DreamBindings): Promise<DreamSweepResult> => {
  const tenantIds = await listTenantIds(env)
  let dispatched = 0
  let failed = 0
  for (const tenantId of tenantIds) {
    try {
      await dispatchDreamRun(env, systemAdmin(tenantId))
      dispatched++
    } catch (err) {
      failed++
      console.error(`dream sweep failed for tenant ${tenantId}`, err)
    }
  }
  return { dispatched, failed }
}

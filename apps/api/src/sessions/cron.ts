/**
 * Cron handlers for sessions + governance (PRD §8.3, §7.6) — the `scheduled()` entry points the
 * orchestrator mounts on the every-5-minute cron trigger.
 *
 *   - `runIdlePromotionSweep` — promotes `status='open'` sessions idle past `idleMinutes`. Keys on
 *     `last_activity_at`, NOT `ended_at` (invariant 21): a missed Stop-hook is exactly the case
 *     where `ended_at` is NULL. Deterministic workflow id `promote-${tenantId}-${sessionId}` makes
 *     a racing manual finalize a no-op.
 *   - `runAuditExportSweep` — exports each tenant's new append-only `memory_audit` rows to
 *     tamper-evident R2 ndjson (invariant 10 / §7.6 SC7). Cursor get/set is injected so the
 *     orchestrator owns durable cursor storage (e.g. KV).
 *
 * Both build a SYSTEM `Principal` from the explicit `tenant_id` (no token, no secret — §7.8);
 * all writes still go through `Scoped*`/the stores (bindings remove the wire, not the gate).
 */

import {
  auditExport,
  createSessionServices,
  findIdleSessions,
  type IdleSession,
  listTenantIds,
  runSessionPromote,
} from "@brain/db"
import { workflowInstanceId } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import type { SessionBindings } from "./bindings"
import type { SessionPromoteWorkflowParams } from "./workflow"

/** Default idle threshold before an un-finalized session is force-promoted. */
export const DEFAULT_IDLE_MINUTES = 30

/** Build the per-session system `Principal` (authorship = the session's own user; full scope). */
const systemPrincipal = (session: IdleSession): Principal => ({
  tenantId: session.tenantId,
  userId: session.userId,
  teamIds: session.teamId !== null ? [session.teamId] : [],
  role: "member",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
})

/** A system admin `Principal` for a tenant — the audit-export read needs owner/admin authority. */
const systemAdmin = (tenantId: string): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

export interface IdleSweepOptions {
  idleMinutes?: number
  limit?: number
  /** Run `runSessionPromote` inline (local/test) instead of dispatching the durable workflow. */
  inline?: boolean
}

/**
 * Promote every session idle past the threshold. Dispatches `SessionPromoteWorkflow` (deploy,
 * binding present) or runs `runSessionPromote` inline (local/test). Returns the count swept.
 */
export const runIdlePromotionSweep = async (
  env: SessionBindings,
  options: IdleSweepOptions = {},
): Promise<number> => {
  const idleMinutes = options.idleMinutes ?? DEFAULT_IDLE_MINUTES
  const idle = await findIdleSessions(env, idleMinutes, options.limit ?? 100)
  const workflow = options.inline ? undefined : env.SESSION_PROMOTE
  for (const session of idle) {
    const principal = systemPrincipal(session)
    const promote = {
      sessionId: session.id,
      userId: session.userId,
      scope: session.scope,
      teamId: session.teamId,
    }
    if (workflow) {
      const params: SessionPromoteWorkflowParams = { principal, promote }
      await workflow.create({
        id: await workflowInstanceId(`promote-${session.tenantId}-${session.id}`),
        params,
      })
    } else {
      const services = createSessionServices(env, principal)
      await runSessionPromote(services, promote)
    }
  }
  return idle.length
}

export interface AuditExportCursorStore {
  get(tenantId: string): Promise<number>
  set(tenantId: string, cursor: number): Promise<void>
}

/**
 * Export each tenant's new `memory_audit` rows to R2 ndjson, advancing the per-tenant cursor.
 * The cursor store is injected (the orchestrator backs it with KV), so a row is exported once.
 * Returns the total rows exported across all tenants.
 */
export const runAuditExportSweep = async (
  env: SessionBindings,
  cursors: AuditExportCursorStore,
): Promise<number> => {
  const tenantIds = await listTenantIds(env)
  let total = 0
  for (const tenantId of tenantIds) {
    const services = createSessionServices(env, systemAdmin(tenantId))
    const cursor = await cursors.get(tenantId)
    const result = await auditExport(services, cursor)
    if (result.exported > 0) {
      await cursors.set(tenantId, result.cursor)
      total += result.exported
    }
  }
  return total
}

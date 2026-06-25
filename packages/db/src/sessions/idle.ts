/**
 * Idle-session enumeration for the promotion cron (PRD §8.3, invariant 21).
 *
 * A SYSTEM, cross-tenant sweep (no `Principal` — it runs over every tenant), so it lives in
 * `packages/db` (the ONLY package allowed to touch `env.DB`, invariant 2). It keys on
 * `last_activity_at`, NEVER `ended_at`: a missed Stop-hook leaves `ended_at` NULL forever, so an
 * `ended_at`-keyed sweep could never recover it (the iter-3 SC6 fix). Every open session has a
 * non-NULL `last_activity_at` (DEFAULT now() at insert, refreshed on every `capture_turn`), so a
 * session whose Stop-hook never fired is caught the moment it has been idle for `idleMinutes`.
 */
import { and, eq, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { sessions } from "../schema"

/** One idle session to promote — the columns the cron threads into a system `Principal` + workflow. */
export interface IdleSession {
  id: string
  tenantId: string
  scope: string | null
  teamId: string | null
  userId: string
}

/** Compute the ISO cutoff `idleMinutes` before `now` (the sweep's `last_activity_at < cutoff`). */
export const idleCutoff = (idleMinutes: number, now: Date = new Date()): string =>
  new Date(now.getTime() - idleMinutes * 60_000).toISOString()

/**
 * Find `status='open'` sessions whose `last_activity_at` is older than `idleMinutes` (the
 * `idx_sessions_open` sweep target). Bounded by `limit` so one cron tick stays cheap; the next
 * tick picks up the rest (deterministic promote-workflow ids make a racing manual finalize a no-op).
 */
export const findIdleSessions = async (
  env: BrainBindings,
  idleMinutes: number,
  limit = 100,
  now: Date = new Date(),
): Promise<IdleSession[]> => {
  const db = drizzle(env.DB)
  const cutoff = idleCutoff(idleMinutes, now)
  return db
    .select({
      id: sessions.id,
      tenantId: sessions.tenantId,
      scope: sessions.scope,
      teamId: sessions.teamId,
      userId: sessions.userId,
    })
    .from(sessions)
    .where(and(eq(sessions.status, "open"), lt(sessions.lastActivityAt, cutoff)))
    .orderBy(sql`${sessions.lastActivityAt} ASC`)
    .limit(limit)
}

/** Enumerate the tenant ids (orgs) the audit-export sweep iterates (system, cross-tenant). */
export const listTenantIds = async (env: BrainBindings): Promise<string[]> => {
  const rows = await env.DB.prepare("SELECT id FROM orgs").all<{ id: string }>()
  return rows.results.map((row) => row.id)
}

/** Per-tenant audit-export cursor store (the high-water `memory_audit.at` the sweep persists). */
export interface AuditExportCursorStore {
  get(tenantId: string): Promise<number>
  set(tenantId: string, cursor: number): Promise<void>
}

/**
 * Build the audit-export cursor store backed by `OAUTH_KV` (key `audit-export-cursor:${tenantId}`).
 * The raw KV access lives HERE in `packages/db` (invariant 2 / boundary-lint) — the orchestrator's
 * `scheduled()` handler may not name a raw binding. The cursor is the max `memory_audit.at` already
 * exported for that tenant, so the next sweep resumes append-only.
 */
export const createAuditExportCursorStore = (env: BrainBindings): AuditExportCursorStore => ({
  async get(tenantId: string): Promise<number> {
    const raw = await env.OAUTH_KV.get(`audit-export-cursor:${tenantId}`)
    return raw === null ? 0 : Number(raw)
  },
  async set(tenantId: string, cursor: number): Promise<void> {
    await env.OAUTH_KV.put(`audit-export-cursor:${tenantId}`, String(cursor))
  },
})

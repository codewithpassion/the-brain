/**
 * The two un-omittable D1 row predicates (PRD §7.3, authoritative s07).
 *
 * Two axes that are NEVER conflated (invariant 5):
 *   - `scopePredicate` — the DATA-partition axis (`allowedScopes`). Limits a read
 *     to the scopes a principal may touch; `'*'` skips it (sees all tenant scopes).
 *   - `visibilityPredicate` — the intra-tenant access tier (invariant 8). Gates a
 *     visibility-bearing row (`chunks`, `facts`) to `world OR (team ∧ team_id∈teamIds)
 *     OR (private ∧ user_id=p.userId)`. Owner/admin do NOT bypass it here — only the
 *     audited `ScopedDB.breakGlass` path may, and even that never bypasses `tenant_id`.
 *
 * Neither replaces the `tenant_id = p.tenantId` predicate, which `ScopedDB` injects
 * unconditionally on every query — these are ADDED on top of it.
 */
import type { Principal } from "@brain/shared"
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"

/** The three columns a visibility-bearing table exposes to the gate. */
export interface VisibilityColumns {
  visibility: AnySQLiteColumn
  teamId: AnySQLiteColumn
  userId: AnySQLiteColumn
}

/**
 * DATA-partition gate. `'*'` → `undefined` (no restriction; the principal sees every
 * tenant scope). A restricted grant → `scope IN (...granted)`. Returning `undefined`
 * lets callers fold it into `and(...)`, which drops undefined clauses.
 */
export const scopePredicate = (p: Principal, scopeColumn: AnySQLiteColumn): SQL | undefined =>
  p.allowedScopes === "*" ? undefined : inArray(scopeColumn, [...p.allowedScopes])

/**
 * Intra-tenant RLS gate (invariant 8). Un-omittable on every default read of a
 * visibility-bearing row. With no teams, the `team` arm collapses to a constant-false
 * (`inArray(col, [])` is an invalid/empty predicate, so we drop the arm entirely).
 */
export const visibilityPredicate = (p: Principal, t: VisibilityColumns): SQL => {
  const parts: SQL[] = [eq(t.visibility, "world")]

  if (p.teamIds.length > 0) {
    const teamClause = and(eq(t.visibility, "team"), inArray(t.teamId, [...p.teamIds]))
    if (teamClause) parts.push(teamClause)
  }

  const privateClause = and(eq(t.visibility, "private"), eq(t.userId, p.userId))
  if (privateClause) parts.push(privateClause)

  return or(...parts) ?? sql`1 = 0`
}

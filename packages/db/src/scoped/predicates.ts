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
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm"
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

/**
 * The single "LIVE entity" gate (Dream-dedup D4): an `entities` row that has NOT been soft-deleted
 * into a winner (`merged_into IS NULL`). ONE definition every entity read shares, so a merged loser
 * is uniformly hidden from search/list/traverse/orphans/stats/reflection while its row survives
 * (D-i5 reversible). `liveEntityPredicate` is the Drizzle form (pass the `merged_into` column, works
 * on aliased tables too); `liveEntitySql` is the raw-SQL twin for hand-written joins (`entity_fts`).
 * Deliberately NOT applied by `findEntityByKey` / `getEntityForMerge`, which must SEE losers (to
 * redirect a re-extracted key to its winner, and to drive the merge).
 */
export const liveEntityPredicate = (mergedIntoColumn: AnySQLiteColumn): SQL =>
  isNull(mergedIntoColumn)

/** Raw-SQL twin of `liveEntityPredicate` for hand-written joins: `<alias>.merged_into IS NULL`. */
export const liveEntitySql = (alias: string): SQL => sql`${sql.raw(alias)}.merged_into IS NULL`

/** The two lineage columns an "active fact" gate reads (`superseded_by` / `consolidated_into`). */
export interface FactLineageColumns {
  supersededBy: AnySQLiteColumn
  consolidatedInto: AnySQLiteColumn
}

/**
 * The single definition of an ACTIVE fact w.r.t. the Dream engine (v2 W1/D1): one that has not
 * been superseded or consolidated. Returns `undefined` when `includeSuperseded` is set (so the
 * caller can fold it into `and(...)`, which drops undefined clauses) — that reveals lineage.
 * Used by `SessionStore` recall AND the dream candidate select so "active" has one home.
 */
export const activeFactPredicate = (
  cols: FactLineageColumns,
  includeSuperseded?: boolean,
): SQL | undefined =>
  includeSuperseded ? undefined : and(isNull(cols.supersededBy), isNull(cols.consolidatedInto))

/** The `documents.origin` marker for Dream-generated insight documents (D2 anti-loop D-i2). */
export const DOC_ORIGIN_DREAM = "dream" as const

/**
 * Anti-loop gate (D-i2, depth ≤ 1): a document that is NOT Dream-generated (`origin` null or not
 * `'dream'`). The single definition for the reflection target queries — an insight is never a
 * reflection target. Use `notDreamOriginSql` for the raw-SQL entity arm (same semantics).
 */
export const notDreamOrigin = (originColumn: AnySQLiteColumn): SQL =>
  sql`(${originColumn} IS NULL OR ${originColumn} <> ${DOC_ORIGIN_DREAM})`

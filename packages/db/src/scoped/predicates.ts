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
import { and, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm"
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
 * into a winner (`merged_into IS NULL`) nor soft-deleted by `delete_entity` (`deleted_at IS NULL`).
 * ONE definition every entity read shares, so a merged loser / deleted entity is uniformly hidden
 * from search/list/traverse/orphans/stats/reflection while its row survives (D-i5 reversible).
 * `liveEntityPredicate` is the Drizzle form (pass the table or alias's two columns); `liveEntitySql`
 * is the raw-SQL twin for hand-written joins (`entity_fts`).
 * Deliberately NOT applied by `findEntityByKey` / `getEntityForMerge`, which must SEE losers (to
 * redirect a re-extracted key to its winner, and to drive the merge).
 */
export const liveEntityPredicate = (cols: {
  mergedInto: AnySQLiteColumn
  deletedAt: AnySQLiteColumn
}): SQL => sql`${isNull(cols.mergedInto)} AND ${isNull(cols.deletedAt)}`

/** Raw-SQL twin of `liveEntityPredicate`: `<alias>.merged_into IS NULL AND <alias>.deleted_at IS NULL`. */
export const liveEntitySql = (alias: string): SQL =>
  sql`${sql.raw(alias)}.merged_into IS NULL AND ${sql.raw(alias)}.deleted_at IS NULL`

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

/**
 * SOFT-EXPIRY gate (Dream hygiene D5). A fact whose confidence decays below the floor gets
 * `valid_until` set — a REVERSIBLE soft-expire (clear the column to revive), DISTINCT from the
 * `expired_at` hard-forget. The PRD reserved `valid_until` for exactly this ("active = valid_until
 * null/future"); until D5 nothing read or wrote it, so wiring this alongside every `expired_at IS
 * NULL` read is a no-op on existing data. Soft-expired facts stay hidden UNCONDITIONALLY — this is a
 * SEPARATE lineage axis from supersede/consolidate: deliberately NOT coupled to `includeSuperseded`.
 * `reveal` (a SESSION-SCOPED recall — lineage, not loss, since session-context emits no traces — OR
 * the explicit `includeSoftExpired` flag) returns `undefined` so those paths surface a decayed fact.
 * Pass a single `nowIso` per query so a read is internally consistent. `notSoftExpiredSql` is the
 * raw-SQL twin for the hand-written `facts_fts` re-check.
 */
export const notSoftExpired = (
  validUntilColumn: AnySQLiteColumn,
  nowIso: string,
  reveal?: boolean,
): SQL | undefined =>
  reveal ? undefined : or(isNull(validUntilColumn), gt(validUntilColumn, nowIso))

/** Raw-SQL twin of `notSoftExpired` (no reveal — the caller gates it): `(<alias>.valid_until IS NULL OR <alias>.valid_until > now)`. */
export const notSoftExpiredSql = (alias: string, nowIso: string): SQL =>
  sql`(${sql.raw(alias)}.valid_until IS NULL OR ${sql.raw(alias)}.valid_until > ${nowIso})`

/** The `documents.origin` marker for Dream-generated insight documents (D2 anti-loop D-i2). */
export const DOC_ORIGIN_DREAM = "dream" as const
/** The `documents.origin` marker for an AGENT-authored page's backing document (v3/W3, W-i4). */
export const DOC_ORIGIN_WIKI_AGENT = "wiki-agent" as const
/** Every AGENT-authored `documents.origin` — excluded from reflection candidate SELECTs (anti-loop). */
export const AGENT_DOC_ORIGINS = [DOC_ORIGIN_DREAM, DOC_ORIGIN_WIKI_AGENT] as const

/**
 * Anti-loop gate (D-i2, depth ≤ 1): a document that is NOT Dream-generated (`origin` null or not
 * `'dream'`). The single definition for the reflection target queries — an insight is never a
 * reflection target. Use `notDreamOriginSql` for the raw-SQL entity arm (same semantics).
 */
export const notDreamOrigin = (originColumn: AnySQLiteColumn): SQL =>
  sql`(${originColumn} IS NULL OR ${originColumn} <> ${DOC_ORIGIN_DREAM})`

/**
 * Anti-loop gate (W-i4), generalizing `notDreamOrigin` to the whole AGENT origin set (`dream` +
 * `wiki-agent`): a document that is NOT agent-authored. Used by the reflection candidate SELECTs so
 * an entity/insight page's backing document never becomes a reflection target — exactly as an
 * `origin='dream'` insight never does. Human wiki backing docs (origin NULL) still feed the graph.
 */
export const notAgentOrigin = (originColumn: AnySQLiteColumn): SQL =>
  sql`(${originColumn} IS NULL OR ${originColumn} NOT IN (${sql.join(
    AGENT_DOC_ORIGINS.map((o) => sql`${o}`),
    sql`, `,
  )}))`

/** The `pages.ingested_via` provenance values EXCLUDED from reflection (W2/W5 anti-loop, W-i4).
 *  `index` (W5): auto-maintained navigation pages. `import` (W5/2b): UNTRUSTED foreign content —
 *  imported bundle pages must NEVER feed the dream engine (anti-poisoning). */
export const AGENT_PAGE_PROVENANCE = ["entity", "insight", "index", "import"] as const

/**
 * Anti-loop gate (W-i4): a page whose provenance is NOT agent-authored (`entity`/`insight`), or the
 * NULL join (a non-page-sourced mention). Provenance — not per-revision authorship — is the stable
 * discriminator: a dream-maintained entity/insight page is treated exactly like an `origin='dream'`
 * document, so it never feeds reflection; human `wiki`/`memory` pages remain legitimate input.
 */
export const notAgentAuthoredPage = (ingestedViaColumn: AnySQLiteColumn): SQL =>
  sql`(${ingestedViaColumn} IS NULL OR ${ingestedViaColumn} NOT IN (${sql.join(
    AGENT_PAGE_PROVENANCE.map((v) => sql`${v}`),
    sql`, `,
  )}))`

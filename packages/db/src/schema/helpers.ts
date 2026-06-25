import { type SQL, sql } from "drizzle-orm"

/**
 * Shared column conventions (PRD §3.0).
 *
 * - Timestamps are ISO-8601 `TEXT`, default `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
 *   (the gbrain convention) — EXCEPT the append-only audit tables
 *   (`memory_audit`/`memory_recall_traces`), which use epoch-ms `INTEGER at` with
 *   NO default (the openbrains convention, §3.0/§7.6).
 * - Base-table ids are stable nanoid `TEXT` — except `facts.id`, the one
 *   `INTEGER PRIMARY KEY AUTOINCREMENT` (§3.0).
 */
export const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/**
 * Build a faithful `col IN ('a','b',...)` CHECK expression from an enum tuple.
 * Used so the DDL's CHECK lists cannot drift from the canonical `@brain/shared`
 * enums (visibility / trust_grade / entity-visibility) — and for the table-local
 * enums that have no shared counterpart (client/status/kind/...).
 */
export const enumCheck = (column: string, values: readonly string[]): SQL =>
  sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(", ")})`)

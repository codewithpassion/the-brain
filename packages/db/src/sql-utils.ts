/**
 * LIKE-free SQL prefix predicates.
 *
 * WHY this exists: Cloudflare D1 hard-caps the LIKE/GLOB pattern length at 50 BYTES (past that,
 * `SQLITE_ERROR: LIKE or GLOB pattern too complex`). Plain SQLite defaults to 50,000, so a
 * `col LIKE ${prefix} || '/%'` prefix match works in local tests (miniflare, bun:sqlite) yet
 * throws in prod for any prefix ≳50 bytes (e.g. a long wiki slug). The `substr`/`length` form
 * carries no pattern and so has no length cap. Bonus: no LIKE wildcard-escaping to worry about —
 * `_`/`%` in the prefix are compared literally.
 */
import { type SQL, sql } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"

/**
 * `col` starts with the literal `prefix` (LIKE-free; see file header for the D1 50-byte cap).
 * `prefix` is bound TWICE and its length computed in SQL (`length(${prefix})`) so the compared
 * length matches SQLite's own char count — sidesteps a JS-vs-SQLite unicode length mismatch.
 */
export const sqlStartsWith = (col: AnySQLiteColumn, prefix: string): SQL =>
  sql`substr(${col}, 1, length(${prefix})) = ${prefix}`

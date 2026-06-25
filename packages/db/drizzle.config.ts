import { defineConfig } from "drizzle-kit"

/**
 * drizzle-kit config for `@brain/db` (Phase 1b).
 *
 * `generate`-only: emits the base-table migration SQL from the Drizzle schema.
 * The D1 `dialect` is `sqlite` — we do NOT wire the d1-http driver here; applying
 * migrations to a real D1 (the `push`/`migrate` path) is Phase 1e, not this phase.
 * The FTS5 virtual tables + their sync triggers, and the expression/partial indexes
 * Drizzle cannot model, are hand-written raw SQL appended in `drizzle/` (see
 * `0001_fts5_and_expression_indexes.sql`).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
})

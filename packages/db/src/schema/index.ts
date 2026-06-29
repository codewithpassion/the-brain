/**
 * `@brain/db` schema barrel — the frozen v1 D1 schema (Drizzle sqlite-core).
 *
 * Mirrors the PRD §3.1 catalog subsection-by-subsection. FTS5 virtual tables
 * (`chunks_fts`/`entity_fts`/`facts_fts`) and the expression indexes Drizzle cannot
 * model live in the raw migration SQL (`drizzle/`), not here.
 */
export * from "./content"
export * from "./docgraph"
export * from "./governance"
export * from "./kg"
export * from "./ops"
export * from "./sessions"
export * from "./tenancy"
export * from "./vault"

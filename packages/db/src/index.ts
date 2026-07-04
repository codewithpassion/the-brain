/**
 * `@brain/db` — Phase 1b/1c: the FROZEN D1 schema + the isolation chokepoints.
 *
 * This package is the ONLY module allowed to import raw `env.DB`/Vectorize/R2/AI
 * bindings (invariant 2). It exports the Drizzle schema PLUS the `Scoped*` chokepoints,
 * the `embed()/gen()/rerank()` AI wrappers, the binding ENV interface, and the
 * `createScopedServices` factory. Consumers below the edge receive ONLY the scoped
 * bundle — never a raw binding.
 */

// ── Admin ops (mint_api_key / get_token_spend / memberships) (Phase 6) ────────
export * from "./admin"
// ── Isolation chokepoints + AI wrappers + factory (Phase 1c) ──────────────────
export * from "./ai"
// ── Edge auth spine (Phase 1d) ────────────────────────────────────────────────
export * from "./auth"
// ── Backfill spine + re-embed migration (Phase 3) ─────────────────────────────
export * from "./backfill"
// ── Dream engine core — fact consolidation (v2 W1/D1) ─────────────────────────
export * from "./dream"
export type { BrainBindings } from "./env"
// ── Sessions + hot memory + governance (Phase 5) ──────────────────────────────
export * from "./governance"
// ── Graph extraction + traversal + entity search (Phase 4) ─────────────────────
export * from "./graph"
// ── Ingest pipeline core (shared between API and MCP surface) ─────────────────
export * from "./ingest"
// ── OKF-compatible agent memory (path-keyed, versioned; on the pages layer) ───
export * from "./memory"
// ── Notion connection store + ops (notion-integration-plan.md) ────────────────
export * from "./notion"
// ── Shared page-CRUD core (memory + wiki drive it) (v3/W1) ────────────────────
export * from "./pages"
export * as schema from "./schema"
export * from "./schema"
export * from "./scoped"
// ── Hybrid-search + cited-synthesis (`think`) pipeline (Phase 2) ───────────────
export * from "./search"
export type { ScopedServices, ScopedServicesOptions } from "./services"
export { createScopedServices } from "./services"
export * from "./sessions"
// ── Vault WebDAV credential store + ops (r2-facade-plan.md) ──────────────────
export * from "./vault"
// ── First-class wiki pages on the pages layer (v3/W1) ─────────────────────────
export * from "./wiki"

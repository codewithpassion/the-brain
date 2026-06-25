/**
 * `@brain/db` — Phase 1b/1c: the FROZEN D1 schema + the isolation chokepoints.
 *
 * This package is the ONLY module allowed to import raw `env.DB`/Vectorize/R2/AI
 * bindings (invariant 2). It exports the Drizzle schema PLUS the `Scoped*` chokepoints,
 * the `embed()/gen()/rerank()` AI wrappers, the binding ENV interface, and the
 * `createScopedServices` factory. Consumers below the edge receive ONLY the scoped
 * bundle — never a raw binding.
 */

// ── Isolation chokepoints + AI wrappers + factory (Phase 1c) ──────────────────
export * from "./ai"
// ── Edge auth spine (Phase 1d) ────────────────────────────────────────────────
export * from "./auth"
// ── Backfill spine + re-embed migration (Phase 3) ─────────────────────────────
export * from "./backfill"
export type { BrainBindings } from "./env"
// ── Sessions + hot memory + governance (Phase 5) ──────────────────────────────
export * from "./governance"
// ── Graph extraction + traversal + entity search (Phase 4) ─────────────────────
export * from "./graph"
export * as schema from "./schema"
export * from "./schema"
export * from "./scoped"
// ── Hybrid-search + cited-synthesis (`think`) pipeline (Phase 2) ───────────────
export * from "./search"
export type { ScopedServices, ScopedServicesOptions } from "./services"
export { createScopedServices } from "./services"
export * from "./sessions"

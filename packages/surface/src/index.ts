/**
 * `@brain/surface` — the surface-generation CORE (PRD §9.0.2, "one op-registry → three
 * consumers"). It turns the single Zod op-registry into the three client-facing surfaces so they
 * CANNOT drift:
 *
 *   - `buildMcpTools(principal)`      → MCP tool defs (JSON-schema input, read/write filtered)
 *   - `buildTrpcRouter()` / `appRouter` + `type AppRouter` → the typed tRPC surface
 *   - `buildCliCommandSpecs()`        → declarative CLI command specs (no Commander dep here)
 *
 * All three project from `buildCatalog()` (the uniform `SurfaceOp[]`), itself derived from
 * `buildRegistry()` (every op family). The drift test asserts each generated surface covers
 * exactly its `registry.bySurface(...)` slice.
 *
 * ── Placement / import paths (for the CLI + dashboard agents) ─────────────────────────────────
 *   - This is a standalone library package (`packages/surface`), depending on `@brain/shared`
 *     (pure contract) + `@brain/db` (handlers + scoped services). `apps/cli` and `apps/dashboard`
 *     import `type { AppRouter } from "@brain/surface"` — a TYPE-ONLY import, so the `@brain/db`
 *     runtime is erased and the worker app is NOT a dependency (no `apps/cli → apps/api` edge).
 *   - `apps/api` imports `{ appRouter, createTrpcContext }` to MOUNT the router under
 *     `resolvePrincipal` (it owns the binding env + executionCtx.waitUntil).
 *
 * ── Surface-flag mapping (DOCUMENTED) ─────────────────────────────────────────────────────────
 *   `OP_SURFACES` is `["mcp", "rest", "cli"]` — there is no separate "trpc" flag. tRPC is THE
 *   typed API surface (Hono-vs-tRPC is an impl detail within "rest"), so **tRPC procedures ←
 *   ops whose `surfaces` include `"rest"`**. In the current registry `"rest" ⊇ "cli"`, so every
 *   CLI command has a tRPC procedure to call; the drift test enforces `cli ⟹ rest`.
 *
 * ── Read/write tool-filtering rule ────────────────────────────────────────────────────────────
 *   MCP: a tool is registered for a principal iff `scopeSatisfied(op.capability, principal)` —
 *   `read` ops always (everyone holds `read`), `write`/`admin` ops only when the principal holds
 *   the capability and is not read-only. tRPC: mutations sit behind `writeProcedure` (denies
 *   read-only) AND every resolver re-checks `scopeSatisfied(op.capability, …)` (the capability
 *   axis, independent of the read/write axis).
 */
export { buildCatalog, type SurfaceOp } from "./catalog"
export { buildCliCommandSpecs, type CliArgSpec, type CliCommandSpec } from "./cli"
export type { SurfaceContext, SurfaceEnv, WorkflowLike } from "./context"
export {
  createCallerFactory,
  createTrpcContext,
  protectedProcedure,
  router,
  writeProcedure,
} from "./context"
export { buildMcpTools, type McpToolDef } from "./mcp"
export { buildRegistry } from "./registry"
export { type AppRouter, appRouter, buildTrpcRouter } from "./trpc"

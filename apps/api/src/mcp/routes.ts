/**
 * Mount the two MCP transports on the Hono app (PRD §9.2), each resolving its Principal at the
 * EDGE (invariant 17 — `resolvePrincipal` runs here; only the resolved Principal travels below as
 * `ctx.props`, never a raw token):
 *
 *   - `ALL /mcp/:slug` — the DO-backed STATEFUL transport. The `:slug` is the active-tenant
 *     selector (`resolvePrincipal({ activeTenantSlug: slug })`); the resolved Principal is injected
 *     as `ctx.props`, and `BrainMCP.serve` routes to a per-session Durable Object. The DO is keyed
 *     per MCP session (`streamable-http:${sessionId}`), so each connection's props stay isolated —
 *     the DO is the protocol instance only; isolation rests on the per-call D1 re-check.
 *   - `ALL /mcp` — the STATELESS Streamable-HTTP fallback (gbrain's `handleMcp`): no DO, a fresh
 *     Principal-scoped `Server` per request via `createMcpHandler`. The active tenant comes from
 *     the same pinned mechanisms `resolvePrincipal` already honors (machine-token claim, or the
 *     validated `X-Brain-Tenant` header for a Clerk JWT).
 *
 * `readOnly` is stamped by `resolvePrincipal` (role / API-key / MCP-key) and threaded straight
 * through; the catalog filters write/admin tools out for a read-only Principal (PRD §9.2.3).
 */
import { type ClerkVerifier, resolvePrincipal } from "@brain/db"
import type { Principal } from "@brain/shared"
import type { SurfaceEnv } from "@brain/surface"
import { createMcpHandler } from "agents/mcp"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"
import { BrainMCP } from "./agent"
import { buildMcpServer } from "./server"

type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

/** Options the mount needs from `createApp` (the test-injected Clerk verifier). */
export interface MountMcpOptions {
  clerkVerifier?: ClerkVerifier
}

/** True for the MCP transport paths, which OWN their (slug-aware) edge auth (skip the global one). */
export const isMcpPath = (path: string): boolean => path === "/mcp" || path.startsWith("/mcp/")

/** The MCP SDK handlers expect the workers-types `ExecutionContext` (Hono's omits `tracing`). */
type McpExecutionContext = Parameters<ReturnType<typeof createMcpHandler>>[2]

/** Set the resolved Principal as the execution-context props the MCP handlers read. */
const setProps = (executionCtx: McpExecutionContext, principal: Principal): void => {
  ;(executionCtx as unknown as { props?: Record<string, unknown> }).props = { principal }
}

export const mountMcp = (app: Hono<AppEnv>, options: MountMcpOptions = {}): void => {
  const verifier = options.clerkVerifier
  const resolveOpts = (extra: { activeTenantSlug?: string }) => ({
    ...(verifier ? { clerkVerifier: verifier } : {}),
    ...extra,
  })

  // ── /mcp/:slug — DO-backed stateful transport; `:slug` selects the active tenant. ──
  const slugHandler = BrainMCP.serve("/mcp/:slug", { binding: "BRAIN_MCP" })
  app.all("/mcp/:slug", async (c) => {
    const slug = c.req.param("slug")
    const ec = c.executionCtx as unknown as McpExecutionContext
    // Throws AuthError (→ 401 via app.onError) on a credential-less / wrong-tenant request.
    const principal = await resolvePrincipal(
      c.env,
      c.req.raw,
      resolveOpts({ activeTenantSlug: slug }),
    )
    setProps(ec, principal)
    return slugHandler.fetch(c.req.raw, c.env, ec)
  })

  // ── /mcp — stateless Streamable-HTTP fallback; fresh Principal-scoped server per request. ──
  //    `enableJsonResponse: true` makes this the NON-SSE JSON fallback the PRD calls for (a plain
  //    request→response for clients that don't do SSE) — without it `createMcpHandler` defaults to
  //    SSE streaming. Stateless: no `sessionIdGenerator`, so each request stands alone.
  app.all("/mcp", async (c) => {
    const ec = c.executionCtx as unknown as McpExecutionContext
    const principal = await resolvePrincipal(c.env, c.req.raw, resolveOpts({}))
    setProps(ec, principal)
    const server = buildMcpServer(principal, {
      env: c.env as unknown as SurfaceEnv,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    })
    const handler = createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })
    return handler(c.req.raw, c.env, ec)
  })
}

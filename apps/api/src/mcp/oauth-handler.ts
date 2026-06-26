/**
 * MCP handler for the `@cloudflare/workers-oauth-provider` `apiHandlers` map.
 *
 * When the OAuthProvider validates an access token on a `/mcp` request, it calls
 * `mcpApiHandler.fetch(request, env, ctx)` with `ctx.props` containing the grant's stored
 * payload — specifically `{ principal: Principal }` set by `/callback`'s
 * `completeAuthorization`. We read the principal from there and route to the appropriate
 * MCP transport:
 *
 *   /mcp/:slug  — DO-backed stateful transport (BrainMCP.serve). The slug is the active-tenant
 *                 selector and was already resolved during authorization; the props carry the
 *                 resolved Principal, so we don't re-call resolvePrincipal here.
 *   /mcp        — Stateless Streamable-HTTP fallback (createMcpHandler). Same Principal source.
 *
 * The DO-backed path simply forwards to BrainMCP.serve with the same ctx. McpAgent reads
 * `this.props = ctx.props` in `onStart`, which contains `{ principal }` — identical to what
 * the Hono `mountMcp` path sets via `setProps`.
 *
 * The bearer path (`resolvePrincipal` for Clerk JWT / bk_ / bdev_ tokens) is handled BEFORE
 * this handler is called, via the OAuthProvider's `resolveExternalToken` callback in
 * `createOAuthWorker` — so by the time we reach here, `ctx.props.principal` is always set.
 */
import type { Principal } from "@brain/shared"
import type { SurfaceEnv } from "@brain/surface"
import { createMcpHandler } from "agents/mcp"
import type { ApiBindings } from "../bindings"
import { BrainMCP, type BrainMcpProps } from "./agent"
import { buildMcpServer } from "./server"

/** The handler object passed to `OAuthProvider`'s `apiHandlers: { "/mcp": mcpApiHandler }`. */
export const mcpApiHandler: {
  fetch: (request: Request, env: ApiBindings, ctx: ExecutionContext) => Promise<Response>
} = {
  async fetch(request: Request, env: ApiBindings, ctx: ExecutionContext): Promise<Response> {
    // Props are set by OAuthProvider before calling this handler (from the stored grant props,
    // or from resolveExternalToken for legacy bearer tokens).
    const props = (ctx as ExecutionContext & { props?: BrainMcpProps }).props
    const principal = props?.principal as Principal | undefined

    if (!principal) {
      // Defensive: the OAuthProvider should always set props before reaching here.
      return Response.json({ error: "no principal in token props" }, { status: 401 })
    }

    const url = new URL(request.url)
    // Match /mcp/:slug  (exactly one non-empty path segment after /mcp/)
    const slugMatch = url.pathname.match(/^\/mcp\/([^/]+)\/?$/)

    if (slugMatch?.[1]) {
      // DO-backed stateful transport: forward with the same ctx (which has props.principal).
      // BrainMCP.serve reads this.props = ctx.props in onStart — no setProps call needed.
      const slugHandler = BrainMCP.serve("/mcp/:slug", { binding: "BRAIN_MCP" })
      return slugHandler.fetch(request, env, ctx)
    }

    // Stateless Streamable-HTTP fallback: build a fresh Principal-scoped server per request.
    const waitUntil = (p: Promise<unknown>): void => ctx.waitUntil(p)
    const server = buildMcpServer(principal, {
      env: env as unknown as SurfaceEnv,
      waitUntil,
    })
    const handler = createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })
    return handler(request, env, ctx)
  },
}

/**
 * `BrainMCP` — the agent-facing MCP surface (PRD §9.2): a `McpAgent` Durable Object that is
 * ONLY the protocol instance, never the system of record (invariant 2/3). It exposes the single
 * Zod op-registry as MCP tools at `/mcp/:slug` (stateful/SSE) — the stateless Streamable-HTTP
 * `/mcp` fallback is served by `createMcpHandler` in `./routes` over the SAME server builder.
 *
 * MINIMAL-BOOT scope (this commit): one trivial `ping` tool, registered through the MCP SDK's
 * LOW-LEVEL `Server` (not the high-level `McpServer`) so the catalog can later be projected from
 * our registry's JSON Schema with no zod-shape coupling (the repo pins zod 3; `agents@0.7.0` +
 * `@modelcontextprotocol/sdk@1.26.0` both accept `zod ^3.25`). The full catalog + Principal-scoped
 * tool filtering + `createScopedServices` dispatch land next, replacing this server builder.
 *
 * The resolved `Principal` is injected as `props` at the edge (invariant 17 — `resolvePrincipal`
 * runs in the Hono mount, never inside the DO; no bare token travels below the edge). `onStart`
 * populates `this.props` BEFORE `init()` (verified against the installed `agents` source), so a
 * later catalog can register Principal-filtered tools from `this.props`.
 */
import type { Principal } from "@brain/shared"
import type { SurfaceEnv } from "@brain/surface"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpAgent } from "agents/mcp"
import { buildErrorServer, buildMcpServer } from "./server"

/** Build the low-level MCP `Server` exposing ONLY the `ping` tool (the minimal-boot SDK smoke). */
export const buildPingServer = (): Server => {
  const server = new Server(
    { name: "the-brain", version: "0.0.0" },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping",
        description: "Liveness probe — returns `pong`.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "ping") {
      return { content: [{ type: "text", text: "pong" }] }
    }
    return {
      content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
      isError: true,
    }
  })
  return server
}

/** The per-session protocol props injected at the edge (invariant 17): the resolved Principal. */
export interface BrainMcpProps extends Record<string, unknown> {
  principal: Principal
}

/**
 * The MCP Durable Object (PRD §9.2): one DO per protocol session, so each connection's `props`
 * (its resolved Principal) stay ISOLATED — never shared/overwritten across tenants. The DO is the
 * protocol instance only; isolation rests on the per-call D1 re-check inside the catalog dispatch,
 * not on the DO (invariant 3).
 */
export class BrainMCP extends McpAgent<Cloudflare.Env, unknown, BrainMcpProps> {
  // Placeholder reassigned in `init()` once `props` are loaded — `onStart` runs `init()` BEFORE it
  // reads `this.server` (verified against the installed `agents` source), so the per-Principal
  // catalog server is the one actually connected to the transport.
  server: Server = new Server(
    { name: "the-brain", version: "0.0.0" },
    { capabilities: { tools: {} } },
  )

  async init(): Promise<void> {
    const principal = this.props?.principal
    if (!principal) {
      this.server = buildErrorServer("no resolved principal in session props")
      return
    }
    // `this.ctx.waitUntil` keeps off-read-path writes (recall traces, invariant 10) alive while
    // the DO is processing; fall back to a guarded fire-and-forget if the runtime omits it.
    const ctx = this.ctx as unknown as { waitUntil?: (p: Promise<unknown>) => void }
    const waitUntil = (p: Promise<unknown>): void => {
      if (ctx.waitUntil) ctx.waitUntil(p)
      else void p.catch(() => {})
    }
    this.server = buildMcpServer(principal, {
      env: this.env as unknown as SurfaceEnv,
      waitUntil,
    })
  }
}

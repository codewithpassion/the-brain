/**
 * Build the low-level MCP `Server` that exposes the op-registry catalog for one resolved
 * `Principal` (PRD §9.2). The SAME builder backs BOTH transports: the stateful `BrainMCP` DO
 * (`/mcp/:slug`) and the stateless `createMcpHandler` (`/mcp`). Using the SDK's low-level
 * `Server` (not the high-level `McpServer`) lets `tools/list` emit our registry's JSON Schema
 * verbatim — no zod-shape coupling (the repo pins zod 3).
 *
 * `tools/call` results are wrapped in MCP `content` blocks; a structured failure uses gbrain's
 * `{error, message}` envelope with `isError: true` (PRD §9 error contract). All tenant access is
 * inside the catalog invoker (`createScopedServices` → D1 re-check); this module names no binding.
 */
import type { Principal } from "@brain/shared"
import type { SurfaceEnv } from "@brain/surface"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { callMcpTool, mcpToolsFor } from "./dispatch"

/** What the catalog server needs beyond the Principal: the binding env + an off-path `waitUntil`. */
export interface McpServerDeps {
  env: SurfaceEnv
  waitUntil: (promise: Promise<unknown>) => void
}

const SERVER_INFO = { name: "the-brain", version: "0.0.0" } as const
const TOOLS_CAPABILITY = { capabilities: { tools: {} } } as const

/** Serialize a tool result into a single MCP text-content block. */
const textBlock = (value: unknown): { type: "text"; text: string } => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value),
})

/** Build the catalog `Server` for `principal` (tools filtered + dispatched per PRD §9.2). */
export const buildMcpServer = (principal: Principal, deps: McpServerDeps): Server => {
  const server = new Server(SERVER_INFO, TOOLS_CAPABILITY)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpToolsFor(principal),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await callMcpTool(
      principal,
      deps.env,
      deps.waitUntil,
      request.params.name,
      request.params.arguments,
    )
    if (outcome.ok) return { content: [textBlock(outcome.output)] }
    return { content: [textBlock(outcome.error)], isError: true }
  })

  return server
}

/**
 * The fallback `Server` for a session that reached the DO without a resolved Principal (PRD
 * §9.2.3 "missing slug/tenant context → a single `error` tool explaining reconnection"). The edge
 * already 401s a credential-less request, so this is defence-in-depth, not a normal path.
 */
export const buildErrorServer = (reason: string): Server => {
  const server = new Server(SERVER_INFO, TOOLS_CAPABILITY)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "error",
        description: `MCP session is not bound to a tenant: ${reason}. Reconnect via /mcp/<slug>.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [textBlock({ error: "no_principal", message: reason })],
    isError: true,
  }))
  return server
}

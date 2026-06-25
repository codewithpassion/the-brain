import { env, runInDurableObject } from "cloudflare:test"
import { createMcpHandler, WorkerTransport } from "agents/mcp"
import { describe, expect, test } from "vitest"
import { type BrainMCP, buildPingServer } from "../src/mcp/agent"

/**
 * MINIMAL-BOOT proof for the MCP surface (PRD §9.2). Two independent checks that the
 * `agents` + `@modelcontextprotocol/sdk` stack bundles AND runs inside real workerd
 * (pool-workers) — the Phase-6 analog of the BATCH_INGEST binding risk:
 *
 *   1. `ping` responds — the LOW-LEVEL `Server` answers `tools/list` + `tools/call` through a
 *      stateless `createMcpHandler` JSON round-trip (no DO; the `/mcp` Streamable-HTTP path).
 *   2. the `BrainMCP` Durable Object INSTANTIATES — addressed by binding + id, its RPC transport
 *      lazily initialises, and it answers `tools/list` from inside the live DO (here the defensive
 *      no-principal `error` server, since the edge supplies props on the real `serve` route).
 *
 * The catalog-through-DO path + cross-tenant isolation are proven by `mcp.canary.test.ts`. The
 * JSON round-trip muscle here is reused there.
 */

const PROTOCOL_VERSION = "2025-06-18"
const initialize = (id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "boot-test", version: "0.0.0" },
  },
})
const toolsList = (id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/list",
  params: {},
})
const callPing = (id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name: "ping", arguments: {} },
})

/** POST a single JSON-RPC message to a stateless handler and parse its JSON response. */
const post = async (
  handler: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>,
  body: unknown,
): Promise<Record<string, unknown>> => {
  const res = await handler(
    new Request("https://brain.local/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  )
  return (await res.json()) as Record<string, unknown>
}

describe("MCP minimal boot — agents + MCP SDK in real workerd (pool-workers)", () => {
  test("ping responds over a stateless createMcpHandler JSON round-trip", async () => {
    // One reused transport+server so the `initialize` handshake state carries across requests.
    const transport = new WorkerTransport({ enableJsonResponse: true })
    const handler = createMcpHandler(buildPingServer(), { route: "/mcp", transport })

    const init = await post(handler, initialize(1))
    expect((init.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("the-brain")

    const list = await post(handler, toolsList(2))
    const tools = (list.result as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toContain("ping")

    const called = await post(handler, callPing(3))
    const content = (called.result as { content: { type: string; text: string }[] }).content
    expect(content[0]?.text).toBe("pong")
  })

  test("BrainMCP Durable Object instantiates and serves over the RPC transport in workerd", async () => {
    const ns = (env as unknown as { BRAIN_MCP: DurableObjectNamespace }).BRAIN_MCP
    const stub = ns.get(ns.idFromName("boot:do"))
    // `handleMcpMessage` is the RPC transport; `getTransportType()` reads the agent name's
    // `rpc:`/`sse:` prefix. Addressing a DO directly (idFromName, not routeAgentRequest) leaves
    // `name` unset (workerd#2240) — set it explicitly so the RPC transport is selected.
    await (stub as unknown as { setName(n: string): Promise<void> }).setName("rpc:boot")

    // No props are injected here (the edge would supply them), so the DO builds the defensive
    // no-principal `error` server (PRD §9.2.3) — a deterministic, seed-free proof that the DO
    // constructs, runs `init()`, connects its transport, and answers `tools/list` inside workerd.
    // The catalog-through-DO path + cross-tenant isolation are proven by the canary's real
    // `serve` route (where props are supplied at agent creation). `ping` responds in the
    // stateless test above.
    await runInDurableObject(stub as unknown as DurableObjectStub<BrainMCP>, async (instance) => {
      const init = (await instance.handleMcpMessage(initialize(1))) as unknown as {
        result?: unknown
      }
      expect(init.result).toBeDefined()

      const list = (await instance.handleMcpMessage(toolsList(2))) as unknown as {
        result: { tools: { name: string }[] }
      }
      expect(list.result.tools.map((t) => t.name)).toEqual(["error"])
    })
  })
})

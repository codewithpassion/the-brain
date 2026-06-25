import { env } from "cloudflare:test"
import type { ClerkIdentity, ClerkVerifier } from "@brain/db"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src/index"
import { seedMembership, seedOrg } from "./seed"

/** A captured-waitUntil ExecutionContext with mutable `props` (the MCP handlers set props here). */
const makeCtx = (): ExecutionContext =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext

/** Drive a route through the worker `fetch` contract: real `env` + an executionCtx (Hono needs both). */
const req = (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit,
): Promise<Response> =>
  (
    app.request as (p: string, i: RequestInit, e: unknown, c: ExecutionContext) => Promise<Response>
  )(path, init, env, makeCtx())

/**
 * MCP transport routes — the PRODUCTION edge (PRD §9.2): `mountMcp` over `resolvePrincipal`, the
 * NON-SSE stateless `/mcp` fallback, and the slug→tenant selector on `/mcp/:slug`. These exercise
 * what the dispatch-level canary cannot: the real Hono route, the `isMcpPath` edge-auth exemption,
 * `AuthError → 401`, the slug→tenant resolution, AND the stateless contract that a FRESH
 * Principal-scoped `Server` (built per request) answers `tools/call` even though the client's
 * `initialize` hit a different instance.
 */

const USER = "routes-user"
const TENANT = "routesT"
const SLUG = "routes-t"
const fakeVerifier = (identity: ClerkIdentity): ClerkVerifier => ({ verify: async () => identity })

const app = () => createApp({ clerkVerifier: fakeVerifier({ userId: USER }) })

const AUTH = {
  Authorization: "Bearer clerk.fake.jwt",
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
}

const jsonRpc = {
  initialize: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "routes-test", version: "0.0.0" },
    },
  },
  recall: {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "recall", arguments: { query: "anything", limit: 10 } },
  },
}

beforeAll(async () => {
  await seedOrg(TENANT, SLUG)
  await seedMembership({ tenantId: TENANT, userId: USER })
})

describe("MCP transport routes (PRD §9.2) — production edge in workerd", () => {
  test("stateless /mcp is the NON-SSE JSON fallback: a fresh-server tools/call answers", async () => {
    const a = app()
    // `initialize` lands on one fresh server …
    const init = await req(a, "/mcp", {
      method: "POST",
      headers: { ...AUTH, "X-Brain-Tenant": SLUG },
      body: JSON.stringify(jsonRpc.initialize),
    })
    expect(init.status).toBe(200)
    expect(init.headers.get("content-type")).toContain("application/json") // NON-SSE
    const initBody = (await init.json()) as { result?: { serverInfo?: { name?: string } } }
    expect(initBody.result?.serverInfo?.name).toBe("the-brain")

    // … and `tools/call` lands on a DIFFERENT fresh server (stateless) yet still answers — proving
    // the per-request server model works without a carried session (a real result, not an
    // "initialize required" error).
    const call = await req(a, "/mcp", {
      method: "POST",
      headers: { ...AUTH, "X-Brain-Tenant": SLUG },
      body: JSON.stringify(jsonRpc.recall),
    })
    expect(call.status).toBe(200)
    const callBody = (await call.json()) as {
      result?: { content: { text: string }[]; isError?: boolean }
      error?: unknown
    }
    expect(callBody.error).toBeUndefined()
    expect(callBody.result?.isError ?? false).toBe(false)
    // The op output (no seeded facts → empty) round-tripped through the MCP content envelope.
    const parsed = JSON.parse(callBody.result?.content[0]?.text ?? "{}") as { facts?: unknown[] }
    expect(Array.isArray(parsed.facts)).toBe(true)
  })

  const noAuth = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }

  test("a credential-less /mcp request is 401 (edge auth fires through the route)", async () => {
    const res = await req(app(), "/mcp", {
      method: "POST",
      headers: noAuth,
      body: JSON.stringify(jsonRpc.initialize),
    })
    expect(res.status).toBe(401)
  })

  test("a credential-less /mcp/:slug request is 401 (mountMcp slug route + auth wiring)", async () => {
    const res = await req(app(), `/mcp/${SLUG}`, {
      method: "POST",
      headers: noAuth,
      body: JSON.stringify(jsonRpc.initialize),
    })
    expect(res.status).toBe(401)
  })

  test("/mcp/:slug feeds the slug to resolvePrincipal: an unknown tenant slug is 401", async () => {
    const res = await req(app(), "/mcp/not-a-real-tenant", {
      method: "POST",
      headers: AUTH, // valid Clerk identity, but the slug names no tenant the user belongs to
      body: JSON.stringify(jsonRpc.initialize),
    })
    expect(res.status).toBe(401)
  })

  test("/mcp/:slug with a valid identity + the user's own slug passes auth (reaches the DO serve)", async () => {
    const res = await req(app(), `/mcp/${SLUG}`, {
      method: "POST",
      headers: AUTH, // the slug IS the active-tenant selector — resolution succeeds, auth passes
      body: JSON.stringify(jsonRpc.initialize),
    })
    // The slug resolved to the user's tenant (not 401); the DO serve path handles the protocol.
    expect(res.status).not.toBe(401)
    // Drain/cancel the (streaming) body so the test doesn't hold the SSE stream open.
    await res.body?.cancel()
  })
})

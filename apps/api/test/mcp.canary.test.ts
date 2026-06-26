import { env, runInDurableObject } from "cloudflare:test"
import type { BrainBindings } from "@brain/db"
import type { Principal } from "@brain/shared"
import type { SurfaceEnv } from "@brain/surface"
import { createMcpHandler, WorkerTransport } from "agents/mcp"
import { beforeAll, describe, expect, test } from "vitest"
import type { BrainMCP } from "../src/mcp/agent"
import { mcpToolsFor } from "../src/mcp/dispatch"
import { buildMcpServer } from "../src/mcp/server"
import { seedChunk, seedDoc, seedMembership, seedOrg } from "./seed"

/**
 * THE Phase-6 MCP cross-tenant isolation canary — the agent-surface analog of the think-canary
 * (invariant 3). It drives a real `tools/call search` THROUGH the MCP server + dispatch
 * (`buildMcpServer` → `callMcpTool` → `buildCatalog().invoke` → `createScopedServices` → the
 * mandatory D1 re-check), against an ADVERSARIAL fake Vectorize that surfaces tenant B's chunk
 * for any query AND an FTS arm whose colliding "needle" term matches BOTH tenants.
 *
 * Properties under test (all non-vacuous — the adversarial arms are shown to actually surface B
 * in B's own tenant FIRST, so "A never sees B" is a real drop, not an empty result):
 *   1. tenant A's `search` returns ONLY tenant-A content — B's unique marker (`bravoonlymarker`)
 *      leaks NOWHERE in the MCP tool result, across the vector + FTS arms.
 *   2. a `write` tool (`capture_turn`) is ABSENT from `tools/list` for a read-only Principal, and
 *      named-directly it is DENIED by the dispatch capability re-check (the §9.2.3 double gate).
 */

const env_ = env as unknown as BrainBindings

const B_MARKER = "bravoonlymarker"
const CHUNK_A = "mcp-chunk-A"
const CHUNK_B = "mcp-chunk-B"

const ownerOf = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const principalA = ownerOf("mcpA", "ownerA")
const principalB = ownerOf("mcpB", "ownerB")
const readonlyA: Principal = {
  tenantId: "mcpA",
  userId: "ro-A",
  teamIds: [],
  role: "readonly",
  allowedScopes: "*",
  capabilities: ["read"],
  readOnly: true,
}

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

/** Adversarial Vectorize: returns BOTH chunk ids (B ranked first) for ANY query. */
const adversarialIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: CHUNK_B, score: 0.95 },
      { id: CHUNK_A, score: 0.91 },
    ],
  }),
} as unknown as Vectorize

/** Fake Workers AI: bge-m3 read-path embed — one 1024-dim row per input text. */
const fakeAi = {
  run: async (_model: string, inputs: Record<string, unknown>) => ({
    data: ((inputs.text as string[] | undefined) ?? [""]).map(() => vec1024()),
  }),
} as unknown as BrainBindings["AI"]

/** The binding env the MCP dispatch sees: real D1/R2/KV + the faked-in Vectorize/AI (no live emu). */
const mcpEnv = {
  ...env_,
  CHUNK_INDEX: adversarialIndex,
  ENTITY_INDEX: adversarialIndex,
  AI: fakeAi,
  AI_GATEWAY_ID: "test-gateway",
} as unknown as SurfaceEnv

const PROTOCOL_VERSION = "2025-06-18"
const initialize = (id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "canary", version: "0.0.0" },
  },
})
const callTool = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name, arguments: args },
})

interface ToolCallResult {
  result: { content: { type: string; text: string }[]; isError?: boolean }
}

/** Drive a `tools/call` for `principal` over a stateless MCP server, return its content text. */
const toolCall = async (
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const transport = new WorkerTransport({ enableJsonResponse: true })
  const server = buildMcpServer(principal, { env: mcpEnv, waitUntil: () => {} })
  const handler = createMcpHandler(server, { route: "/mcp", transport })
  const post = async (body: unknown): Promise<Record<string, unknown>> => {
    const res = await handler(
      new Request("https://brain.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      }),
      mcpEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    )
    return (await res.json()) as Record<string, unknown>
  }
  await post(initialize(1))
  const called = (await post(callTool(2, name, args))) as unknown as ToolCallResult
  return { text: called.result.content[0]?.text ?? "", isError: called.result.isError ?? false }
}

beforeAll(async () => {
  await seedOrg("mcpA", "mcp-a")
  await seedMembership({ tenantId: "mcpA", userId: "ownerA" })
  await seedDoc({ id: "mcp-doc-A", tenantId: "mcpA", slug: "needle-doc-a" })
  await seedChunk({
    id: CHUNK_A,
    tenantId: "mcpA",
    documentId: "mcp-doc-A",
    content: "the needle is here in alpha territory",
  })

  await seedOrg("mcpB", "mcp-b")
  await seedMembership({ tenantId: "mcpB", userId: "ownerB" })
  await seedDoc({ id: "mcp-doc-B", tenantId: "mcpB", slug: "needle-doc-b" })
  await seedChunk({
    id: CHUNK_B,
    tenantId: "mcpB",
    documentId: "mcp-doc-B",
    content: `the needle is here but only in ${B_MARKER} content`,
  })
})

describe("MCP cross-tenant isolation canary (invariant 3) — real local D1 in workerd", () => {
  test("non-vacuity: tenant B's own MCP search DOES surface B's colliding content", async () => {
    const { text, isError } = await toolCall(principalB, "search", { query: "needle", topK: 12 })
    expect(isError).toBe(false)
    // The adversarial vector arm + the colliding FTS term really surface B in B's own tenant.
    expect(text).toContain(B_MARKER)
    expect(text).toContain(CHUNK_B)
  })

  test("tenant A's MCP search NEVER returns tenant B, across the vector + FTS arms", async () => {
    const { text, isError } = await toolCall(principalA, "search", { query: "needle", topK: 12 })
    expect(isError).toBe(false)
    // A's own content is returned …
    expect(text).toContain("needle-doc-a")
    expect(text).toContain(CHUNK_A)
    // … and B leaked NOWHERE: not B's marker, not B's chunk id, not B's slug.
    expect(text).not.toContain(B_MARKER)
    expect(text).not.toContain(CHUNK_B)
    expect(text).not.toContain("needle-doc-b")
  })

  test("a write tool is hidden from a read-only Principal but listed for a writer", async () => {
    const writerTools = mcpToolsFor(principalA).map((t) => t.name)
    const readonlyTools = mcpToolsFor(readonlyA).map((t) => t.name)
    expect(writerTools).toContain("capture_turn")
    expect(readonlyTools).not.toContain("capture_turn")
    // Read tools stay available to the read-only Principal.
    expect(readonlyTools).toContain("search")
    // Every tool a read-only Principal can see is a read tool.
    expect(mcpToolsFor(readonlyA).every((t) => t.annotations.readOnlyHint)).toBe(true)
  })

  test("a write tool named directly by a read-only Principal is DENIED by the dispatch re-check", async () => {
    const { isError, text } = await toolCall(readonlyA, "capture_turn", {
      sessionId: "s1",
      role: "user",
      content: "hi",
      client: "cli",
    })
    expect(isError).toBe(true)
    expect(text).toContain("forbidden")
  })

  // ── Through the DO `serve` path (the stateful `/mcp/:slug` transport) ──────────────────────────
  // Drive the SAME catalog dispatch inside a live `BrainMCP` Durable Object: `onStart({principal})`
  // injects the edge-resolved Principal as props and builds the catalog server; `handleMcpMessage`
  // runs `tools/call` over the RPC transport. The DO's real env has no Vectorize fake, so `search`
  // degrades to the keyword (FTS) arm (invariant 14) — still JOIN-scoped to the tenant in D1.
  const doSearch = async (
    name: string,
    principal: Principal,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> => {
    const ns = (env as unknown as { BRAIN_MCP: DurableObjectNamespace }).BRAIN_MCP
    const stub = ns.get(ns.idFromName(name))
    await (stub as unknown as { setName(n: string): Promise<void> }).setName(`rpc:${name}`)
    return runInDurableObject(stub as unknown as DurableObjectStub<BrainMCP>, async (instance) => {
      // Rebuild the in-DO server with the resolved Principal (as the edge `serve` path would).
      await instance.onStart({ principal })
      await instance.handleMcpMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "canary-do", version: "0.0.0" },
        },
      })
      const res = (await instance.handleMcpMessage(
        callTool(2, "search", args) as never,
      )) as unknown as ToolCallResult
      return {
        text: res.result.content[0]?.text ?? "",
        isError: res.result.isError ?? false,
      }
    })
  }

  test("DO-path: non-vacuity — tenant B's in-DO search surfaces B's content", async () => {
    const { text, isError } = await doSearch("do-B", principalB, { query: "needle", topK: 12 })
    expect(isError).toBe(false)
    expect(text).toContain(B_MARKER)
  })

  test("DO-path: tenant A's in-DO search NEVER returns tenant B", async () => {
    const { text, isError } = await doSearch("do-A", principalA, { query: "needle", topK: 12 })
    expect(isError).toBe(false)
    expect(text).toContain(CHUNK_A)
    expect(text).not.toContain(B_MARKER)
    expect(text).not.toContain(CHUNK_B)
  })

  // ── Write provenance: MCP dispatch path carries principal.userId into writes ─────────────────
  // Prove that a write tool dispatched through `callMcpTool` → `op.invoke` → the store
  // records the principal's userId, not a stale/missing actor. `capture_turn` is the
  // representative write: it creates or updates a `sessions` row with `user_id = principal.userId`.
  test("write provenance: capture_turn via MCP records user_id = principal.userId in D1", async () => {
    const { text, isError } = await toolCall(principalA, "capture_turn", {
      sessionId: "mcp-prov-session",
      role: "user",
      content: "provenance test turn",
      client: "cli",
    })
    expect(isError).toBe(false)
    // Parse the brain session id from the tool result.
    const result = JSON.parse(text) as { brainSessionId?: string }
    expect(typeof result.brainSessionId).toBe("string")
    const brainSessionId = result.brainSessionId as string

    // Verify the session row in D1 has user_id = the principal's userId ("ownerA").
    const row = await env_.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND tenant_id = ?")
      .bind(brainSessionId, principalA.tenantId)
      .first<{ user_id: string }>()
    expect(row).not.toBeNull()
    expect(row?.user_id).toBe(principalA.userId)
  })

  // ── ingest_document via MCP dispatch: path/tags + user_id provenance + chunks.path ──────────
  // Prove the full surface→catalog→runBatchIngestCore path: ingest_document over MCP creates a
  // documents row with path/tags, user_id = principal.userId, and the produced chunks carry path.
  test("ingest_document via MCP: creates doc+chunks with path/tags, user_id=principal", async () => {
    const content = "The needle is in the /project/ingest haystack for MCP ingestion."
    const { text, isError } = await toolCall(principalA, "ingest_document", {
      content,
      title: "MCP Ingest Test",
      path: "/project/ingest",
      tags: ["mcp", "test"],
      contentType: "text/markdown",
    })
    expect(isError).toBe(false)
    const result = JSON.parse(text) as {
      documentId?: string
      slug?: string
      status?: string
      chunkCount?: number
      deduped?: boolean
    }
    expect(typeof result.documentId).toBe("string")
    expect(result.status === "indexed" || result.status === "accepted").toBe(true)
    expect(typeof result.slug).toBe("string")

    const docId = result.documentId as string

    // Verify documents row: user_id = principal.userId (provenance forced), path and tags recorded.
    const docRow = await env_.DB.prepare(
      "SELECT user_id, path, tags FROM documents WHERE id = ? AND tenant_id = ?",
    )
      .bind(docId, principalA.tenantId)
      .first<{ user_id: string; path: string | null; tags: string }>()
    expect(docRow).not.toBeNull()
    expect(docRow?.user_id).toBe(principalA.userId)
    expect(docRow?.path).toBe("/project/ingest")
    expect(JSON.parse(docRow?.tags ?? "[]")).toContain("mcp")

    // Verify chunks: path mirrored from document (only when status = indexed, not accepted).
    if (result.status === "indexed") {
      const chunkRow = await env_.DB.prepare(
        "SELECT path FROM chunks WHERE document_id = ? AND tenant_id = ? LIMIT 1",
      )
        .bind(docId, principalA.tenantId)
        .first<{ path: string | null }>()
      expect(chunkRow).not.toBeNull()
      expect(chunkRow?.path).toBe("/project/ingest")
    }
  })
})

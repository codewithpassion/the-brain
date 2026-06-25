import { describe, expect, test } from "bun:test"
import type { Principal } from "@brain/shared"
import { buildCatalog } from "../src/catalog"
import { buildCliCommandSpecs } from "../src/cli"
import { buildMcpTools } from "../src/mcp"
import { buildRegistry } from "../src/registry"
import { buildTrpcRouter } from "../src/trpc"

/**
 * The "cannot drift" guarantee (PRD §9.0.2): one op-registry, three generated surfaces. This asserts
 * each generator projects EXACTLY its `registry.bySurface(...)` slice — no surface drops or invents
 * an op. The mapping is per-surface (NOT "all three identical"): `audit_export` is intentionally
 * `rest`+`cli` only, so a naive equality would be wrong. tRPC procedures ← the `"rest"` flag
 * (tRPC is THE typed API surface; Hono-vs-tRPC is an impl detail within "rest").
 */

const ADMIN: Principal = {
  tenantId: "org_x",
  userId: "u1",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
}

const sorted = (names: readonly string[]): string[] => [...names].sort()

const trpcProcedureNames = (): string[] =>
  Object.keys(
    (buildTrpcRouter() as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures,
  )

describe("surface drift", () => {
  test("the catalog covers every registered op exactly once", () => {
    const registry = buildRegistry()
    const catalog = buildCatalog()
    expect(catalog.length).toBe(registry.list().length)
    expect(sorted(catalog.map((op) => op.def.name))).toEqual(
      sorted(registry.list().map((op) => op.name)),
    )
  })

  test("MCP tools == registry.bySurface('mcp') (for a full-capability principal)", () => {
    const registry = buildRegistry()
    expect(sorted(buildMcpTools(ADMIN).map((tool) => tool.name))).toEqual(
      sorted(registry.bySurface("mcp").map((op) => op.name)),
    )
  })

  test("CLI specs == registry.bySurface('cli')", () => {
    const registry = buildRegistry()
    expect(sorted(buildCliCommandSpecs().map((spec) => spec.name))).toEqual(
      sorted(registry.bySurface("cli").map((op) => op.name)),
    )
  })

  test("tRPC procedures == registry.bySurface('rest')", () => {
    const registry = buildRegistry()
    expect(sorted(trpcProcedureNames())).toEqual(
      sorted(registry.bySurface("rest").map((op) => op.name)),
    )
  })

  test("every CLI op also has a tRPC procedure (cli ⟹ rest — the CLI is a tRPC client)", () => {
    const registry = buildRegistry()
    const rest = new Set(registry.bySurface("rest").map((op) => op.name))
    for (const op of registry.bySurface("cli")) {
      expect(rest.has(op.name)).toBe(true)
    }
  })

  test("read/write filter: a read-only principal sees no write/admin MCP tools", () => {
    const readonly: Principal = {
      ...ADMIN,
      role: "readonly",
      capabilities: ["read"],
      readOnly: true,
    }
    const tools = buildMcpTools(readonly)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((tool) => tool.annotations.capability === "read")).toBe(true)
    // and every read op on the mcp surface IS present
    const registry = buildRegistry()
    const readMcp = registry
      .bySurface("mcp")
      .filter((op) => op.capability === "read")
      .map((op) => op.name)
    expect(sorted(tools.map((t) => t.name))).toEqual(sorted(readMcp))
  })

  test("MCP inputSchema is a JSON-Schema object derived from the op's Zod input", () => {
    const think = buildMcpTools(ADMIN).find((tool) => tool.name === "think")
    expect(think).toBeDefined()
    const schema = think?.inputSchema as {
      type?: string
      properties?: Record<string, { type?: string; minimum?: number }>
      required?: string[]
    }
    expect(schema.type).toBe("object")
    expect(schema.properties).toHaveProperty("query")
    // `topK` has a Zod default → the converter DROPS it from `required` (a defaulted field is
    // optional for a client). `query` (no default) stays required.
    expect(schema.required).toContain("query")
    expect(schema.required).not.toContain("topK")
    expect(schema.properties?.topK?.type).toBe("integer")
  })

  test("converter handles enum / union+literal / array constructs across the op set", () => {
    const tools = buildMcpTools(ADMIN)
    const props = (name: string): Record<string, Record<string, unknown>> =>
      (
        tools.find((t) => t.name === name)?.inputSchema as {
          properties: Record<string, Record<string, unknown>>
        }
      ).properties

    // enum → { type: "string", enum: [...] }
    expect(props("capture_turn").role).toEqual({
      type: "string",
      enum: ["user", "assistant", "system", "tool"],
    })

    // union(array, literal) → anyOf; array-of-enum → items.enum
    const mint = props("mint_api_key")
    expect(Array.isArray((mint.requestedScopes as { anyOf?: unknown[] }).anyOf)).toBe(true)
    expect((mint.requestedCapabilities as { items: { enum?: string[] } }).items.enum).toEqual([
      "read",
      "write",
      "admin",
    ])

    // array-with-default → array items + dropped from required
    const breakGlass = tools.find((t) => t.name === "break_glass_read")?.inputSchema as {
      properties: Record<string, { type?: string }>
      required?: string[]
    }
    expect(breakGlass.properties.factIds?.type).toBe("array")
    expect(breakGlass.required).toContain("reason")
    expect(breakGlass.required).not.toContain("factIds")
  })
})

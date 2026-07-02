/**
 * The MCP dispatch core (PRD §9.2): project the SINGLE op-registry into MCP `tools/list` entries
 * and run `tools/call` through the SAME `buildCatalog().invoke` the tRPC + CLI surfaces use — so
 * the MCP catalog can never drift, and every tool reaches tenant data ONLY via the catalog's
 * `createScopedServices` (the mandatory D1 re-check, invariant 3). This module names NO raw
 * binding (boundary-lint): it threads `env` straight into the catalog invoker, which builds the
 * scoped services inside `@brain/db`.
 *
 * Two-axis filtering (PRD §9.2.3, "read-only key → only read ops registered AND a leaked write is
 * denied — double gate"):
 *   - `tools/list` emits only ops with `scopeSatisfied(op.capability, principal)` (read always;
 *     write/admin only for a principal that holds the capability and is not read-only).
 *   - `tools/call` RE-CHECKS the same gate before dispatch, so a client that names a hidden write
 *     tool by string is rejected, not silently executed.
 */
import type { Principal } from "@brain/shared"
import { scopeSatisfied } from "@brain/shared"
import {
  buildCatalog,
  buildMcpTools,
  type McpToolDef,
  type SurfaceContext,
  type SurfaceEnv,
  type SurfaceOp,
} from "@brain/surface"

/** The catalog is pure (handler-free defs + invokers); build it ONCE per isolate. */
const CATALOG: readonly SurfaceOp[] = buildCatalog()
const BY_NAME = new Map<string, SurfaceOp>(CATALOG.map((op) => [op.def.name, op]))

/** One MCP `tools/list` entry — the SDK tool shape (JSON-Schema input + read-only hint). */
export interface McpListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean }
}

const toListed = (def: McpToolDef): McpListedTool => ({
  name: def.name,
  description: def.description,
  inputSchema: def.inputSchema,
  annotations: { readOnlyHint: def.annotations.readOnlyHint },
})

/** The MCP tools VISIBLE to `principal` (read always; write/admin only when capability-held). */
export const mcpToolsFor = (principal: Principal): McpListedTool[] =>
  buildMcpTools(principal, CATALOG).map(toListed)

/** The gbrain-style structured error envelope MCP clients receive on a failed `tools/call`. */
export interface McpToolError {
  error: string
  message: string
}

/** Discriminated result of a dispatch — either the op output, or a structured error. */
export type McpCallOutcome = { ok: true; output: unknown } | { ok: false; error: McpToolError }

/**
 * Dispatch a `tools/call` for `principal`. The capability RE-CHECK (`scopeSatisfied`) runs before
 * the catalog invoker, so a hidden write/admin tool named directly is denied. `env`/`waitUntil`
 * are threaded into the `SurfaceContext` whose `invoke` builds the tenant-scoped services in
 * `@brain/db` — this module never touches a raw binding.
 */
export const callMcpTool = async (
  principal: Principal,
  env: SurfaceEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  name: string,
  args: unknown,
): Promise<McpCallOutcome> => {
  const op = BY_NAME.get(name)
  if (op === undefined || !op.def.surfaces.includes("mcp")) {
    return { ok: false, error: { error: "unknown_tool", message: `unknown tool: ${name}` } }
  }
  // Two-axis gate: the registration filter hides write/admin from a read-only principal; this
  // re-check denies a hidden tool named directly (defence-in-depth, PRD §9.2.3).
  if (!scopeSatisfied(op.def.capability, principal)) {
    return {
      ok: false,
      error: { error: "forbidden", message: `tool "${name}" requires ${op.def.capability}` },
    }
  }
  const ctx: SurfaceContext = { principal, env, waitUntil, surface: "mcp" }
  try {
    return { ok: true, output: await op.invoke(ctx, args ?? {}) }
  } catch (cause) {
    // Teaching errors: a Zod validation failure names the exact bad field(s) so the agent can
    // self-correct and retry, instead of getting an opaque blob. Duck-typed (zod isn't a direct
    // dep here; the error crosses the @brain/db boundary).
    const issues = zodIssueSummary(cause)
    if (issues !== null) {
      return {
        ok: false,
        error: {
          error: "invalid_arguments",
          message: `invalid arguments for "${name}": ${issues}. Check the tool's input schema and retry.`,
        },
      }
    }
    const message = cause instanceof Error ? cause.message : "tool invocation failed"
    return { ok: false, error: { error: "tool_error", message } }
  }
}

/** Field-level summary of a ZodError (duck-typed), or null if `cause` isn't one. */
const zodIssueSummary = (cause: unknown): string | null => {
  if (cause === null || typeof cause !== "object") return null
  const c = cause as { name?: unknown; issues?: unknown }
  if (c.name !== "ZodError" || !Array.isArray(c.issues)) return null
  return (c.issues as { path?: (string | number)[]; message?: string }[])
    .map((i) => `${(i.path ?? []).join(".") || "(arguments)"}: ${i.message ?? "invalid"}`)
    .join("; ")
}

// ── brain://ops resource — the catalog grouped by purpose (generated from the live registry) ──

const PURPOSE_ORDER = [
  "Memory",
  "Facts & sessions",
  "Search & think",
  "Graph",
  "Sync",
  "Admin & governance",
] as const

const FACTS_SESSION_OPS = new Set([
  "recall",
  "forget_fact",
  "capture_turn",
  "finalize_session",
  "get_session_context",
  "create_snapshot",
  "list_snapshots",
  "list_sessions",
])
// The content family: retrieval (search/think/query) + capture (ingest_document/add_thought). Grouped
// together so an agent scanning the catalog finds "how do I put content in / get it out" in one place.
const SEARCH_OPS = new Set(["search", "think", "query", "ingest_document", "add_thought"])
const GRAPH_OPS = new Set([
  "traverse_graph",
  "get_links",
  "get_backlinks",
  "get_tags",
  "get_timeline",
  "find_orphans",
  "list_entities",
  "list_entity_edges",
  "search_entities",
  "add_link",
  "add_tag",
  "add_timeline_entry",
])

/** Bucket a tool into a human-meaningful family for the catalog resource. */
const purposeOf = (name: string): (typeof PURPOSE_ORDER)[number] => {
  if (name.startsWith("memory_") || name.startsWith("okf_")) return "Memory"
  if (FACTS_SESSION_OPS.has(name)) return "Facts & sessions"
  if (SEARCH_OPS.has(name)) return "Search & think"
  if (GRAPH_OPS.has(name)) return "Graph"
  if (name.includes("vault") || name.includes("notion")) return "Sync"
  return "Admin & governance"
}

/** Render the tools VISIBLE to `principal`, grouped by purpose, as a markdown catalog. */
export const brainOpsCatalogText = (principal: Principal): string => {
  const tools = mcpToolsFor(principal)
  const groups = new Map<string, McpListedTool[]>()
  for (const tool of tools) {
    const purpose = purposeOf(tool.name)
    const arr = groups.get(purpose) ?? []
    arr.push(tool)
    groups.set(purpose, arr)
  }
  const lines: string[] = [
    "# Brain tools by purpose",
    "",
    `${tools.length} tools are available to you (read tools always; write/admin appear only when your credential holds the capability).`,
    "",
  ]
  for (const purpose of PURPOSE_ORDER) {
    const arr = groups.get(purpose)
    if (arr === undefined || arr.length === 0) continue
    lines.push(`## ${purpose}`)
    for (const tool of [...arr].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `- **${tool.name}** (${tool.annotations.readOnlyHint ? "read" : "write"}) — ${tool.description}`,
      )
    }
    lines.push("")
  }
  return lines.join("\n")
}

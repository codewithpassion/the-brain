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
    const message = cause instanceof Error ? cause.message : "tool invocation failed"
    return { ok: false, error: { error: "tool_error", message } }
  }
}

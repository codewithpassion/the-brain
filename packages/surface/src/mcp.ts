/**
 * `buildMcpTools` — project the catalog into MCP tool definitions (PRD §9.2). Each op's MCP
 * `inputSchema` is the JSON Schema of its frozen Zod `input` (so MCP args validate against the
 * SAME contract as tRPC input + CLI flags). Only ops whose `surfaces` include `"mcp"` are emitted.
 *
 * The read/write registration rule (PRD §9.2.3 "read-only key → only read ops registered AND
 * scopeSatisfied denies a leaked write — double gate"): a tool is visible to a principal iff
 * `scopeSatisfied(op.capability, principal)`. `read` ops are visible to everyone (every principal
 * holds `read`); `write`/`admin` ops are visible ONLY to principals that actually hold the
 * capability and are not read-only. This is stricter (and correct) vs a bare `!readOnly` check —
 * it also hides `admin` tools (e.g. `break_glass_read`) from non-admin writers.
 */
import type { AnyOpDef, Capability, Principal } from "@brain/shared"
import { scopeSatisfied } from "@brain/shared"
import { buildCatalog, type SurfaceOp } from "./catalog"
import { toJsonSchema } from "./json-schema"

/** One MCP tool definition generated from an `OpDef`. */
export interface McpToolDef {
  name: string
  description: string
  /** JSON Schema (draft 2020-12) derived from the op's Zod `input`. */
  inputSchema: Record<string, unknown>
  annotations: {
    /** MCP `readOnlyHint` — true for non-mutating ops. */
    readOnlyHint: boolean
    /** The required capability axis (read|write|admin) — for client-side affordance hints. */
    capability: Capability
  }
}

const toMcpTool = (def: AnyOpDef): McpToolDef => ({
  name: def.name,
  description: def.description,
  inputSchema: toJsonSchema(def.input),
  annotations: { readOnlyHint: def.readOnly, capability: def.capability },
})

/**
 * Build the MCP tool catalog VISIBLE to `principal` (the read/write registration filter applied).
 * Pass an admin principal to enumerate the full `"mcp"` surface (the drift test does exactly this).
 */
export const buildMcpTools = (
  principal: Principal,
  catalog: readonly SurfaceOp[] = buildCatalog(),
): McpToolDef[] =>
  catalog
    .filter((op) => op.def.surfaces.includes("mcp") && scopeSatisfied(op.def.capability, principal))
    .map((op) => toMcpTool(op.def))

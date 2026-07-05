import { z } from "zod"
import type { Capability } from "./enums"

/**
 * The single Zod-based operation registry (PRD §9.0.2). The MCP tool catalog,
 * the tRPC procedures, and the `brain` CLI commands are ALL generated from one
 * registry so they cannot drift: the same schema validates MCP args, tRPC
 * input, CLI flags, and dashboard server-fn input.
 *
 * This package holds the FROZEN CONTRACT half only: name, description, the
 * required `capability` (read|write|admin authorization axis — NOT
 * `allowedScopes`), the `readOnly` flag, the surface flags, and the input/output
 * Zod schemas. The runtime `handler` (whose `OpContext` references
 * `ScopedDB`/`ScopedVectorize`/`AiServices`/`Env`) is bound downstream in the
 * Worker, which keeps this package pure. The full §9 `Operation<I, O>` is then
 * `OpDef<I, O> & { handler: (ctx: OpContext, input: I) => Promise<O> }`.
 */

/** The three client-facing surfaces an op can be exposed on (PRD §9). */
export const OP_SURFACES = ["mcp", "rest", "cli"] as const
export type OpSurface = (typeof OP_SURFACES)[number]

/** Default exposure: all three surfaces. */
export const ALL_SURFACES: readonly OpSurface[] = OP_SURFACES

/** The frozen contract for one operation (PRD §9.0.2, handler-free). */
export interface OpDef<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Stable op name, e.g. 'think', 'search'. */
  name: string
  description: string
  /**
   * Required capability (gbrain hierarchy: admin ⊃ write ⊃ read). Evaluated by
   * `scopeSatisfied` against `principal.capabilities`, never `allowedScopes`.
   */
  capability: Capability
  /** True for mutating ops; read-only principals never get them registered. */
  readOnly: boolean
  /** Surfaces this op is exposed on. */
  surfaces: readonly OpSurface[]
  input: Input
  output: Output
}

/** Erased op-def type used as the registry element (no `any`). */
export type AnyOpDef = OpDef

/** Input to `defineOp`: `surfaces` defaults to all three. */
export interface DefineOpInput<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> {
  name: string
  description: string
  capability: Capability
  readOnly: boolean
  surfaces?: readonly OpSurface[]
  input: Input
  output: Output
}

/**
 * Type-preserving helper to declare an op contract. Adding a capability = adding
 * one `defineOp(...)`; it then appears in MCP `tools/list`, tRPC, and `brain`
 * CLI help with no further wiring.
 */
export function defineOp<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  def: DefineOpInput<Input, Output>,
): OpDef<Input, Output> {
  return {
    name: def.name,
    description: def.description,
    capability: def.capability,
    readOnly: def.readOnly,
    surfaces: def.surfaces ?? ALL_SURFACES,
    input: def.input,
    output: def.output,
  }
}

/**
 * Typed registry container. Pure data structure (no side effects): later phases
 * `register(...)` the rest of the catalog onto an instance. Duplicate names
 * throw — a frozen catalog cannot silently shadow an op.
 */
export class OpRegistry {
  private readonly ops = new Map<string, AnyOpDef>()

  register(op: AnyOpDef): this {
    if (this.ops.has(op.name)) {
      throw new Error(`duplicate op name: ${op.name}`)
    }
    this.ops.set(op.name, op)
    return this
  }

  get(name: string): AnyOpDef | undefined {
    return this.ops.get(name)
  }

  has(name: string): boolean {
    return this.ops.has(name)
  }

  list(): readonly AnyOpDef[] {
    return [...this.ops.values()]
  }

  bySurface(surface: OpSurface): readonly AnyOpDef[] {
    return this.list().filter((op) => op.surfaces.includes(surface))
  }
}

// ── Representative op contracts (proof of mechanism; PRD §9.0.2 / §9.2) ───────
// The full tool catalog is registered by later phases — these two prove the
// shape and validate end-to-end against the surfaces.

const SearchHitSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  slug: z.string(),
  score: z.number(),
  snippet: z.string(),
  /** Dashboard deep link to the source document — present when DASHBOARD_URL is configured. */
  url: z.string().optional(),
})

/** `search` — hybrid keyword+vector RRF (expansion off). */
export const SEARCH_OP = defineOp({
  name: "search",
  description:
    "Hybrid keyword+vector search returning scored passages — no rerank, no synthesis. Fast and cheap. " +
    "Use for raw evidence passages; use query for higher-precision reranking; use think for a synthesized answer.",
  capability: "read",
  readOnly: true,
  input: z.object({
    query: z.string().min(1).describe("Natural-language or keyword query."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(12)
      .describe("Number of passages to return (1–50, default 12)."),
    scope: z
      .string()
      .optional()
      .describe("Scope filter, e.g. a team or project slug. Omit for all visible content."),
    path: z
      .string()
      .optional()
      .describe("Restrict to documents under this path prefix or exact match, e.g. '/project/x'."),
    tag: z.string().optional().describe("Restrict to documents that contain exactly this tag."),
    expandQuery: z
      .boolean()
      .optional()
      .describe(
        "Generate query variants to widen recall (extra AI cost). Off by default for search/query.",
      ),
  }),
  output: z.object({
    hits: z.array(SearchHitSchema),
  }),
})

/** `think` — expansion + rerank + token-budget-guarded cited synthesis. */
export const THINK_OP = defineOp({
  name: "think",
  description:
    "Search + cross-encoder rerank + AI synthesis: returns a cited answer, evidence passages, and knowledge gaps. " +
    "The full-pipeline op — slower and token-costly. Use when you need a direct answer; use search/query for raw passages.",
  capability: "read",
  readOnly: true,
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe("Natural-language question to answer from the knowledge base."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(12)
      .describe("Number of passages to retrieve for synthesis (1–50, default 12)."),
    scope: z
      .string()
      .optional()
      .describe("Scope filter, e.g. a team or project slug. Omit for all visible content."),
    path: z
      .string()
      .optional()
      .describe("Restrict to documents under this path prefix or exact match, e.g. '/project/x'."),
    tag: z.string().optional().describe("Restrict to documents that contain exactly this tag."),
    expandQuery: z
      .boolean()
      .optional()
      .describe(
        "Generate query variants to widen recall (extra AI cost). On by default for think; set false to disable.",
      ),
  }),
  output: z.object({
    answer: z.string(),
    evidence: z.array(SearchHitSchema),
    citations: z.array(
      z.object({
        slug: z.string(),
        chunkId: z.string(),
        documentId: z.string(),
        /** Dashboard deep link to the cited document — present when DASHBOARD_URL is configured. */
        url: z.string().optional(),
      }),
    ),
    gaps: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
})

/** The representative core ops — proof that the mechanism wires end-to-end. */
export const CORE_OPS: readonly AnyOpDef[] = [SEARCH_OP, THINK_OP]

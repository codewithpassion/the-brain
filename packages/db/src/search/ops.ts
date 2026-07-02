/**
 * The three retrieval ops — `search`, `query`, `think` (PRD §5.3 / §5.5, §9.0.2).
 *
 * Each is a `BoundOp`: the FROZEN handler-free `OpDef` contract (from `@brain/shared`) plus a
 * runtime `handler` that composes the pipeline. They differ only by stage depth:
 *   - `search` — hybrid + RRF + boosts, rerank OFF (cheap).
 *   - `query`  — hybrid + RRF + boosts + rerank ON (no synthesis).
 *   - `think`  — `query` + token-budget-guarded cited synthesis.
 *
 * Query expansion (W4.1) is now wired behind `AiPort.gen` (see `expand.ts`) and threaded from
 * the op input as `expandQuery?: boolean`. The DEFAULT is per-op: `think` ON (breadth matters
 * for a synthesized answer), `search`/`query` OFF (the cheap/precise paths). It is a strict
 * widening that degrades to the original query when gen returns null.
 *
 * Evidence, citations, and recall traces are ALL sourced from `FusedCandidate.candidate`,
 * which is built only from re-checked, hydrated rows (invariant 3) — never a raw match id.
 */
import {
  type AnyOpDef,
  defineOp,
  type OpRegistry,
  SEARCH_OP,
  THINK_OP,
  THINK_TOP_K,
} from "@brain/shared"
import { hybridSearch } from "./pipeline"
import { synthesizeAnswer } from "./synthesis"
import type { FusedCandidate, OpContext, SearchHit, SearchResult, ThinkResult } from "./types"

/** Parsed (post-Zod) input shared by all three ops. */
export interface RetrievalInput {
  query: string
  topK: number
  scope?: string
  /** Restrict retrieval to documents under this path prefix (or exact match). */
  path?: string
  /** Restrict retrieval to documents that contain this tag. */
  tag?: string
  /** W4.1 query expansion override; unset → the per-op default (think ON, search/query OFF). */
  expandQuery?: boolean
}

/** A frozen `OpDef` contract paired with its runtime handler. */
export interface BoundOp<I, O> {
  def: AnyOpDef
  handler: (ctx: OpContext, input: I) => Promise<O>
}

/** `query` — like `search` but with the cross-encoder rerank stage ON (no synthesis). */
export const QUERY_OP = defineOp({
  name: "query",
  description:
    "Hybrid keyword+vector search with cross-encoder rerank for higher passage precision — no synthesis. " +
    "Between search (fast, no rerank) and think (adds AI synthesis). Use when passage quality matters but you don't need an answer generated.",
  capability: "read",
  readOnly: true,
  input: SEARCH_OP.input,
  output: SEARCH_OP.output,
})

/** Project a fused candidate into the frozen `SearchHit` shape (score = boosted RRF score). */
const toHit = (fused: FusedCandidate): SearchHit => ({
  id: fused.candidate.chunkId,
  documentId: fused.candidate.documentId,
  slug: fused.candidate.slug,
  score: fused.score,
  snippet: fused.candidate.content,
})

/**
 * Hand kept hits to the recall sink — but ONLY when there ARE hits (invariant 10 / s05 §5.7:
 * "zero hits write zero traces"). The worker impl runs the durable write off the read path via
 * waitUntil, so this resolves without blocking the response. Hits are keyed by the HYDRATED
 * chunk id (built from re-checked rows only — never a raw match id).
 */
const writeRecall = async (
  ctx: OpContext,
  query: string,
  ranked: FusedCandidate[],
): Promise<void> => {
  if (ranked.length === 0) return
  await ctx.deps.recall.append({
    userId: ctx.principal.userId,
    query,
    hits: ranked.map((r) => ({ chunkId: r.candidate.chunkId, score: r.score })),
  })
}

/** Build a `ScopedSearchFilter` from optional path/tag inputs (EOPT-safe). */
const searchFilter = (input: RetrievalInput): { path?: string; tag?: string } | undefined => {
  if (input.path === undefined && input.tag === undefined) return undefined
  return {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
  }
}

/** `search` handler — cheap hybrid, rerank OFF. */
export const searchOp: BoundOp<RetrievalInput, SearchResult> = {
  def: SEARCH_OP,
  handler: async (ctx, input) => {
    const f = searchFilter(input)
    const ranked = await hybridSearch(ctx.deps, input.query, {
      topK: input.topK,
      rerank: false,
      expand: input.expandQuery ?? false, // search: cheap path, expansion OFF by default
      ...(f !== undefined ? { filter: f } : {}),
    })
    return { hits: ranked.map(toHit) }
  },
}

/** `query` handler — hybrid + rerank ON, recall-traced off the read path. */
export const queryOp: BoundOp<RetrievalInput, SearchResult> = {
  def: QUERY_OP,
  handler: async (ctx, input) => {
    const f = searchFilter(input)
    const ranked = await hybridSearch(ctx.deps, input.query, {
      topK: input.topK,
      rerank: true,
      expand: input.expandQuery ?? false, // query: precise-passage path, expansion OFF by default
      ...(f !== undefined ? { filter: f } : {}),
    })
    await writeRecall(ctx, input.query, ranked)
    return { hits: ranked.map(toHit) }
  },
}

/** `think` handler — query + token-budget-guarded cited synthesis. */
export const thinkOp: BoundOp<RetrievalInput, ThinkResult> = {
  def: THINK_OP,
  handler: async (ctx, input) => {
    const f = searchFilter(input)
    const ranked = await hybridSearch(ctx.deps, input.query, {
      topK: THINK_TOP_K,
      rerank: true,
      expand: input.expandQuery ?? true, // think: breadth matters — expansion ON by default
      ...(f !== undefined ? { filter: f } : {}),
    })
    await writeRecall(ctx, input.query, ranked)

    const evidence = ranked.map(toHit)
    const citations = ranked.map((r) => ({ slug: r.candidate.slug, chunkId: r.candidate.chunkId }))

    if (ranked.length === 0) {
      return {
        answer: "",
        evidence,
        citations,
        gaps: ["No matching evidence found for this question."],
        warnings: ["no_evidence"],
      }
    }

    // Synthesis: single-gen when evidence fits; map/refine over summaries when it overflows the
    // budget (W4.3). `synthesizeAnswer` re-checks the cost cap before EACH gen() (invariant 16)
    // and degrades a failed map step back to the truncate path.
    const { answer, warnings, gaps } = await synthesizeAnswer(
      ctx.deps.ai,
      () => ctx.deps.budget.check(),
      input.query,
      ranked,
    )
    if (answer === null) {
      return {
        answer: "",
        evidence,
        citations,
        gaps,
        warnings: [...warnings, "llm_unavailable"],
      }
    }
    return { answer: answer.trim(), evidence, citations, gaps, warnings }
  },
}

/** All three bound retrieval ops. */
export const SEARCH_OPS = [searchOp, queryOp, thinkOp] as const

/** Register the three op CONTRACTS into a shared `OpRegistry` (handlers bind in the Worker). */
export const registerSearchOps = (registry: OpRegistry): OpRegistry => {
  for (const op of SEARCH_OPS) registry.register(op.def)
  return registry
}

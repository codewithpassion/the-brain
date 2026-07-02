/**
 * Hybrid-search orchestration (PRD §5.3, invariants 3, 14, 16).
 *
 * Data flow: budget pre-check → [vector arm ∥ FTS arm] (each funnels through ScopedDB
 * hydration = the re-check) → RRF fusion + trust/title boosts → top-CANDIDATE_TOP →
 * optional rerank → top-k. The `think` layer adds token-budget-guarded cited synthesis on
 * top (see ops.ts).
 *
 * `budget.check()` runs FIRST, before any `embed()` is issued (invariant 16) — it throws to
 * 429 the request (a hard cost cap, distinct from the AI degrade contract). Both arms then
 * run in parallel and independently degrade to empty on missing AI/Vectorize.
 */
import { CANDIDATE_TOP, VECTORIZE_TOPK_MAX } from "@brain/shared"
import { ftsArm, vectorArm } from "./arms"
import { expandQuery } from "./expand"
import { rrfFusion } from "./fusion"
import { rerankStage } from "./rerank-stage"
import type { Candidate, FusedCandidate, SearchDeps } from "./types"

export interface HybridOptions {
  /** Candidate-pool size carried out of fusion before rerank/top-k (default CANDIDATE_TOP). */
  candidateTop?: number
  /** Final result size after rerank. */
  topK: number
  /** Per-arm retrieval breadth (how many ids each arm fetches before the re-check). */
  armTopK?: number
  /** Whether to run the cross-encoder rerank stage (`search`=off, `query`/`think`=on). */
  rerank: boolean
  /**
   * Optional namespace/tag filter applied during the D1 re-check.
   * Note: Vectorize returns its full top-K BEFORE the re-check, so the effective
   * candidate pool may shrink. Pushing the filter into Vectorize metadata is deferred.
   */
  filter?: { path?: string; tag?: string }
  /**
   * Query expansion (W4.1): when true, generate a few `gen()` query variants and retrieve
   * over `[original, ...variants]`, fusing the union. Degrades to the original-only path when
   * `gen()` returns null (never narrower than the un-expanded run). Default OFF.
   */
  expand?: boolean
}

/**
 * Run the hybrid pipeline up to (and optionally including) rerank, returning the fused +
 * boosted top-k candidates. Each surviving candidate carries its normalized + boosted RRF
 * score (NOT the reranker's score — see rerank-stage.ts).
 */
export const hybridSearch = async (
  deps: SearchDeps,
  query: string,
  options: HybridOptions,
): Promise<FusedCandidate[]> => {
  // Invariant 16: the 429 cost-cap pre-check runs BEFORE any embed()/gen(). Throws on cap.
  await deps.budget.check()

  const candidateTop = options.candidateTop ?? CANDIDATE_TOP
  // W4.2 (breadth widening, NOT metadata push-down): a namespace/tag filter is applied POST-hoc at
  // the D1 re-check, so a selective filter over a large corpus can starve the pool if each arm only
  // fetches candidateTop ids. When a filter is active we widen per-arm retrieval to VECTORIZE_TOPK_MAX
  // (100 — Vectorize's hard topK cap) so the re-check filters from the largest pool the platform
  // allows. True metadata push-down is infeasible: Vectorize's filter grammar has no prefix/array-
  // contains, and `path` is a prefix match while `tag` is multi-valued on pages — so it would need
  // exact-path-only semantics + a metadata stamp + a full vector re-upsert (deferred follow-up).
  const filterActive = options.filter?.path !== undefined || options.filter?.tag !== undefined
  // Clamp to VECTORIZE_TOPK_MAX (100) — the hard per-query cap ScopedVectorize enforces; never
  // request above it. `candidateTop` (40) < cap, so a filtered query widens to exactly the cap.
  const armTopK = options.armTopK ?? (filterActive ? VECTORIZE_TOPK_MAX : candidateTop)

  // W4.1: expand into [original, ...variants] when flagged; a gen() degrade returns [query], so
  // the retrieval below is identical to the un-expanded path (never narrower). The pipeline's
  // budget.check() above already gated this gen() call (invariant 16).
  const queries = options.expand ? await expandQuery(deps.ai, query) : [query]

  // One vector + FTS arm per query variant, all in parallel; each arm independently re-checks +
  // hydrates through ScopedDB. Fusion dedups by chunkId across every arm (a chunk that surfaces
  // for several variants accrues rank contributions from each). Title-boost + rerank use the
  // ORIGINAL query so relevance stays anchored to what the caller actually asked.
  const arms: Candidate[][] = await Promise.all(
    queries.flatMap((q) => [
      vectorArm(deps.db, deps.vectors, deps.ai, q, armTopK, undefined, options.filter),
      ftsArm(deps.db, q, armTopK, options.filter),
    ]),
  )

  const fused = rrfFusion(arms, query).slice(0, candidateTop)
  if (!options.rerank) return fused.slice(0, options.topK)
  return rerankStage(deps.ai, query, fused, options.topK)
}

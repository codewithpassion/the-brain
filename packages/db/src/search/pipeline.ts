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
import { CANDIDATE_TOP } from "@brain/shared"
import { ftsArm, vectorArm } from "./arms"
import { rrfFusion } from "./fusion"
import { rerankStage } from "./rerank-stage"
import type { FusedCandidate, SearchDeps } from "./types"

export interface HybridOptions {
  /** Candidate-pool size carried out of fusion before rerank/top-k (default CANDIDATE_TOP). */
  candidateTop?: number
  /** Final result size after rerank. */
  topK: number
  /** Per-arm retrieval breadth (how many ids each arm fetches before the re-check). */
  armTopK?: number
  /** Whether to run the cross-encoder rerank stage (`search`=off, `query`/`think`=on). */
  rerank: boolean
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
  const armTopK = options.armTopK ?? candidateTop

  // Both arms run in parallel; each independently re-checks + hydrates through ScopedDB.
  const [vector, fts] = await Promise.all([
    vectorArm(deps.db, deps.vectors, deps.ai, query, armTopK),
    ftsArm(deps.db, query, armTopK),
  ])

  const fused = rrfFusion([vector, fts], query).slice(0, candidateTop)
  if (!options.rerank) return fused.slice(0, options.topK)
  return rerankStage(deps.ai, query, fused, options.topK)
}

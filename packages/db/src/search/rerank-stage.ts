/**
 * Cross-encoder rerank stage (PRD §5.4, invariants 14, 20).
 *
 * Calls `AiPort.rerank` over the top-CANDIDATE_TOP RRF-fused candidates and uses the result
 * ONLY to re-order and select — it deliberately does NOT overwrite each candidate's score.
 * The `rerank()` chokepoint returns identity (RRF) order with `score: 0` whenever it
 * degrades (missing binding / malformed output — the default path until `RUN_AI_GATES`), so
 * propagating the reranker's score would zero out every evidence score on the normal path.
 * Instead the meaningful normalized + boosted RRF `score` from fusion is preserved; the
 * reranker just decides WHICH candidates and in WHAT order (invariant 20's index→chunk remap
 * is encapsulated in the chokepoint).
 */
import type { AiPort, FusedCandidate } from "./types"

/**
 * Rerank `candidates` (already RRF-sorted) and return the top-`topK` in the reranker's
 * order, each keeping its fusion score. On degrade the chokepoint yields identity order, so
 * the result is the RRF-order top-`topK` — exactly the documented degrade target.
 */
export const rerankStage = async (
  ai: AiPort,
  query: string,
  candidates: FusedCandidate[],
  topK: number,
): Promise<FusedCandidate[]> => {
  if (candidates.length === 0) return []
  const hits = await ai.rerank(
    query,
    candidates.map((c) => ({ text: c.candidate.content })),
    topK,
  )
  const out: FusedCandidate[] = []
  for (const hit of hits) {
    const fused = candidates[hit.index]
    if (fused) out.push(fused) // keep the fusion score; reranker decides order/selection only
  }
  return out.slice(0, topK)
}

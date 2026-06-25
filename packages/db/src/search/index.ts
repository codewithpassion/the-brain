/**
 * Hybrid-search + cited-synthesis (`think`) pipeline (PRD §5). Composes the frozen
 * `Scoped*` + `embed/gen/rerank` chokepoints; builds NO new raw arms. See the modules for
 * the per-stage invariants (esp. invariant 3 — evidence/citations from re-checked rows only).
 */
export { ftsArm, vectorArm } from "./arms"
export { isTitlePhraseMatch, rrfFusion } from "./fusion"
export type { BoundOp, RetrievalInput } from "./ops"
export {
  QUERY_OP,
  queryOp,
  registerSearchOps,
  SEARCH_OPS,
  searchOp,
  thinkOp,
} from "./ops"
export { type HybridOptions, hybridSearch } from "./pipeline"
export { rerankStage } from "./rerank-stage"
export { type BuiltPrompt, buildSynthesisPrompt, SYNTH_SYSTEM } from "./synthesis"
export type {
  AiPort,
  AiRerankCandidate,
  AiRerankHit,
  BudgetPort,
  Candidate,
  FusedCandidate,
  OpContext,
  RecallSink,
  RecallTrace,
  RecallTraceBatch,
  SearchDeps,
  SearchHit,
  SearchResult,
  ThinkResult,
} from "./types"
export { toCandidate } from "./types"

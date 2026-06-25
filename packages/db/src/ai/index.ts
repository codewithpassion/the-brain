/** AI chokepoints over `env.AI` via AI Gateway (PRD §5). See each module for invariants. */
export { embed, embedForIndex } from "./embed"
export type { AiDeps, BrainAiRunOptions } from "./gateway"
export { aiGateway } from "./gateway"
export { gen, genExtract } from "./gen"
export type { AiCallMetric, OpCallMetric, OpsMetrics } from "./metrics"
export { createOpsMetrics, noopOpsMetrics } from "./metrics"
export type { RerankCandidate, RerankHit } from "./rerank"
export { remapRerank, rerank } from "./rerank"

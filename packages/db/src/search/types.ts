/**
 * Search-pipeline types + injectable seams (PRD §5.3–§5.5, invariants 3, 10, 14, 16).
 *
 * The hybrid-search / cited-synthesis pipeline COMPOSES the already-frozen, already-tested
 * isolation chokepoints — it builds no new raw DB/vector arms. The load-bearing property
 * (invariant 3) is enforced upstream in `ScopedDB`: every id from a vector OR FTS arm is
 * re-checked + hydrated by `ScopedDB.getChunksByIds` / `hydrateChunks`, and a `Candidate`
 * is built ONLY from those returned rows — never from a raw `ScopedVectorize`/FTS id list
 * (which can carry a cross-tenant id BEFORE the re-check).
 *
 * Three seams decouple the pipeline from bindings so CI runs deterministic stubs:
 *   - `AiPort`     — `embed`/`gen`/`rerank` (satisfied by `ScopedServices.ai`).
 *   - `BudgetPort` — the `token_spend` 429 pre-check that runs BEFORE any AI call
 *                    (invariant 16); throws to 429 the request (a hard cap, NOT a degrade).
 *   - `RecallSink` — recall-trace writes the WORKER runs OFF the synchronous read path via
 *                    `ctx.waitUntil` (invariant 10); the handler hands traces over and never
 *                    blocks the response on the durable write.
 */
import type { Principal } from "@brain/shared"
import type { ScopedChunk, ScopedDB } from "../scoped/db"
import type { ScopedVectorize } from "../scoped/vectorize"

/** A rerank input row (mirrors `RerankCandidate` so `AiPort` needs no db import cycle). */
export interface AiRerankCandidate {
  text: string
}

/** A rerank result: which input candidate (`index`) and its rerank `score`. */
export interface AiRerankHit {
  index: number
  score: number
}

/**
 * The AI surface the pipeline depends on — the READ-path subset of `ScopedServices.ai`
 * (which structurally satisfies this; the extra `embedForIndex` is irrelevant here). All
 * three degrade (return `null` / identity order) instead of throwing on the read path
 * (invariant 14).
 */
export interface AiPort {
  /** `null` ⇒ vector arm degrades to keyword-only. */
  embed(texts: string[]): Promise<number[][] | null>
  /** `null` ⇒ `think` degrades to evidence-without-synthesis. */
  gen(prompt: string, system?: string): Promise<string | null>
  /** Degrades to identity (RRF) order on missing binding / malformed output. */
  rerank(query: string, candidates: AiRerankCandidate[], topK: number): Promise<AiRerankHit[]>
}

/**
 * The enforcing per-tenant cost cap (invariant 16). `check()` runs BEFORE any `embed()` /
 * `gen()` and THROWS a 429-bearing error when projected monthly spend would exceed
 * `MONTHLY_COST_CEILING_USD`. This is a hard cap that 429s the request — it is NOT the
 * degrade contract, and it is a separate injected port so the AI chokepoints keep their
 * never-throw guarantee. The concrete impl wires in Phase 2c.
 */
export interface BudgetPort {
  check(): Promise<void>
}

/** One recall-trace: a kept hit, keyed by the HYDRATED chunk id (never a raw match id). */
export interface RecallTrace {
  chunkId: string
  score: number
}

/** A batch of recall traces for one read op. */
export interface RecallTraceBatch {
  userId: string
  query: string
  hits: RecallTrace[]
}

/**
 * Sink for recall-trace writes (invariant 10). The handler calls `append(...)`; the worker
 * impl registers the durable D1 write on `ctx.waitUntil` and resolves immediately, so the
 * synchronous read path is never blocked on it. A no-op/recording stub is used in CI.
 */
export interface RecallSink {
  append(batch: RecallTraceBatch): Promise<void>
}

/** The per-request dependency bundle every search handler receives. */
export interface SearchDeps {
  db: ScopedDB
  vectors: ScopedVectorize
  ai: AiPort
  budget: BudgetPort
  recall: RecallSink
}

/**
 * A retrieval candidate AFTER the mandatory D1 re-check + hydration. Every field is sourced
 * from a `ScopedChunk` returned by `ScopedDB` — so a `Candidate` cannot carry a cross-tenant
 * id (invariant 3). `armScore` is the originating arm's raw score (cosine for the vector arm;
 * a synthetic descending rank score for the FTS bm25 arm — used only for arm-internal order).
 */
export interface Candidate {
  chunkId: string
  documentId: string
  slug: string
  title: string | null
  content: string
  chunkSource: string | null
  headingPath: string | null
  trustGrade: string
  sourceId: string | null
  embeddedAt: string | null
  embeddingModel: string
  updatedAt: string
  armScore: number
  /** Fact notability (D5), when the candidate is fact-bearing. Chunk candidates leave it undefined
   *  → the notability boost is inert for content search (a no-op multiplier). */
  notability?: string
}

/** Project a re-checked `ScopedChunk` into a ranked `Candidate` (the ONLY constructor). */
export const toCandidate = (row: ScopedChunk, armScore: number): Candidate => ({
  chunkId: row.id,
  documentId: row.documentId,
  slug: row.slug,
  title: row.title,
  content: row.content,
  chunkSource: row.chunkSource,
  headingPath: row.headingPath,
  trustGrade: row.trustGrade,
  sourceId: row.sourceId,
  embeddedAt: row.embeddedAt,
  embeddingModel: row.embeddingModel,
  updatedAt: row.updatedAt,
  armScore,
})

/**
 * A fused candidate carrying its normalized + boosted RRF `score`. This score — NOT the
 * reranker's (which is `0` whenever rerank degrades, the default path until `RUN_AI_GATES`)
 * — is the meaningful relevance number surfaced in evidence. The reranker only re-ORDERS
 * and selects `FusedCandidate`s; it never overwrites this score.
 */
export interface FusedCandidate {
  candidate: Candidate
  score: number
}

/** One evidence row in the `think` / search envelope (matches the frozen `SearchHitSchema`). */
export interface SearchHit {
  id: string
  documentId: string
  slug: string
  score: number
  snippet: string
}

/** The `think` envelope (matches the frozen `THINK_OP` output contract, §9.2). */
export interface ThinkResult {
  answer: string
  evidence: SearchHit[]
  citations: { slug: string; chunkId: string }[]
  gaps: string[]
  warnings: string[]
}

/** The `search` / `query` envelope (matches the frozen `SEARCH_OP` output contract). */
export interface SearchResult {
  hits: SearchHit[]
}

/** The context a bound op handler receives. */
export interface OpContext {
  deps: SearchDeps
  principal: Principal
}

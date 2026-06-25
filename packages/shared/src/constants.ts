/**
 * Model + algorithm + limit constants for The Brain (IMPLEMENTATION_PLAN
 * "Constants" + Stack, PRD §5 / §4). All `as const` so they are literal types,
 * importable by every package without drift.
 */

// ── Workers AI models (all behind embed()/gen()/rerank() chokepoints) ────────
/** Embedding model — LOCKED. A dim-changing swap is refused at `embed()`. */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3" as const
/** Embedding dimensions — LOCKED to 1024 (both Vectorize indexes). */
export const EMBEDDING_DIMS = 1024 as const
/** Cited-synthesis generation model. */
export const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const
/** Cross-encoder reranker. */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base" as const
/** KG / fact extraction model. */
export const EXTRACT_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const

// ── Hybrid-search / ranking algorithm constants (PRD §5) ─────────────────────
/** Reciprocal Rank Fusion constant. */
export const RRF_K = 60 as const
/** Minimum cosine similarity for a vector hit to count. */
export const COSINE_FLOOR = 0.5 as const
/** Minimum cosine similarity for "related" suggestions. */
export const RELATED_FLOOR = 0.85 as const
/** Multiplicative boost applied to title-matching hits. */
export const TITLE_BOOST = 1.25 as const
/** Candidate pool size carried into rerank. */
export const CANDIDATE_TOP = 40 as const
/** Top-k evidence kept by `think` after rerank. */
export const THINK_TOP_K = 12 as const

// ── Ingestion / batching constants (encode CF hard limits, PRD §4) ───────────
/** Chunk rows written per `db.batch` (respects the 100 bound-param cap). */
export const CHUNK_DB_BATCH_SIZE = 10 as const
/** Chunks embedded per Workers-AI batch call. */
export const EMBED_BATCH_SIZE = 50 as const
/** Documents processed per KG-extraction batch. */
export const KG_BATCH_SIZE = 5 as const
/** Hard ceiling on chunks produced from a single document. */
export const MAX_CHUNKS_PER_DOC = 4000 as const
/** Max body size accepted for ingestion (8 MiB). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Max raw body accepted by the `/ingest` webhook (256 KiB). */
export const INGEST_WEBHOOK_MAX_BYTES = 256 * 1024
/** Max length of the `markdown_preview` stored in D1 (bodies live in R2). */
export const MARKDOWN_PREVIEW_MAX = 2000 as const

// ── Synthesis / cost / Vectorize ceilings ────────────────────────────────────
/** Token budget guarding cited synthesis in `think`. */
export const SYNTHESIS_TOKEN_BUDGET = 20000 as const
/** App-level enforcing cost cap; the `token_spend` 429 pre-check trips on this. */
export const MONTHLY_COST_CEILING_USD = 400 as const
/** Vectorize V2 topK ceiling (per query, returning only {id,score}). */
export const VECTORIZE_TOPK_MAX = 100 as const

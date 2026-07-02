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
/** KG / fact extraction model. NOTE: @cf/meta/llama-3.1-8b-instruct was DEPRECATED by Cloudflare
 * on 2026-05-30 (AiError 5028), which silently broke KG extraction → an empty entity graph. Use the
 * current model that GENERATION_MODEL already proves working on Workers AI. */
export const EXTRACT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const
/**
 * Speech-to-text (voice memo transcription, W3.2) — behind the `transcribe()` chokepoint.
 * `whisper-large-v3-turbo` takes a BASE64 audio string (not the base model's `number[]` shape, which
 * builds a multi-million-element JS array and OOMs the 128 MB isolate on a real memo). Output shape:
 * `{ text, word_count, segments[], vtt, transcription_info }` (NO top-level `words[]`).
 */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo" as const

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
/**
 * Max audio body accepted by `POST /documents` for voice-memo transcription (W3.2). SEPARATE from
 * MAX_BODY_BYTES because audio is transcribed via base64 → whisper. Cap is memory-bound, not
 * request-bound: a base64 string is ~1.33× the bytes, and the AI Gateway serialization adds another
 * copy, so transient peak ≈ 3.7× the raw size on top of a ~20 MB worker baseline. At 12 MiB that is
 * ~64 MB — safe under the 128 MB isolate limit even with limited concurrency. This is a
 * conservative-pending-a-real-load-test value; the ONE place the cap is defined (api route, dashboard
 * guard, and copy all import it), so it can be raised toward 16 MiB (~79 MB) in a single edit.
 */
export const AUDIO_MAX_BYTES = 12 * 1024 * 1024
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

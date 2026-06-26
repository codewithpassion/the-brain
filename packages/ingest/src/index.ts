/**
 * `@brain/ingest` — the pure, deterministic document extraction + chunking layer
 * for The Brain (PRD §4). NO Cloudflare runtime dependencies: every function
 * here is platform-neutral and heavily unit-tested. The Batch-Ingest Workflow
 * (Phase 2c) composes these into the durable, tenant-scoped write path.
 */

// ── Chunking (heading-aware paragraph / sentence-aware sliding) + part planning ──
export type { Chunk, ChunkOptions, ChunkPart, ChunkStrategy, PlanPartsOptions } from "./chunk"
export {
  CHUNK_TARGET,
  chunkDocument,
  planParts,
  SLIDING_MAX_TOKENS,
  SLIDING_OVERLAP,
} from "./chunk"
export type { DedupGateInput, DedupKey } from "./dedup"
// ── Fingerprint-based dedup gate ─────────────────────────────────────────────
export { dedupGate } from "./dedup"
// ── Content fingerprint (dedup key basis, invariant 15) ──────────────────────
export { fingerprint, normalizeForFingerprint, workflowInstanceId } from "./fingerprint"
// ── Extraction to markdown + D1 preview ──────────────────────────────────────
export { markdownPreview, toMarkdown, UnsupportedContentTypeError } from "./markdown"
// ── Input text normalization ─────────────────────────────────────────────────
export { normalize } from "./normalize"
// ── Session-export importers (ChatGPT + Claude-Code, §4.7.1) ──────────────────
export * from "./sources"

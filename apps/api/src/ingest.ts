/**
 * `runBatchIngest` — the platform-neutral document ingestion pipeline (PRD §4, the
 * "first vertical slice" Phase 2c). It is a PLAIN async function over the tenant-scoped
 * `ScopedServices` bundle — deliberately NOT bound to the Cloudflare Workflows runtime
 * (which has no local emulation), so the e2e slice test drives it directly against real
 * workerd D1 + R2. The deploy-time `BatchIngestWorkflow` (workflow.ts) wraps it across
 * durable `step.do()` boundaries.
 *
 * Steps (each composes a FROZEN chokepoint — no raw binding is ever touched here):
 *   1. status → `processing`.
 *   2. extract → markdown: passthrough+normalize for `text/markdown|text/plain`
 *      (`toMarkdown`); a clearly-marked TODO hook for binary/HTML via `ai.toMarkdown`
 *      (the CF document converter) is deferred — the slice accepts text only.
 *   3. chunk (`chunkDocument`) + part plan (`planParts`, §4.3 split-on-chunk-boundary).
 *   4. insert chunks (`ScopedDB.insertChunks`, batched@10, FTS via DB triggers).
 *   5. embed in batches of `EMBED_BATCH_SIZE` (50) via the WRITE-path `ai.embedForIndex`
 *      (THROWS on failure → the real Workflow step retries; we never index un-embedded
 *      chunks, invariant 14) → `ScopedVectorize.upsert` (namespace=tenant baked in) →
 *      mark the chunk embedded.
 *   6. KG extraction — a marked NO-OP/TODO (Phase 4; the slice does not need the graph).
 *   7. finalize → `indexed` (+ markdown_preview, chunk_count; invariant 13: D1 holds the
 *      preview only, the body stays in R2).
 *
 * CAP-SAFE HAND-OFFS: the pipeline takes R2 *references* (`r2Key` + `documentId`), never an
 * inline body, and reads/writes bodies through `ScopedR2` itself. So when the future
 * Workflow wrapper splits this across `step.do()` boundaries, no step output (the small
 * `BatchIngestResult` summary, or an R2 key) approaches the 1 MiB step-output cap — the body
 * never crosses a step boundary.
 *
 * IDEMPOTENCY/DEDUP: the durable dedup rests on the `(tenant_id, scope, fingerprint)` UNIQUE
 * index on `documents` (invariant 15), enforced at INSERT time by the `/ingest` route (which
 * catches the conflict → "already ingested"). This function runs only after a fresh
 * `documents` row exists, and uses deterministic chunk ids so a retry replaces, never
 * duplicates.
 */
import {
  type BatchIngestParams,
  type BatchIngestResult,
  runBatchIngestCore,
  type ScopedServices,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { runEntityExtraction } from "./entity-extraction"

export type { BatchIngestParams, BatchIngestResult }

/** The serializable payload the deploy-time `BatchIngestWorkflow` carries (workflow.ts). */
export interface BatchIngestWorkflowParams {
  /** The resolved tenant principal (plain serializable object) the run is scoped to. */
  principal: Principal
  /** The per-document ingestion references. */
  ingest: BatchIngestParams
}

/**
 * Full ingest pipeline = `runBatchIngestCore` (steps 1–6: chunk + embed + finalize) + KG entity
 * extraction (Phase 4, non-fatal). The core lives in `@brain/db` so the surface catalog can call
 * it for the MCP/CLI inline path without needing `cloudflare:workers` from `runEntityExtraction`.
 */
export const runBatchIngest = async (
  services: ScopedServices,
  params: BatchIngestParams,
): Promise<BatchIngestResult> => {
  const result = await runBatchIngestCore(services, params)

  // KG extraction (Phase 4). NON-FATAL: a failure never fails ingest — the doc is indexed
  // regardless. At deploy the durable EntityExtractionWorkflow wraps this across step.do() boundaries.
  if (result.status !== "failed") {
    await runEntityExtraction(services, params.documentId).catch(() => undefined)
  }

  return result
}

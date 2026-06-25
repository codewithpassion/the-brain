/**
 * The `brain-backfill` / `brain-reembed` Queue message shapes (PRD §8.6/§8.7).
 *
 * REFERENCES-ONLY (invariant: Workflow 1 MiB step-output cap): a message carries ids/keys —
 * `payloadRef` is the tenant-relative R2 key of the staged body/session JSON, NEVER the payload
 * inline. The consumer reads the body from R2 itself. Every message carries the explicit
 * `tenant_id` the consumer validates against a real `orgs` row (invariant 18) before any work.
 */

/** A `brain-backfill` message — one enumerated item (a doc body or a session transcript). */
export interface BackfillMessage {
  tenantId: string
  sourceId: string
  /** The enumerator-run row this item belongs to (`backfill_runs.id`). */
  runId: string
  /** `doc` → document ingest path; `session` → importer→capture path. */
  kind: "doc" | "session"
  /** Tenant-relative R2 key of the staged body (doc) or `ImportedSession` JSON (session). */
  payloadRef: string
  /** Per-item content fingerprint — the deterministic-id basis for idempotent dedup. */
  fingerprint: string
  /** Content type for the `doc` path (decides extraction/chunking); ignored for `session`. */
  contentType?: string
  /** Optional authorship; absent ⇒ the consumer builds a SYSTEM principal for the tenant. */
  userId?: string
}

/** A `brain-reembed` message — one stale chunk to re-embed to its SAME vector id (§8.7). */
export interface ReembedMessage {
  tenantId: string
  /** The chunk id == the Vectorize id re-upserted in place (invariant 12). */
  chunkId: string
  /** The migration `backfill_runs.id` the cost is recorded into. */
  runId: string
  userId?: string
}

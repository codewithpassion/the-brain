import { fingerprint } from "./fingerprint"

/**
 * Fingerprint-based dedup gate (PRD §4.2 / §4.10, invariant 15).
 *
 * This helper computes the content fingerprint and assembles the key tuple the
 * Batch-Ingest Workflow (Phase 2c) checks against the `(tenant_id, scope,
 * fingerprint)` UNIQUE index on `documents` — the DURABLE dedup backstop. The
 * actual D1 existence check (and the skip-unchanged decision) is the workflow's
 * job; this layer only provides the deterministic fingerprint + the exact key
 * shape so the two cannot drift. It performs NO I/O and imports no DB/bindings.
 */

/** The dedup key tuple matching the `documents` UNIQUE `(tenant_id, scope, fingerprint)` index. */
export interface DedupKey {
  tenantId: string
  /** `null` when the document has no scope sub-partition (the index column is nullable). */
  scope: string | null
  fingerprint: string
}

export interface DedupGateInput {
  tenantId: string
  scope?: string
  /** The extracted/normalized markdown body the fingerprint is computed over. */
  content: string
}

/** Compute the dedup key tuple for a candidate document body. */
export const dedupGate = async (input: DedupGateInput): Promise<DedupKey> => ({
  tenantId: input.tenantId,
  scope: input.scope ?? null,
  fingerprint: await fingerprint(input.content),
})

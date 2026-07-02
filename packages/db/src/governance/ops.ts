/**
 * Governance op CONTRACTS + coordination logic (PRD §7.5/§7.6, §9.0.2).
 *
 * `memory_review` (the ONLY path to `instruction`), `break_glass_read` (the audited exception),
 * and `audit_export` (append-only `memory_audit` → R2 ndjson). Contracts are handler-free and
 * registered into the shared registry; the fns COMPOSE the tenant-scoped `SessionServices`.
 */
import { type AnyOpDef, defineOp, type OpRegistry } from "@brain/shared"
import { z } from "zod"
import type { ScopedChunk } from "../scoped/db"
import type { SessionServices } from "../sessions/services"
import type { BreakGlassFact, PendingDreamReview } from "./store"

// ── Op contracts ──────────────────────────────────────────────────────────────────

/** `memory_review` — human-confirmed promotion (the ONLY path to `instruction`). */
export const MEMORY_REVIEW_OP = defineOp({
  name: "memory_review",
  description:
    "Human review of a hot-memory fact. A confirmed review promotes its trust_grade to 'instruction' — the only path to that grade. " +
    "Use in moderation workflows when a fact needs verification before becoming a persistent instruction.",
  capability: "write",
  readOnly: false,
  input: z.object({
    factId: z.number().int().describe("The integer fact id from a recall result."),
    status: z.enum(["confirmed", "rejected", "needs_revision"]).default("confirmed"),
    note: z.string().optional(),
  }),
  output: z.object({ factId: z.number(), status: z.string() }),
})

/** `break_glass_read` — admin-only audited read of another user's private memory (fails closed). */
export const BREAK_GLASS_READ_OP = defineOp({
  name: "break_glass_read",
  description:
    "Admin-only emergency read of other users' private chunks and facts. Every invocation is audited and alerted; fails closed for non-admins. " +
    "Only use when normal visibility rules block access you have documented grounds to override.",
  capability: "admin",
  readOnly: true,
  input: z.object({
    reason: z
      .string()
      .min(1)
      .describe("Documented justification for the emergency access, written to the audit log."),
    chunkIds: z
      .array(z.string())
      .default([])
      .describe("Chunk ids to read (from search hit 'id' fields)."),
    factIds: z
      .array(z.number().int())
      .default([])
      .describe("Fact ids to read (from recall 'id' fields)."),
  }),
  output: z.object({
    chunks: z.array(z.object({ id: z.string(), content: z.string() })),
    facts: z.array(z.object({ id: z.number(), fact: z.string() })),
  }),
})

/** `audit_export` — append-only export of new `memory_audit` rows to R2 ndjson (admin-only). */
export const AUDIT_EXPORT_OP = defineOp({
  name: "audit_export",
  description:
    "Export new memory audit rows since a cursor to a tamper-evident R2 ndjson file and return the new cursor. " +
    "Exported files are never rewritten (append-only). Use on a recurring schedule to maintain an immutable audit trail.",
  capability: "admin",
  readOnly: true,
  surfaces: ["rest", "cli"],
  input: z.object({
    cursor: z
      .number()
      .int()
      .default(0)
      .describe(
        "Epoch-ms cursor from the last export (0 for first run). Persist the returned cursor for the next call.",
      ),
  }),
  output: z.object({ r2Key: z.string().nullable(), exported: z.number(), cursor: z.number() }),
})

/** `list_pending_reviews` — the Dream engine's pending contradictions for the Dreams screen. */
export const LIST_PENDING_REVIEWS_OP = defineOp({
  name: "list_pending_reviews",
  description:
    "List Dream-engine contradictions awaiting human review, each with its two conflicting facts. " +
    "Use to populate a review queue and resolve them with resolve_contradiction.",
  capability: "read",
  readOnly: true,
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50).describe("Max reviews to return (1–200)."),
  }),
  output: z.object({
    reviews: z.array(
      z.object({
        reviewId: z.string(),
        rationale: z.string(),
        reviewedAt: z.string(),
        facts: z.array(z.object({ id: z.number(), fact: z.string() })),
        redactedCount: z.number().int(),
      }),
    ),
  }),
})

/** `resolve_contradiction` — keep one fact (expiring the rest) or dismiss a Dream contradiction. */
export const RESOLVE_CONTRADICTION_OP = defineOp({
  name: "resolve_contradiction",
  description:
    "Resolve a Dream contradiction: action 'keep' expires every OTHER fact in the contradiction " +
    "(keepFactId survives); action 'dismiss' rejects the review without changing facts. Requires " +
    "owner/admin (or a member within the facts' scopes).",
  capability: "write",
  readOnly: false,
  input: z.object({
    reviewId: z.string().min(1).describe("The review id from list_pending_reviews."),
    action: z
      .enum(["keep", "dismiss"])
      .describe("'keep' one fact (expire the rest), or 'dismiss'."),
    keepFactId: z
      .number()
      .int()
      .optional()
      .describe(
        "Required for action='keep': the fact to KEEP (must be one of the contradiction's).",
      ),
  }),
  output: z.object({ reviewId: z.string(), status: z.string() }),
})

/** Every governance op CONTRACT. */
export const GOVERNANCE_OPS: readonly AnyOpDef[] = [
  MEMORY_REVIEW_OP,
  BREAK_GLASS_READ_OP,
  AUDIT_EXPORT_OP,
  LIST_PENDING_REVIEWS_OP,
  RESOLVE_CONTRADICTION_OP,
]

/** Register the governance op contracts into a shared `OpRegistry`. */
export const registerGovernanceOps = (registry: OpRegistry): OpRegistry => {
  for (const op of GOVERNANCE_OPS) registry.register(op)
  return registry
}

// ── Coordination logic ─────────────────────────────────────────────────────────────

/** Promote a fact via human review (the ONLY path to `instruction`). */
export const submitMemoryReview = async (
  services: SessionServices,
  factId: number,
  review: { status?: "confirmed" | "rejected" | "needs_revision"; note?: string },
): Promise<void> => {
  await services.governance.memoryReview(factId, review)
}

/** List the Dream engine's pending contradictions (with hydrated conflicting facts). */
export const listPendingReviews = (
  services: SessionServices,
  limit?: number,
): Promise<PendingDreamReview[]> => services.governance.listPendingDreamReviews(limit)

/** Keep one fact (expiring the rest) or dismiss a Dream contradiction. */
export const resolveContradiction = async (
  services: SessionServices,
  req: { reviewId: string; action: "keep" | "dismiss"; keepFactId?: number },
): Promise<{ reviewId: string; status: "confirmed" | "rejected" }> => {
  if (req.action === "keep") {
    if (req.keepFactId === undefined) {
      throw new Error("resolve_contradiction: keepFactId is required for action 'keep'")
    }
    await services.governance.resolveContradiction(req.reviewId, {
      action: "keep",
      keepFactId: req.keepFactId,
    })
    return { reviewId: req.reviewId, status: "confirmed" }
  }
  await services.governance.resolveContradiction(req.reviewId, { action: "dismiss" })
  return { reviewId: req.reviewId, status: "rejected" }
}

/** A break-glass read result (private chunks AND facts the actor would not normally see). */
export interface BreakGlassReadResult {
  chunks: ScopedChunk[]
  facts: BreakGlassFact[]
}

/**
 * Admin-only break-glass read over private CONTENT (§7.6). Chunks route through the frozen
 * `ScopedDB.breakGlass`; facts through `GovernanceStore.breakGlassFacts`. BOTH share the same
 * injected `BreakGlassAudit` sink, so each invocation is audited + alerted; a non-admin (or a
 * missing sink) fails CLOSED before any private row is read. tenant_id is never bypassed.
 */
export const breakGlassRead = async (
  services: SessionServices,
  req: { reason: string; chunkIds?: string[]; factIds?: number[] },
): Promise<BreakGlassReadResult> => {
  const chunkIds = req.chunkIds ?? []
  const factIds = req.factIds ?? []
  const chunks = chunkIds.length > 0 ? await services.db.breakGlass(chunkIds, req.reason) : []
  const facts =
    factIds.length > 0 ? await services.governance.breakGlassFacts(factIds, req.reason) : []
  return { chunks, facts }
}

/**
 * Export new `memory_audit` rows since `cursor` to a tamper-evident R2 ndjson object (§7.6 SC7).
 * The key is timestamped (`audit/${window}/${exportedAt}.ndjson`) and NEVER rewritten, so the
 * durable export stays append-only even if a future bug mutated the live table. Returns the new
 * cursor (max `at` exported) the caller persists for the next sweep.
 */
export const auditExport = async (
  services: SessionServices,
  cursor: number,
  exportedAt: string = new Date().toISOString(),
): Promise<{ r2Key: string | null; exported: number; cursor: number }> => {
  const rows = await services.governance.readAuditSince(cursor)
  if (rows.length === 0) return { r2Key: null, exported: 0, cursor }
  const ndjson = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  const window = exportedAt.slice(0, 7) // YYYY-MM
  const r2Key = `audit/${window}/${exportedAt}.ndjson`
  await services.blobs.put(r2Key, ndjson)
  const last = rows[rows.length - 1]
  return { r2Key, exported: rows.length, cursor: last?.at ?? cursor }
}

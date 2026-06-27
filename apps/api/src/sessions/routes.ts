/**
 * Session + governance route HANDLERS (PRD §8.2/§8.4/§7.5/§7.6) — exported fns the orchestrator
 * mounts under auth + scoped-services construction. Each COMPOSES the `@brain/db` ops; none
 * touches a raw binding. The orchestrator owns Hono wiring (parse, 4xx, `executionCtx`).
 */

import {
  auditExport,
  type BreakGlassReadResult,
  breakGlassRead,
  type CaptureTurnRequest,
  type CaptureTurnResult,
  captureTurn,
  createSessionServices,
  forgetFact,
  getSessionContext,
  type RecallRequest,
  recall,
  runSessionPromote,
  type SessionContext,
  type SessionServices,
  submitMemoryReview,
} from "@brain/db"
import { workflowInstanceId } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import type { SessionBindings } from "./bindings"
import type { SessionPromoteWorkflowParams } from "./workflow"

/** `capture_turn` — append a live turn (D1 lean row + R2 transcript). */
export const handleCaptureTurn = (
  services: SessionServices,
  input: CaptureTurnRequest,
): Promise<CaptureTurnResult> => captureTurn(services, input)

export interface FinalizeOptions {
  /** Run `runSessionPromote` inline (local/test) instead of dispatching the durable workflow. */
  inline?: boolean
}

/**
 * `finalize_session` — the Stop-hook: mark the session `finalizing`, then trigger
 * `SessionPromoteWorkflow` with the deterministic id `promote-${tenantId}-${sessionId}` (a
 * duplicate Stop-hook is a no-op). Dispatches the durable workflow at deploy; runs inline in
 * local/test. The promote workflow flips the session to `promoted`.
 */
export const handleFinalizeSession = async (
  env: SessionBindings,
  services: SessionServices,
  principal: Principal,
  brainSessionId: string,
  options: FinalizeOptions = {},
): Promise<{ brainSessionId: string; status: string }> => {
  const session = await services.sessions.getSession(brainSessionId)
  if (session === null) throw new Error("finalize: session not found in tenant")
  await services.sessions.finalizeSession(brainSessionId)
  const promote = {
    sessionId: brainSessionId,
    userId: session.userId,
    scope: session.scope,
    teamId: session.teamId,
  }
  const workflow = options.inline ? undefined : env.SESSION_PROMOTE
  if (workflow) {
    const params: SessionPromoteWorkflowParams = { principal, promote }
    await workflow.create({
      id: await workflowInstanceId(`promote-${principal.tenantId}-${brainSessionId}`),
      params,
    })
  } else {
    await runSessionPromote(services, promote)
  }
  return { brainSessionId, status: "finalizing" }
}

/** `get_session_context` — recent turns + visible hot-memory facts + (optional) OKF memory by path. */
export const handleGetSessionContext = (
  services: SessionServices,
  input: {
    brainSessionId: string
    snapshotId?: string
    memoryPath?: string
    memoryPrefix?: boolean
  },
): Promise<SessionContext> =>
  getSessionContext(services, input.brainSessionId, input.snapshotId, {
    prefix: input.memoryPrefix ?? false,
    ...(input.memoryPath !== undefined ? { path: input.memoryPath } : {}),
  })

/**
 * `recall` — hot-memory recall (visibility-gated). Writes one `memory_recall_trace` per kept hit
 * OFF the synchronous read path via `waitUntil` (invariant 10): a non-empty result dispatches the
 * durable append; zero hits write zero traces.
 */
export const handleRecall = async (
  services: SessionServices,
  input: RecallRequest,
  waitUntil: (promise: Promise<unknown>) => void,
  clientId: string,
): Promise<{ facts: { id: number; fact: string; kind: string }[] }> => {
  const facts = await recall(services, input)
  if (facts.length > 0) {
    const query = input.query ?? input.grep ?? input.entitySlug ?? "recall"
    const traces = facts.map((f, i) => ({
      query,
      targetId: String(f.id),
      score: 1 - i / facts.length,
      clientId,
    }))
    waitUntil(services.db.appendRecallTraces(traces))
  }
  return { facts: facts.map((f) => ({ id: f.id, fact: f.fact, kind: f.kind })) }
}

/** `forget_fact` — soft-expire a fact. */
export const handleForgetFact = async (
  services: SessionServices,
  factId: number,
): Promise<{ factId: number; forgotten: boolean }> => {
  await forgetFact(services, factId)
  return { factId, forgotten: true }
}

/** `memory_review` — the ONLY path to `instruction` (human-confirmed). */
export const handleMemoryReview = async (
  services: SessionServices,
  input: { factId: number; status?: "confirmed" | "rejected" | "needs_revision"; note?: string },
): Promise<{ factId: number; status: string }> => {
  await submitMemoryReview(services, input.factId, {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  })
  return { factId: input.factId, status: input.status ?? "confirmed" }
}

/** `break_glass_read` — admin-only audited read of private content (fails closed). */
export const handleBreakGlassRead = (
  services: SessionServices,
  input: { reason: string; chunkIds?: string[]; factIds?: number[] },
): Promise<BreakGlassReadResult> => breakGlassRead(services, input)

/** `audit_export` — export new audit rows to tamper-evident R2 ndjson (admin-only). */
export const handleAuditExport = (
  services: SessionServices,
  input: { cursor: number },
): Promise<{ r2Key: string | null; exported: number; cursor: number }> =>
  auditExport(services, input.cursor)

/** Build the session/governance services for a request (re-exported for the orchestrator). */
export const sessionServicesFor = createSessionServices

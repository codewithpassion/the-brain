/**
 * Session + hot-memory op CONTRACTS and their coordination logic (PRD §8.2/§8.4/§8.5, §9.0.2).
 *
 * Like `search/ops.ts`, this holds the FROZEN handler-free `OpDef` contracts (so MCP/tRPC/CLI
 * cannot drift) PLUS the testable coordination fns the apps/api route handlers + workflows
 * mount. The fns COMPOSE the tenant-scoped `SessionServices` — no raw binding is ever touched.
 */
import { type AnyOpDef, defineOp, type OpRegistry } from "@brain/shared"
import { z } from "zod"
import type { SessionServices } from "./services"
import { type CaptureTurnResult, type RecalledFact, transcriptKey } from "./store"

// ── Op contracts (handler-free; registered into the shared registry) ──────────────

/** `capture_turn` — append one live turn (write scope, honors `read_only`). */
export const CAPTURE_TURN_OP = defineOp({
  name: "capture_turn",
  description: "Append one session turn (refreshes last_activity_at; offloads long turns to R2).",
  capability: "write",
  readOnly: false,
  input: z.object({
    sessionId: z.string().min(1),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    client: z.enum(["claude-code", "claude-desktop", "chatgpt", "cli", "web", "import"]),
    scope: z.string().optional(),
    teamId: z.string().optional(),
    visibility: z.enum(["private", "team", "world"]).optional(),
    title: z.string().optional(),
  }),
  output: z.object({ brainSessionId: z.string(), idx: z.number(), offloaded: z.boolean() }),
})

/** `finalize_session` — the stop-hook: mark finalizing + trigger `SessionPromoteWorkflow`. */
export const FINALIZE_SESSION_OP = defineOp({
  name: "finalize_session",
  description: "Close a session (status=finalizing) and trigger the promote-to-fact workflow.",
  capability: "write",
  readOnly: false,
  input: z.object({ brainSessionId: z.string().min(1) }),
  output: z.object({ brainSessionId: z.string(), status: z.string() }),
})

/** `get_session_context` — the SessionStart projection (snapshot DEFERRED → live state). */
export const GET_SESSION_CONTEXT_OP = defineOp({
  name: "get_session_context",
  description: "Return the brain context for a session (recent turns + visible hot-memory facts).",
  capability: "read",
  readOnly: true,
  input: z.object({ brainSessionId: z.string().min(1), snapshotId: z.string().optional() }),
  output: z.object({
    turns: z.array(z.object({ idx: z.number(), role: z.string(), content: z.string().nullable() })),
    facts: z.array(z.object({ id: z.number(), fact: z.string(), kind: z.string() })),
    snapshotStubbed: z.boolean(),
  }),
})

/** `recall` — hot-memory recall by entity / since / session / grep / keyword (visibility-gated). */
export const RECALL_OP = defineOp({
  name: "recall",
  description: "Recall hot-memory facts (entity/since/session/grep/keyword), newest-first.",
  capability: "read",
  readOnly: true,
  input: z.object({
    entitySlug: z.string().optional(),
    since: z.string().optional(),
    sessionId: z.string().optional(),
    grep: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    facts: z.array(z.object({ id: z.number(), fact: z.string(), kind: z.string() })),
  }),
})

/** `forget_fact` — soft-expire a fact (never a hard delete). */
export const FORGET_FACT_OP = defineOp({
  name: "forget_fact",
  description: "Soft-expire a hot-memory fact (sets expired_at; preserves lineage).",
  capability: "write",
  readOnly: false,
  input: z.object({ factId: z.number().int() }),
  output: z.object({ factId: z.number(), forgotten: z.boolean() }),
})

/** Every session op CONTRACT (registered handler-free, mirroring `SEARCH_OPS`). */
export const SESSION_OPS: readonly AnyOpDef[] = [
  CAPTURE_TURN_OP,
  FINALIZE_SESSION_OP,
  GET_SESSION_CONTEXT_OP,
  RECALL_OP,
  FORGET_FACT_OP,
]

/** Register the session op contracts into a shared `OpRegistry` (handlers bind in the Worker). */
export const registerSessionOps = (registry: OpRegistry): OpRegistry => {
  for (const op of SESSION_OPS) registry.register(op)
  return registry
}

// ── Coordination logic (the testable fns the apps/api handlers + cron mount) ──────

/** `capture_turn` input as the route handler parses it. */
export interface CaptureTurnRequest {
  sessionId: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  client: string
  scope?: string | null
  teamId?: string | null
  visibility?: string
  title?: string | null
}

/**
 * Capture one turn: write the lean D1 turn (`SessionStore.captureTurn`, one `db.batch`), THEN
 * append the full turn to the R2 transcript (`${tenantId}/sessions/${id}.jsonl`) so the body
 * lives only in R2 (invariant 13). The transcript is read-modify-write appended (single-writer
 * per session in v1). Returns the brain session id + turn idx.
 */
export const captureTurn = async (
  services: SessionServices,
  req: CaptureTurnRequest,
): Promise<CaptureTurnResult> => {
  const result = await services.sessions.captureTurn({
    sessionId: req.sessionId,
    role: req.role,
    content: req.content,
    client: req.client,
    ...(req.scope != null ? { scope: req.scope } : {}),
    ...(req.teamId != null ? { teamId: req.teamId } : {}),
    ...(req.visibility !== undefined ? { visibility: req.visibility } : {}),
    ...(req.title != null ? { title: req.title } : {}),
  })
  const key = transcriptKey(result.brainSessionId)
  const existing = await services.blobs.get(key)
  const prior = existing === null ? "" : await existing.text()
  const line = `${JSON.stringify({ role: req.role, content: req.content, idx: result.idx })}\n`
  await services.blobs.put(key, `${prior}${line}`)
  return result
}

/** The `get_session_context` projection (snapshot DEFERRED — live state, snapshot stubbed). */
export interface SessionContext {
  turns: { idx: number; role: string; content: string | null }[]
  facts: { id: number; fact: string; kind: string }[]
  snapshotStubbed: boolean
}

/**
 * Return the brain context for a session: the recent turns + the visible hot-memory facts for
 * the session (recall is visibility-gated through `SessionStore`). `snapshotId` is ACCEPTED but
 * DEFERRED (§8.5): live state is returned and `snapshotStubbed` is set true when one was asked
 * for, so the caller knows the frozen view is not yet wired.
 */
export const getSessionContext = async (
  services: SessionServices,
  brainSessionId: string,
  snapshotId?: string,
): Promise<SessionContext> => {
  const turns = await services.sessions.recentTurns(brainSessionId)
  const facts = await services.sessions.recall({ sessionId: brainSessionId, limit: 50 })
  return {
    turns: turns.map((t) => ({ idx: t.idx, role: t.role, content: t.content })),
    facts: facts.map((f) => ({ id: f.id, fact: f.fact, kind: f.kind })),
    snapshotStubbed: snapshotId !== undefined,
  }
}

/** A recall request as the route handler parses it. */
export interface RecallRequest {
  entitySlug?: string
  since?: string
  sessionId?: string
  grep?: string
  /** Keyword query — routed through the `facts_fts` JOIN-back (`ScopedDB.ftsFactIds`). */
  query?: string
  limit?: number
}

/**
 * Recall hot memory (§8.4). A keyword `query` routes through `ScopedDB.ftsFactIds` (the
 * `facts_fts` JOIN-back re-check) + `SessionStore.hydrateFacts`; every other dispatch goes
 * through `SessionStore.recall`. BOTH apply the SHARED visibility predicate, so a non-author
 * never recalls another user's `private` fact. The caller writes one recall trace per kept hit
 * OFF the read path (invariant 10).
 */
export const recall = async (
  services: SessionServices,
  req: RecallRequest,
): Promise<RecalledFact[]> => {
  const limit = req.limit ?? 50
  if (req.query !== undefined && req.query.trim().length > 0) {
    const ids = await services.db.ftsFactIds(req.query, limit)
    return services.sessions.hydrateFacts(ids)
  }
  return services.sessions.recall({
    limit,
    ...(req.entitySlug !== undefined ? { entitySlug: req.entitySlug } : {}),
    ...(req.since !== undefined ? { since: req.since } : {}),
    ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
    ...(req.grep !== undefined ? { grep: req.grep } : {}),
  })
}

/** Soft-expire a fact (`forget_fact`). */
export const forgetFact = async (services: SessionServices, factId: number): Promise<void> => {
  await services.sessions.forgetFact(factId)
}

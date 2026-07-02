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
import {
  type CaptureTurnResult,
  type PinnedPage,
  type RecalledFact,
  type SnapshotRow,
  transcriptKey,
} from "./store"

// ── Op contracts (handler-free; registered into the shared registry) ──────────────

/** `capture_turn` — append one live turn (write scope, honors `read_only`). */
export const CAPTURE_TURN_OP = defineOp({
  name: "capture_turn",
  description:
    "Append one conversation turn to a session and refresh its last_activity timestamp. " +
    "Long turn bodies are offloaded to object storage. Call at every turn to build a searchable session transcript.",
  capability: "write",
  readOnly: false,
  input: z.object({
    sessionId: z
      .string()
      .min(1)
      .describe("Client-side session id (becomes the Brain session key on first turn)."),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    client: z.enum(["claude-code", "claude-desktop", "chatgpt", "cli", "web", "import"]),
    scope: z.string().optional(),
    teamId: z.string().optional(),
    visibility: z
      .enum(["private", "team", "world"])
      .optional()
      .describe("'world' (whole tenant) | 'team' | 'private' (you only). Default private."),
    title: z.string().optional(),
  }),
  output: z.object({ brainSessionId: z.string(), idx: z.number(), offloaded: z.boolean() }),
})

/** `finalize_session` — the stop-hook: mark finalizing + trigger `SessionPromoteWorkflow`. */
export const FINALIZE_SESSION_OP = defineOp({
  name: "finalize_session",
  description:
    "Close a session (marks it 'finalizing') and trigger async promotion of session observations to hot-memory facts. " +
    "Call at session end (e.g. stop-hook) to persist key observations for future recall.",
  capability: "write",
  readOnly: false,
  input: z.object({
    brainSessionId: z
      .string()
      .min(1)
      .describe("The Brain session id returned by capture_turn, not the client sessionId."),
  }),
  output: z.object({ brainSessionId: z.string(), status: z.string() }),
})

/** `get_session_context` — the SessionStart projection; resolves pinned snapshots. */
export const GET_SESSION_CONTEXT_OP = defineOp({
  name: "get_session_context",
  description:
    "Load context for a session at startup: recent turns, visible hot-memory facts, and optionally " +
    "memory pages under a path or a pinned snapshot's immutable page versions. Call in SessionStart to inject prior context.",
  capability: "read",
  readOnly: true,
  input: z.object({
    brainSessionId: z.string().min(1).describe("The Brain session id returned by capture_turn."),
    snapshotId: z
      .string()
      .optional()
      .describe(
        "Snapshot id from list_snapshots; loads pinned immutable page versions instead of live content.",
      ),
    memoryPath: z
      .string()
      .optional()
      .describe("Namespace to load memory items from at session start, e.g. 'agent/planner'."),
    memoryPrefix: z
      .boolean()
      .default(false)
      .describe("false = direct children of memoryPath only; true = full subtree."),
  }),
  output: z.object({
    turns: z.array(z.object({ idx: z.number(), role: z.string(), content: z.string().nullable() })),
    facts: z.array(z.object({ id: z.number(), fact: z.string(), kind: z.string() })),
    snapshotStubbed: z.boolean(),
    pinnedPages: z
      .array(
        z.object({
          pageVersionId: z.string(),
          pageId: z.string(),
          compiledTruth: z.string(),
          frontmatter: z.string(),
          snapshotAt: z.string(),
        }),
      )
      .optional(),
    memories: z
      .array(
        z.object({
          slug: z.string(),
          type: z.string(),
          title: z.string(),
          body: z.string(),
          version: z.number(),
        }),
      )
      .optional(),
  }),
})

/** `create_snapshot` — pin the current page versions into an immutable brain snapshot. */
export const CREATE_SNAPSHOT_OP = defineOp({
  name: "create_snapshot",
  description:
    "Pin the current memory page-versions into an immutable, named snapshot you can later load by id for reproducible context. " +
    "Use before a context-sensitive task you may need to replay.",
  capability: "write",
  readOnly: false,
  input: z.object({
    label: z
      .string()
      .min(1)
      .describe("Human-readable name for this snapshot, e.g. 'pre-refactor-2026-06'."),
    scope: z.string().optional(),
  }),
  output: z.object({ snapshotId: z.string() }),
})

/** `list_snapshots` — list brain snapshots for the tenant, newest-first. */
export const LIST_SNAPSHOTS_OP = defineOp({
  name: "list_snapshots",
  description:
    "List saved memory snapshots newest-first. Each snapshotId can be passed to get_session_context to reload a pinned context.",
  capability: "read",
  readOnly: true,
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max snapshots to return (1–200, default 50)."),
  }),
  output: z.object({
    snapshots: z.array(
      z.object({
        id: z.string(),
        scope: z.string().nullable(),
        label: z.string(),
        createdBy: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
})

/** `recall` — hot-memory recall by entity / since / session / grep / keyword (visibility-gated). */
export const RECALL_OP = defineOp({
  name: "recall",
  description:
    "Recall hot-memory facts about the user/world, newest-first. Filter by entity, since-date, session, or keyword/grep. " +
    "Use for 'what do I know about X'; use search/think for document content.",
  capability: "read",
  readOnly: true,
  input: z.object({
    entitySlug: z.string().optional().describe("Filter to facts linked to this entity slug."),
    since: z
      .string()
      .optional()
      .describe("ISO 8601 datetime; return only facts observed after this timestamp."),
    sessionId: z
      .string()
      .optional()
      .describe("Filter to facts extracted from this specific session."),
    grep: z.string().optional().describe("Substring filter applied to the fact text."),
    query: z
      .string()
      .optional()
      .describe("Keyword search over facts via full-text index (alternative to grep)."),
    includeSuperseded: z
      .boolean()
      .default(false)
      .describe(
        "Include facts the Dream engine superseded or consolidated (hidden by default). Set true to see lineage.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max facts to return (1–200, default 50)."),
  }),
  output: z.object({
    facts: z.array(
      z.object({
        id: z.number(),
        fact: z.string(),
        kind: z.string(),
        supersededBy: z.number().nullable(),
        consolidatedInto: z.number().nullable(),
      }),
    ),
  }),
})

/** `forget_fact` — soft-expire a fact (never a hard delete). */
export const FORGET_FACT_OP = defineOp({
  name: "forget_fact",
  description:
    "Soft-expire a hot-memory fact so it no longer appears in recall results. Sets expired_at; the fact row is preserved for audit. " +
    "Use when a known fact is outdated.",
  capability: "write",
  readOnly: false,
  input: z.object({
    factId: z.number().int().describe("The integer fact id from a recall result."),
  }),
  output: z.object({ factId: z.number(), forgotten: z.boolean() }),
})

/** Every session op CONTRACT (registered handler-free, mirroring `SEARCH_OPS`). */
export const SESSION_OPS: readonly AnyOpDef[] = [
  CAPTURE_TURN_OP,
  FINALIZE_SESSION_OP,
  GET_SESSION_CONTEXT_OP,
  RECALL_OP,
  FORGET_FACT_OP,
  CREATE_SNAPSHOT_OP,
  LIST_SNAPSHOTS_OP,
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

/** One OKF memory item loaded in full into the session-start context. */
export interface SessionContextMemory {
  slug: string
  type: string
  title: string
  body: string
  version: number
}

/** The `get_session_context` projection (§8.5). */
export interface SessionContext {
  turns: { idx: number; role: string; content: string | null }[]
  facts: { id: number; fact: string; kind: string }[]
  snapshotStubbed: boolean
  /** Pinned page_versions content when a snapshotId was resolved (§8.5); absent on live path. */
  pinnedPages?: PinnedPage[]
  /** OKF memory items under `memoryPath`, loaded in full (absent when no path was requested). */
  memories?: SessionContextMemory[]
}

/** Where to load agent memory from at session start (the "load in full based on a path" payoff). */
export interface SessionContextMemoryOpts {
  /** Namespace to load memory items from; absent ⇒ no memories loaded. */
  path?: string
  /** false ⇒ direct children of the path; true ⇒ the whole subtree. */
  prefix?: boolean
}

/**
 * Return the brain context for a session (§8.5). When `snapshotId` is provided, resolves the
 * `brain_snapshots.manifest` and returns the PINNED `page_versions` content — immutable, never
 * live pages — in `pinnedPages`. When `memory.path` is provided, also loads the visible OKF
 * memory items under that path IN FULL (the agent's durable memory at boot). Both extras are
 * additive: the base live-path projection (recent turns + visible hot-memory facts) is unchanged.
 * Cross-tenant / not-found / out-of-visibility ids drop to empty (drop-don't-error).
 */
export const getSessionContext = async (
  services: SessionServices,
  brainSessionId: string,
  snapshotId?: string,
  memory?: SessionContextMemoryOpts,
): Promise<SessionContext> => {
  const turns = await services.sessions.recentTurns(brainSessionId)
  const facts = await services.sessions.recall({ sessionId: brainSessionId, limit: 50 })
  const result: SessionContext = {
    turns: turns.map((t) => ({ idx: t.idx, role: t.role, content: t.content })),
    facts: facts.map((f) => ({ id: f.id, fact: f.fact, kind: f.kind })),
    snapshotStubbed: false,
  }
  if (memory?.path !== undefined) {
    const items = await services.memory.listMemory({
      path: memory.path,
      prefix: memory.prefix ?? false,
    })
    result.memories = items.map((m) => ({
      slug: m.slug,
      type: m.type,
      title: m.title,
      body: m.body,
      version: m.version,
    }))
  }
  if (snapshotId === undefined) return result
  // Snapshot path: resolve pinned page_versions; null → cross-tenant/not-found → empty (drop-don't-error).
  const pinned = await services.sessions.resolveSnapshot(snapshotId)
  return { ...result, pinnedPages: pinned ?? [] }
}

// ── Snapshot coordination fns (§8.5) ───────────────────────────────────────────────

/** Pin the current page versions into an immutable brain snapshot. */
export const createSnapshot = async (
  services: SessionServices,
  label: string,
  scope?: string | null,
): Promise<string> => {
  return services.sessions.createSnapshot(label, scope)
}

/** List brain snapshots for the tenant, newest-first. */
export const listSnapshots = async (
  services: SessionServices,
  limit?: number,
): Promise<SnapshotRow[]> => {
  return services.sessions.listSnapshots(limit)
}

/** A recall request as the route handler parses it. */
export interface RecallRequest {
  entitySlug?: string
  since?: string
  sessionId?: string
  grep?: string
  /** Keyword query — routed through the `facts_fts` JOIN-back (`ScopedDB.ftsFactIds`). */
  query?: string
  /** Include Dream-superseded/consolidated facts (default false). */
  includeSuperseded?: boolean
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
    const ids = await services.db.ftsFactIds(req.query, limit, req.includeSuperseded ?? false)
    return services.sessions.hydrateFacts(ids, req.includeSuperseded)
  }
  return services.sessions.recall({
    limit,
    ...(req.entitySlug !== undefined ? { entitySlug: req.entitySlug } : {}),
    ...(req.since !== undefined ? { since: req.since } : {}),
    ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
    ...(req.grep !== undefined ? { grep: req.grep } : {}),
    ...(req.includeSuperseded !== undefined ? { includeSuperseded: req.includeSuperseded } : {}),
  })
}

/** Soft-expire a fact (`forget_fact`). */
export const forgetFact = async (services: SessionServices, factId: number): Promise<void> => {
  await services.sessions.forgetFact(factId)
}

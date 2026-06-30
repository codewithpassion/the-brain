/**
 * OKF-compatible agent-memory op CONTRACTS + their coordination logic
 * (docs/okf-memory-plan.md §8). Like `sessions/ops.ts`, this holds the FROZEN handler-free
 * `OpDef` contracts (so MCP/tRPC/CLI cannot drift) PLUS the testable coordination fns the
 * surface invokers mount. The fns COMPOSE a tenant-scoped `MemoryStore` — no raw binding.
 */
import { type AnyOpDef, defineOp, type OpRegistry } from "@brain/shared"
import { z } from "zod"
import type { MemoryRevisionRow, MemoryRow, MemoryStore, UpsertMemoryResult } from "./store"

// ── shared sub-schemas ──────────────────────────────────────────────────────────────

const VISIBILITY = z.enum(["private", "team", "world"])

const MemorySchema = z.object({
  slug: z.string(),
  pageId: z.string(),
  type: z.string(),
  title: z.string(),
  visibility: z.string(),
  scope: z.string().nullable(),
  frontmatter: z.record(z.unknown()),
  body: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const RevisionSchema = z.object({
  revisionId: z.number(),
  version: z.number(),
  type: z.string(),
  title: z.string(),
  visibility: z.string(),
  reason: z.string().nullable(),
  authorUserId: z.string().nullable(),
  frontmatter: z.record(z.unknown()),
  body: z.string(),
  createdAt: z.string(),
})

// ── Op contracts (handler-free; registered into the shared registry) ──────────────────

/** `memory_set` — create or update a memory item by slug (OKF concept; `type` required). */
export const MEMORY_SET_OP = defineOp({
  name: "memory_set",
  description:
    "Save durable, addressable agent memory (a preference, decision, instruction, or note) under a slug you can re-read verbatim. " +
    "Appends a version on change; unchanged=no-op. Not for searchable content (use ingest_document) or transient observations (those become facts).",
  capability: "write",
  readOnly: false,
  input: z.object({
    slug: z
      .string()
      .min(1)
      .describe(
        "Stable id/path, e.g. 'agent/planner/prefs'. Slashes allowed; this is the key across versions.",
      ),
    type: z
      .string()
      .min(1)
      .describe("OKF concept type, required & non-empty, e.g. 'preference' | 'decision' | 'note'."),
    body: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    resource: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: VISIBILITY.optional().describe(
      "'world' (whole tenant) | 'team' | 'private' (you only). Default private.",
    ),
    scope: z.string().optional(),
    teamId: z.string().optional(),
  }),
  output: z.object({
    slug: z.string(),
    pageId: z.string(),
    version: z.number(),
    changed: z.boolean(),
  }),
})

/** `memory_get` — load a single memory item in full by its exact slug. */
export const MEMORY_GET_OP = defineOp({
  name: "memory_get",
  description:
    "Load a single memory item in full by its exact slug; returns null when absent. " +
    "Use when you know the slug; use memory_list when browsing a namespace.",
  capability: "read",
  readOnly: true,
  input: z.object({
    slug: z
      .string()
      .min(1)
      .describe(
        "Stable id/path, e.g. 'agent/planner/prefs'. Slashes allowed; this is the key across versions.",
      ),
  }),
  output: z.object({ memory: MemorySchema.nullable() }),
})

/** `memory_list` — load every live memory item under a path (namespace or whole subtree). */
export const MEMORY_LIST_OP = defineOp({
  name: "memory_list",
  description:
    "List live memory items under a path namespace. prefix=false = direct children only; prefix=true = full subtree. Omit path to list all. " +
    "Use to browse a namespace; use memory_get when you know the exact slug.",
  capability: "read",
  readOnly: true,
  input: z.object({
    path: z
      .string()
      .optional()
      .describe("Namespace to list, e.g. 'agent/planner'. Omit to list all memory items."),
    prefix: z
      .boolean()
      .default(false)
      .describe("false = direct children of path only; true = full subtree."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Max items to return (1–1000, default 200)."),
  }),
  output: z.object({ memories: z.array(MemorySchema) }),
})

/** `memory_history` — a memory item's full version history, newest-first. */
export const MEMORY_HISTORY_OP = defineOp({
  name: "memory_history",
  description:
    "List all version revisions of a memory item newest-first. Returns the revisionIds you need to call memory_rollback.",
  capability: "read",
  readOnly: true,
  input: z.object({
    slug: z
      .string()
      .min(1)
      .describe(
        "Stable id/path, e.g. 'agent/planner/prefs'. Slashes allowed; this is the key across versions.",
      ),
  }),
  output: z.object({ versions: z.array(RevisionSchema) }),
})

/** `memory_rollback` — forward-only revert to an earlier revision. */
export const MEMORY_ROLLBACK_OP = defineOp({
  name: "memory_rollback",
  description:
    "Revert a memory item to an earlier revision. Forward-only: appends a new version with the old content; history is never erased. " +
    "Get the revisionId from memory_history.",
  capability: "write",
  readOnly: false,
  input: z.object({
    slug: z
      .string()
      .min(1)
      .describe(
        "Stable id/path, e.g. 'agent/planner/prefs'. Slashes allowed; this is the key across versions.",
      ),
    toRevisionId: z
      .number()
      .int()
      .describe("The revisionId from memory_history, NOT the version number."),
  }),
  output: z.object({
    slug: z.string(),
    pageId: z.string(),
    version: z.number(),
    revertedFrom: z.number(),
  }),
})

/** `memory_forget` — soft-delete a memory item (revision history retained). */
export const MEMORY_FORGET_OP = defineOp({
  name: "memory_forget",
  description:
    "Soft-delete a memory item so it no longer appears in memory_list or memory_get results. Sets deleted_at; the revision history is retained. " +
    "Use when a memory item is obsolete.",
  capability: "write",
  readOnly: false,
  input: z.object({
    slug: z
      .string()
      .min(1)
      .describe(
        "Stable id/path, e.g. 'agent/planner/prefs'. Slashes allowed; this is the key across versions.",
      ),
  }),
  output: z.object({ slug: z.string(), forgotten: z.boolean() }),
})

const OkfFileSchema = z.object({ path: z.string(), content: z.string() })

/** `okf_export` — serialize memory items under a path as an OKF (Open Knowledge Format) bundle. */
export const OKF_EXPORT_OP = defineOp({
  name: "okf_export",
  description:
    "Serialize memory items under a path as a portable OKF bundle (index.md + one .md per concept + log.md). " +
    "Use for export, archival, or migration to another OKF-compatible tool.",
  capability: "read",
  readOnly: true,
  // A bundle export under a path means the WHOLE subtree by default (not just direct children).
  input: z.object({
    path: z
      .string()
      .optional()
      .describe("Namespace to export, e.g. 'agent/planner'. Omit to export all."),
    prefix: z
      .boolean()
      .default(true)
      .describe("true = export full subtree (default); false = direct children only."),
  }),
  output: z.object({
    okfVersion: z.string(),
    count: z.number(),
    files: z.array(OkfFileSchema),
  }),
})

/** `okf_import` — upsert an OKF bundle's concepts into agent memory (each import is versioned). */
export const OKF_IMPORT_OP = defineOp({
  name: "okf_import",
  description:
    "Import an OKF bundle (markdown files with YAML frontmatter) into agent memory, upserting each concept as a new version. " +
    "Reserved/typeless files are skipped. Use to restore a previously exported bundle or migrate memory from another tool.",
  capability: "write",
  readOnly: false,
  input: z.object({ files: z.array(OkfFileSchema) }),
  output: z.object({
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    okfVersion: z.string().nullable(),
    items: z.array(
      z.object({
        path: z.string(),
        status: z.enum(["imported", "skipped", "failed"]),
        reason: z.string().optional(),
        slug: z.string().optional(),
      }),
    ),
  }),
})

/** Every memory op CONTRACT (registered handler-free, mirroring `SESSION_OPS`). */
export const MEMORY_OPS: readonly AnyOpDef[] = [
  MEMORY_SET_OP,
  MEMORY_GET_OP,
  MEMORY_LIST_OP,
  MEMORY_HISTORY_OP,
  MEMORY_ROLLBACK_OP,
  MEMORY_FORGET_OP,
  OKF_EXPORT_OP,
  OKF_IMPORT_OP,
]

/** Register the memory op contracts into a shared `OpRegistry` (handlers bind in the Worker). */
export const registerMemoryOps = (registry: OpRegistry): OpRegistry => {
  for (const op of MEMORY_OPS) registry.register(op)
  return registry
}

// ── Coordination logic (the testable fns the surface invokers mount) ──────────────────

/** A `memory_set` request as the surface invoker parses it. */
export interface MemorySetRequest {
  slug: string
  type: string
  body: string
  title?: string
  description?: string
  resource?: string
  tags?: string[]
  visibility?: string
  scope?: string
  teamId?: string
}

/** Assemble the OKF frontmatter object from the ergonomic scalar inputs, dropping absent keys. */
const buildFrontmatter = (req: MemorySetRequest, timestamp: string): Record<string, unknown> => ({
  type: req.type,
  ...(req.title !== undefined ? { title: req.title } : {}),
  ...(req.description !== undefined ? { description: req.description } : {}),
  ...(req.resource !== undefined ? { resource: req.resource } : {}),
  ...(req.tags !== undefined ? { tags: req.tags } : {}),
  timestamp,
})

/** Create/update a memory item. The store enforces tenant/scope/visibility + audits in-batch. */
export const setMemory = async (
  store: MemoryStore,
  req: MemorySetRequest,
  timestamp: string,
): Promise<UpsertMemoryResult> =>
  store.upsertMemory({
    slug: req.slug,
    frontmatter: buildFrontmatter(req, timestamp),
    body: req.body,
    ...(req.visibility !== undefined ? { visibility: req.visibility } : {}),
    ...(req.scope !== undefined ? { scope: req.scope } : {}),
    ...(req.teamId !== undefined ? { teamId: req.teamId } : {}),
  })

export const getMemory = (store: MemoryStore, slug: string): Promise<MemoryRow | null> =>
  store.getMemory(slug)

export const listMemory = (
  store: MemoryStore,
  opts: { path?: string; prefix?: boolean; limit?: number },
): Promise<MemoryRow[]> => store.listMemory(opts)

export const memoryHistory = (store: MemoryStore, slug: string): Promise<MemoryRevisionRow[]> =>
  store.getMemoryHistory(slug)

export const rollbackMemory = (
  store: MemoryStore,
  slug: string,
  toRevisionId: number,
): Promise<{ slug: string; pageId: string; version: number; revertedFrom: number }> =>
  store.revertMemory(slug, toRevisionId)

export const forgetMemory = (
  store: MemoryStore,
  slug: string,
): Promise<{ slug: string; forgotten: boolean }> => store.forgetMemory(slug)

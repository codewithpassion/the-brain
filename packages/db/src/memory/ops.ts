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
    "Create or update an agent-memory item by slug (an OKF concept). Appends a version on " +
    "change; an unchanged write is a no-op. `type` is required (OKF).",
  capability: "write",
  readOnly: false,
  input: z.object({
    slug: z.string().min(1),
    type: z.string().min(1),
    body: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    resource: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: VISIBILITY.optional(),
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
  description: "Load a single agent-memory item in full by its exact slug (null when absent).",
  capability: "read",
  readOnly: true,
  input: z.object({ slug: z.string().min(1) }),
  output: z.object({ memory: MemorySchema.nullable() }),
})

/** `memory_list` — load every live memory item under a path (namespace or whole subtree). */
export const MEMORY_LIST_OP = defineOp({
  name: "memory_list",
  description:
    "List live agent-memory items under a path. prefix=false matches the namespace exactly " +
    "(or a direct child); prefix=true matches the whole subtree. No path lists all.",
  capability: "read",
  readOnly: true,
  input: z.object({
    path: z.string().optional(),
    prefix: z.boolean().default(false),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  output: z.object({ memories: z.array(MemorySchema) }),
})

/** `memory_history` — a memory item's full version history, newest-first. */
export const MEMORY_HISTORY_OP = defineOp({
  name: "memory_history",
  description: "List a memory item's full version history, newest-first (the rollback targets).",
  capability: "read",
  readOnly: true,
  input: z.object({ slug: z.string().min(1) }),
  output: z.object({ versions: z.array(RevisionSchema) }),
})

/** `memory_rollback` — forward-only revert to an earlier revision. */
export const MEMORY_ROLLBACK_OP = defineOp({
  name: "memory_rollback",
  description:
    "Roll a memory item back to an earlier revision (forward-only: appends a new version " +
    "with the old content; history is never mutated).",
  capability: "write",
  readOnly: false,
  input: z.object({ slug: z.string().min(1), toRevisionId: z.number().int() }),
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
  description: "Soft-delete a memory item (sets deleted_at; the version history is retained).",
  capability: "write",
  readOnly: false,
  input: z.object({ slug: z.string().min(1) }),
  output: z.object({ slug: z.string(), forgotten: z.boolean() }),
})

const OkfFileSchema = z.object({ path: z.string(), content: z.string() })

/** `okf_export` — serialize memory items under a path as an OKF (Open Knowledge Format) bundle. */
export const OKF_EXPORT_OP = defineOp({
  name: "okf_export",
  description:
    "Export agent-memory items under a path as an OKF bundle (index.md + one .md per concept " +
    "+ log.md). Vendor-neutral markdown; portable to any OKF tool.",
  capability: "read",
  readOnly: true,
  // A bundle export under a path means the WHOLE subtree by default (not just direct children).
  input: z.object({ path: z.string().optional(), prefix: z.boolean().default(true) }),
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
    "Import an OKF bundle (a list of markdown files) into agent memory. Each concept is " +
    "upserted (so the import is itself versioned); reserved/typeless files are skipped.",
  capability: "write",
  readOnly: false,
  input: z.object({ files: z.array(OkfFileSchema) }),
  output: z.object({ imported: z.number(), skipped: z.array(z.string()) }),
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

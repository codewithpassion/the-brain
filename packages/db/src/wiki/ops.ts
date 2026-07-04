/**
 * Wiki op CONTRACTS + coordination fns (v3/W1). Like `memory/ops.ts`, this holds the FROZEN
 * handler-free `OpDef` contracts (so MCP/tRPC/CLI cannot drift) PLUS the testable coordination fns
 * the surface invokers mount over a tenant-scoped `WikiStore`.
 *
 * Wiki pages ARE `pages` rows (`ingested_via='wiki'`) on the SAME store memory uses. Frontmatter is
 * expressed as typed scalars (`type` required — OKF), NOT a free-form object, so every input stays
 * within the closed JSON-schema set the surface generators support (no `z.record` / no `.refine`).
 */
import { type AnyOpDef, defineOp, type OpRegistry } from "@brain/shared"
import { z } from "zod"
import type {
  WikiListEntry,
  WikiMoveResult,
  WikiPageDetail,
  WikiSavePageInput,
  WikiSavePageResult,
  WikiStore,
} from "./store"

const VISIBILITY = z.enum(["private", "team", "world"])

const DocLinkSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  linkType: z.string(),
  context: z.string(),
})

const WikiPageDetailSchema = z.object({
  page: z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    type: z.string(),
    visibility: z.string(),
    ingestedVia: z.string().nullable(),
    entityId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  body: z.string(),
  frontmatter: z.record(z.unknown()),
  backlinks: z.array(DocLinkSchema),
  tags: z.array(z.string()),
  timeline: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      summary: z.string(),
      detail: z.string(),
      source: z.string(),
    }),
  ),
  revisions: z.array(
    z.object({
      revisionId: z.number(),
      version: z.number(),
      reason: z.string().nullable(),
      authorUserId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  links: z.object({
    resolved: z.array(DocLinkSchema),
    pending: z.array(z.string()),
  }),
})

const WikiListEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: z.string(),
  visibility: z.string(),
  ingestedVia: z.string().nullable(),
  updatedAt: z.string(),
  childCount: z.number().int(),
})

// ── Op contracts ──────────────────────────────────────────────────────────────────────

/** `wiki_save_page` — create/update a first-class wiki page (versioned; author = principal). */
export const WIKI_SAVE_PAGE_OP = defineOp({
  name: "wiki_save_page",
  description:
    "Create or update a wiki page by slug (versioned; collaboratively editable within scope/visibility). " +
    "Unresolved [[wikilinks]] become red links that resolve when the target page is created. " +
    "Use for durable, human/agent-authored knowledge pages meant to be browsed and linked. " +
    "Disambiguation: memory_set = agent-only addressable memory re-read verbatim by slug (not a wiki page); " +
    "add_thought = a quick timestamped capture into the ingest stream; ingest_document = index external " +
    "reference content for search/think (not a first-class page). Omit visibility to preserve the page's current tier.",
  capability: "write",
  readOnly: false,
  input: z.object({
    slug: z
      .string()
      .min(1)
      .describe("Stable page id/path, e.g. 'guides/onboarding'. Slashes namespace the wiki."),
    type: z
      .string()
      .min(1)
      .describe("OKF page type, required & non-empty, e.g. 'note' | 'guide' | 'concept'."),
    body: z.string().describe("Markdown body. [[slug]] and [text](/slug) become links/red-links."),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: VISIBILITY.optional().describe(
      "'world' (whole tenant, default) | 'team' | 'private' (you only).",
    ),
  }),
  output: z.object({
    slug: z.string(),
    pageId: z.string(),
    version: z.number(),
    changed: z.boolean(),
  }),
})

/** `wiki_get_page` — a page's full detail (body, frontmatter, backlinks, tags, timeline, history). */
export const WIKI_GET_PAGE_OP = defineOp({
  name: "wiki_get_page",
  description:
    "Load a wiki page in full by slug or id: body, frontmatter, backlinks, tags, timeline, revision " +
    "history, and outbound links (resolved + pending red links). Surfaces memory-provenance pages too.",
  capability: "read",
  readOnly: true,
  input: z.object({
    target: z.string().min(1).describe("Page slug or id."),
  }),
  output: z.object({ page: WikiPageDetailSchema.nullable() }),
})

/** `wiki_list_pages` — a tree-shaped listing for a sidebar (includes memory-provenance pages). */
export const WIKI_LIST_PAGES_OP = defineOp({
  name: "wiki_list_pages",
  description:
    "List wiki pages for a sidebar tree, optionally filtered by namespace prefix, type, or tag. " +
    "Includes memory-provenance pages (a page is a page). Returns childCount per slug for tree expansion.",
  capability: "read",
  readOnly: true,
  input: z.object({
    namespacePrefix: z
      .string()
      .optional()
      .describe(
        "Restrict to a namespace, e.g. 'guides' → 'guides' and everything under 'guides/'.",
      ),
    type: z.string().optional().describe("Filter by page type."),
    tag: z.string().optional().describe("Filter to pages carrying exactly this tag."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Max pages to return (1–1000, default 200)."),
  }),
  output: z.object({ pages: z.array(WikiListEntrySchema) }),
})

/** `wiki_move_page` — rename a wiki page, re-pointing links + leaving a redirect stub (wiki-only). */
export const WIKI_MOVE_PAGE_OP = defineOp({
  name: "wiki_move_page",
  description:
    "Rename a wiki page (fromSlug → toSlug). Keeps the page id so links follow, leaves a redirect " +
    "stub at the old slug, and resolves any red links pointing at the new slug. Wiki pages only.",
  capability: "write",
  readOnly: false,
  input: z.object({
    fromSlug: z.string().min(1).describe("The current page slug."),
    toSlug: z.string().min(1).describe("The new slug (must be free)."),
  }),
  output: z.object({ fromSlug: z.string(), toSlug: z.string(), pageId: z.string() }),
})

/** `wiki_delete_page` — soft-delete a wiki page (wiki-only; history retained). */
export const WIKI_DELETE_PAGE_OP = defineOp({
  name: "wiki_delete_page",
  description:
    "Soft-delete a wiki page by slug (history retained; removable from listings/search). Wiki pages only.",
  capability: "write",
  readOnly: false,
  input: z.object({ slug: z.string().min(1).describe("The page slug to delete.") }),
  output: z.object({ slug: z.string(), deleted: z.boolean() }),
})

/** Every wiki op CONTRACT (registered handler-free, mirroring `MEMORY_OPS`). */
export const WIKI_OPS: readonly AnyOpDef[] = [
  WIKI_SAVE_PAGE_OP,
  WIKI_GET_PAGE_OP,
  WIKI_LIST_PAGES_OP,
  WIKI_MOVE_PAGE_OP,
  WIKI_DELETE_PAGE_OP,
]

/** Register the wiki op contracts into a shared `OpRegistry` (handlers bind in the Worker). */
export const registerWikiOps = (registry: OpRegistry): OpRegistry => {
  for (const op of WIKI_OPS) registry.register(op)
  return registry
}

// ── Coordination logic (the testable fns the surface invokers mount) ──────────────────

export const saveWikiPage = (
  store: WikiStore,
  req: WikiSavePageInput,
): Promise<WikiSavePageResult> => store.savePage(req)

export const getWikiPage = (store: WikiStore, target: string): Promise<WikiPageDetail | null> =>
  store.getPage(target)

export const listWikiPages = (
  store: WikiStore,
  opts: { namespacePrefix?: string; type?: string; tag?: string; limit?: number },
): Promise<WikiListEntry[]> => store.listPages(opts)

export const moveWikiPage = (
  store: WikiStore,
  fromSlug: string,
  toSlug: string,
): Promise<WikiMoveResult> => store.movePage(fromSlug, toSlug)

export const deleteWikiPage = (
  store: WikiStore,
  slug: string,
): Promise<{ slug: string; deleted: boolean }> => store.deletePage(slug)

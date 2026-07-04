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
import type { OkfExportResult, OkfImportResult } from "../memory/okf"
import { IMPORT_CAPS } from "./okf-bundle"
import type {
  WikiListEntry,
  WikiMoveResult,
  WikiPageDetail,
  WikiPageHistory,
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
  // Source page slug/title — present on backlinks (navigable), absent on outbound resolved links.
  fromSlug: z.string().optional(),
  fromTitle: z.string().optional(),
})

const WikiRevisionFullSchema = z.object({
  revisionId: z.number().int(),
  version: z.number().int(),
  reason: z.string().nullable(),
  authorUserId: z.string().nullable(),
  createdAt: z.string(),
  body: z.string(),
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
  entity: z
    .object({
      entityId: z.string(),
      kind: z.string(),
      canonicalName: z.string(),
      mentions: z.array(z.object({ sourceKind: z.string(), sourceId: z.string() })),
      relations: z.array(
        z.object({
          direction: z.enum(["out", "in"]),
          kind: z.string(),
          entityId: z.string(),
          name: z.string(),
          slug: z.string(),
        }),
      ),
    })
    .optional(),
  stub: z.boolean().optional(),
})

const WikiListEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  type: z.string(),
  visibility: z.string(),
  ingestedVia: z.string().nullable(),
  updatedAt: z.string(),
  childCount: z.number().int(),
  draft: z.boolean(),
})

// ── Op contracts ──────────────────────────────────────────────────────────────────────

/** `wiki_save_page` — create/update a first-class wiki page (versioned; author = principal). */
export const WIKI_SAVE_PAGE_OP = defineOp({
  name: "wiki_save_page",
  description:
    "Create or update a wiki page by slug (versioned; collaboratively editable within scope/visibility). " +
    "Unresolved [[wikilinks]] become red links that resolve when the target page is created. " +
    "A saved page becomes searchable (findable via search/think and cited by its page slug) within about a minute. " +
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
    draft: z
      .boolean()
      .optional()
      .describe("Mark the page an unpublished draft (frontmatter `draft`) — shown under Drafts."),
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
    "history, and outbound links (resolved + pending red links). Surfaces memory-provenance pages too. " +
    "For an ENTITY page, also returns live `entity` sections (mentions + relations → other entity pages). " +
    "For an 'entities/<kind>/<name>' slug with no page yet, returns a `stub:true` result with the entity " +
    "sections and an EMPTY page.id — treat that as 'create this entity page', never as a real page id.",
  capability: "read",
  readOnly: true,
  input: z.object({
    target: z.string().min(1).describe("Page slug or id."),
  }),
  output: z.object({ page: WikiPageDetailSchema.nullable() }),
})

/** `wiki_page_history` — a page's revision snapshots WITH bodies, for the history/diff view. */
export const WIKI_PAGE_HISTORY_OP = defineOp({
  name: "wiki_page_history",
  description:
    "Load a page's revision history WITH full body snapshots (newest-first), for a diff view. " +
    "Visibility-gated exactly like wiki_get_page: a page the caller can't see returns revisions:null " +
    "(no bodies leak). Serves any visible page — wiki or entity (entity pages carry dream-authored " +
    "history). Memory pages keep memory_history as their lane but are also visible here.",
  capability: "read",
  readOnly: true,
  input: z.object({
    target: z.string().min(1).describe("Page slug or id."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max revisions, newest-first (1–200, default 50)."),
  }),
  output: z.object({ revisions: z.array(WikiRevisionFullSchema).nullable() }),
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

/** `wiki_export_bundle` — package a wiki namespace/subtree as an OKF bundle for download (read-only). */
export const WIKI_EXPORT_BUNDLE_OP = defineOp({
  name: "wiki_export_bundle",
  description:
    "Export a wiki namespace (or the whole wiki) as an OKF bundle: a reserved index.md + one .md per " +
    "page (frontmatter carries type/title/tags/visibility) + a log.md of revision history. Returns the " +
    "files for the caller to package (e.g. a zip). Read-only; scoped to what YOU can see (your team/" +
    "private pages are included, each keeping its visibility for round-trip). Includes all provenances " +
    "(memory/entity/insight/index pages under the namespace).",
  capability: "read",
  readOnly: true,
  input: z.object({
    namespace: z
      .string()
      .optional()
      .describe("Namespace/subtree to export, e.g. 'guides'. Omit to export the whole wiki."),
    prefix: z
      .boolean()
      .default(true)
      .describe(
        "When true (default), include everything under 'namespace/'; false = exact slug only.",
      ),
  }),
  output: z.object({
    okfVersion: z.string(),
    count: z.number().int(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
  }),
})

/** `wiki_import_bundle` — import an OKF bundle as UNTRUSTED content: private + draft, confined, no search. */
export const WIKI_IMPORT_BUNDLE_OP = defineOp({
  name: "wiki_import_bundle",
  description:
    "Import an OKF bundle (files[]) into the wiki under 'imported/<namespace>/…'. UNTRUSTED-INGRESS " +
    "posture: every page is forced PRIVATE + draft (bundle visibility is ignored), gets NO search " +
    "backing doc, is excluded from the dream engine, and its links are confined to the imported " +
    "subtree (never merges into your existing pages). Resilient: bad files are skipped/failed without " +
    "aborting the bundle. Promotion to searchable/world is a separate explicit human edit later.",
  capability: "write",
  readOnly: false,
  input: z.object({
    // Defense-in-depth: bound the array (and coarse per-file length) at the schema so an oversized
    // bundle is rejected before it fully materializes — the authoritative UTF-8 byte caps live in
    // `prepareWikiBundle`. (String .length is UTF-16 code units ≤ byte length, so this never wrongly
    // rejects a within-budget file; it only trips egregious inputs early.)
    files: z
      .array(z.object({ path: z.string(), content: z.string().max(IMPORT_CAPS.maxFileBytes) }))
      .max(IMPORT_CAPS.maxFiles)
      .describe("The bundle files (path + markdown content)."),
    namespace: z
      .string()
      .min(1)
      .describe("Confinement namespace — pages land under 'imported/<namespace>/…'."),
  }),
  output: z.object({
    imported: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
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
  output: z.object({ slug: z.string(), deleted: z.boolean(), pageId: z.string().nullable() }),
})

/** Every wiki op CONTRACT (registered handler-free, mirroring `MEMORY_OPS`). */
export const WIKI_OPS: readonly AnyOpDef[] = [
  WIKI_SAVE_PAGE_OP,
  WIKI_GET_PAGE_OP,
  WIKI_PAGE_HISTORY_OP,
  WIKI_LIST_PAGES_OP,
  WIKI_EXPORT_BUNDLE_OP,
  WIKI_IMPORT_BUNDLE_OP,
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

export const getWikiPageHistory = (
  store: WikiStore,
  target: string,
  limit?: number,
): Promise<WikiPageHistory> => store.pageHistory(target, limit)

export const exportWikiBundle = (
  store: WikiStore,
  opts: { namespace?: string; prefix?: boolean },
): Promise<OkfExportResult> => store.exportBundle(opts)

export const importWikiBundle = (
  store: WikiStore,
  files: { path: string; content: string }[],
  namespace: string,
): Promise<OkfImportResult> => store.importBundle(files, namespace)

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
): Promise<{ slug: string; deleted: boolean; pageId: string | null }> => store.deletePage(slug)

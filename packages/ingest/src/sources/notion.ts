/**
 * Notion vault importer (docs/notion-integration-plan.md §3, §5) — the pull-side sibling of the
 * Obsidian importer. Enumerates pages shared with the Brain's Notion integration (optionally
 * filtered to `since = sources.last_sync_at`) and emits one `kind:"doc"` item per page for the
 * backfill spine. Each page becomes a searchable Brain document with:
 *   - `slug`        — `notion:<pageId>` (STABLE: a Notion page id never changes → supersede-on-edit)
 *   - `path`        — derived from the parent chain (e.g. `/Workspace/Parent`)
 *   - `tags`        — from page select / multi_select / status properties (+ any injected by the ref)
 *   - `fingerprint` — `notion:<pageId>:<last_edited_time>` (mirrors `obsidian:<path>:<etag>`; cron
 *                     and webhook compute the same value and no-op each other)
 *   - `content`     — the block tree converted to Markdown (staged by `runEnumerate`)
 *
 * All Notion I/O goes through the injected `NotionClient` (the DI seam) — never a global `fetch` —
 * so tests drive the importer with a stub client and no live HTTP. Items masquerade as
 * `ImportedSession` (client:"notion", turns:[]) exactly like Obsidian, so they ride the existing
 * `ImportBatch` type; the extra doc fields are consumed by `runEnumerate`, not session semantics.
 */
import { blocksToMarkdown, extractPageTags, type NotionBlock, pageTitle } from "./notion-blocks"
import type { ImportBatch, ImportedSession, ImportedTurn, Importer } from "./types"

// ── The injected Notion client (DI seam) ────────────────────────────────────────────────────────

/** A page as surfaced by enumeration — the delta-detection basis. */
export interface NotionPageRef {
  id: string
  /** ISO-8601 `last_edited_time` — the fingerprint + `since` basis. */
  lastEditedTime: string
  /** True when the page is archived / trashed (→ the poller soft-deletes; the importer skips). */
  archived?: boolean
}

/** A fully-fetched page: its properties (title/tags), parent path, and materialised block tree. */
export interface NotionPageContent {
  id: string
  lastEditedTime: string
  archived?: boolean
  /** Raw Notion page `properties` map (title + select/status/multi_select tag sources). */
  properties?: Record<string, unknown>
  /** Human path segments from the parent chain, workspace-first (e.g. ["Engineering", "Specs"]). */
  parentPath?: string[]
  /** The page's materialised block tree (children pre-fetched), ready for `blocksToMarkdown`. */
  blocks: NotionBlock[]
}

/**
 * The minimal Notion surface the importer needs. The concrete throttled HTTP client (Chunk 3)
 * implements this; tests pass a stub. `listChangedPages` pages through all pages the integration
 * can see (optionally `since`-filtered); `getPageContent` fetches one page's props + block tree.
 */
export interface NotionClient {
  listChangedPages(opts: {
    since?: string
    cursor?: string
  }): Promise<{ pages: NotionPageRef[]; nextCursor: string | null }>
  getPageContent(pageId: string): Promise<NotionPageContent>
}

// ── Mapping helpers ──────────────────────────────────────────────────────────────────────────────

/** Stable slug for a Notion page — the page id never changes, so edits supersede by slug. */
export const notionSlug = (pageId: string): string => `notion:${pageId}`

/** Fingerprint — page id + last-edited time, so an unchanged page dedups and an edit re-ingests. */
export const notionFingerprint = (pageId: string, lastEditedTime: string): string =>
  `notion:${pageId}:${lastEditedTime}`

/** Brain namespace path from the Notion parent chain (`["A","B"]` → `/A/B`; empty → `/`). */
export const notionPath = (parentPath: string[] | undefined): string => {
  const segs = (parentPath ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  return segs.length === 0 ? "/" : `/${segs.join("/")}`
}

/** A Notion page mapped to Brain document fields. */
export interface NotionDoc {
  slug: string
  fingerprint: string
  content: string
  contentType: "text/markdown"
  path: string
  tags: string[]
}

/**
 * The SINGLE Notion page → Brain doc mapping, used by BOTH the poll importer and the webhook event
 * consumer so their slug/fingerprint/path/tags/markdown are byte-identical (cron + webhook resolve
 * to the same doc and no-op each other). The title is prepended as an H1.
 */
export const notionPageToDoc = (page: NotionPageContent): NotionDoc => {
  const title = pageTitle(page.properties)
  const body = blocksToMarkdown(page.blocks)
  const content = title.length > 0 ? `# ${title}\n\n${body}` : body
  return {
    slug: notionSlug(page.id),
    fingerprint: notionFingerprint(page.id, page.lastEditedTime),
    content,
    contentType: "text/markdown",
    path: notionPath(page.parentPath),
    tags: extractPageTags(page.properties),
  }
}

// ── Cursor ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The resume cursor persisted to `backfill_runs.cursor` between `nextBatch` calls. It is JUST
 * Notion's opaque `next_cursor` (or `null` = start / exhausted) — STATELESS and rebuildable, so a
 * resumed run (obsidian.ts-style, honouring `begin({resumeCursor})`) picks up exactly where it left
 * off with no in-memory buffer. Each `nextBatch` processes one Notion listing page, so the cursor is
 * checkpointed per search page (a mid-tick failure redoes at most one page's block fetches).
 */
interface NotionCursor {
  listCursor: string | null
}

// ── Factory ────────────────────────────────────────────────────────────────────────────────────

/**
 * Build a Notion importer over an injected `NotionClient`.
 *
 * @param client   The Notion API client (stub in tests; the throttled HTTP client at deploy).
 * @param opts.since  Only emit pages edited at/after this ISO time (the source's `last_sync_at`).
 */
export const createNotionImporter = (
  client: NotionClient,
  opts: {
    since?: string
    /**
     * Called for each archived/trashed page seen in the delta (instead of silently skipping it),
     * so the caller can soft-delete the corresponding doc — closing the delete gap in the poll
     * path WITHOUT extra API calls (the `archived` flag rides the existing listing). Effective only
     * when Notion's delta listing actually surfaces trashed pages; webhooks remain the reliable
     * delete channel.
     */
    onArchived?: (pageId: string) => Promise<void>
  } = {},
): Importer => {
  const parseCursor = (raw: string | undefined): string | null => {
    if (raw === undefined) return null
    try {
      return (JSON.parse(raw) as NotionCursor).listCursor ?? null
    } catch {
      return null
    }
  }

  return {
    source: "notion",

    begin: async (beginOpts) => {
      // Honour the resume cursor (Notion's opaque token) so a restarted run continues, not restarts.
      const listCursor = parseCursor(beginOpts.resumeCursor)
      return { cursor: JSON.stringify({ listCursor } satisfies NotionCursor) }
    },

    nextBatch: async (cursor): Promise<ImportBatch> => {
      let listCursor = (JSON.parse(cursor as string) as NotionCursor).listCursor

      const items: Array<
        ImportedSession & {
          content: string
          contentType: "text/markdown"
          path: string
          tags: string[]
        }
      > = []

      // One search page per iteration; keep going only while a page yields NO items but the listing
      // continues (so we never return an empty batch with a non-null cursor — the contract rule).
      while (true) {
        const res = await client.listChangedPages({
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          ...(listCursor !== null ? { cursor: listCursor } : {}),
        })
        for (const ref of res.pages) {
          if (ref.archived === true) {
            // Surface the delete to the caller (soft-delete), then skip the upsert.
            if (opts.onArchived !== undefined) await opts.onArchived(ref.id)
            continue
          }
          const page = await client.getPageContent(ref.id)
          if (page.archived === true) {
            if (opts.onArchived !== undefined) await opts.onArchived(ref.id)
            continue
          }
          const doc = notionPageToDoc(page)
          if (doc.content.trim().length === 0) continue // empty page → skip
          items.push({
            sourceSessionId: doc.slug,
            client: "notion",
            turns: [] as ImportedTurn[],
            fingerprint: doc.fingerprint,
            embeddingModel: "pending",
            embeddingDims: 0,
            content: doc.content,
            contentType: doc.contentType,
            path: doc.path,
            tags: doc.tags,
          })
        }
        listCursor = res.nextCursor
        if (items.length > 0 || listCursor === null) break
      }

      const nextCursor =
        listCursor === null ? null : JSON.stringify({ listCursor } satisfies NotionCursor)
      return { items, nextCursor }
    },

    finalize: async () => undefined,
  }
}

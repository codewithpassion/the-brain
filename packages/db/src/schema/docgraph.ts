import { VISIBILITIES } from "@brain/shared"
import { desc, sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { enumCheck, isoNow } from "./helpers"

/**
 * Document/page link graph — PRD §3.1.2 (authoritative: §6.1; `pages` consolidated).
 *
 * `pages` is the ONLY doc-graph node space: `doc_links.from_id`/`to_id` are ALWAYS
 * `pages.id`. A document *backs* a page; `documents`/`chunks` are never link-graph nodes.
 * The `idx_doc_links_unique` edge-dedup index uses `COALESCE(origin_id,'')` (an
 * expression index Drizzle cannot model) and is hand-written in the raw migration.
 */

// pages: the ONLY doc-graph node space.
export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id"),
    scope: text("scope"),
    userId: text("user_id"),
    slug: text("slug").notNull(), // unique WITHIN tenant
    type: text("type").notNull().default("note"), // EdgeSpec.typeCol for DOC_GRAPH
    title: text("title").notNull().default(""), // EdgeSpec.labelCol for DOC_GRAPH
    visibility: text("visibility").notNull().default("world"), // doc-graph access tier
    compiledTruth: text("compiled_truth").notNull().default(""), // markdown PREVIEW (full body in R2)
    frontmatter: text("frontmatter").notNull().default("{}"),
    contentHash: text("content_hash"), // skip-unchanged gate
    documentId: text("document_id"), // the backing document, when created by ingest
    entityId: text("entity_id"), // the entity this page IS about (W2 entity pages); nullable
    sourceId: text("source_id"),
    sourceKind: text("source_kind"),
    sourceUri: text("source_uri"),
    ingestedVia: text("ingested_via"),
    ingestedAt: text("ingested_at"),
    effectiveDate: text("effective_date"),
    effectiveDateSource: text("effective_date_source"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
    deletedAt: text("deleted_at"), // soft-delete; BFS/getLinks filter deleted_at IS NULL
  },
  (t) => [
    check("pages_visibility_ck", enumCheck("visibility", VISIBILITIES)),
    uniqueIndex("ux_pages_tenant_slug").on(t.tenantId, t.slug),
    index("ix_pages_tenant_type").on(t.tenantId, t.type),
    index("ix_pages_tenant_updated").on(t.tenantId, t.updatedAt),
    index("ix_pages_source").on(t.tenantId, t.sourceId, t.ingestedVia, t.deletedAt),
    index("ix_pages_entity").on(t.tenantId, t.entityId), // W2 entity-page lookup
    // W3 backing-doc → page reverse-map; UNIQUE (partial) so a doc can't fan-out the citation JOIN
    // to two live pages — a double-link raises a clear error instead of multiplying search results.
    uniqueIndex("ix_pages_document")
      .on(t.tenantId, t.documentId)
      .where(sql`${t.documentId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
)

/**
 * `pending_links` — UNRESOLVED wikilinks ("red links"): an in-body `[[slug]]`/markdown link
 * whose target page does not yet exist (or is not visible). Recorded here instead of dropped
 * (v3/W1); when a page is later created at `target_slug`, `PageStore` resolves the row into a
 * real `doc_links` edge and deletes it. `link_source` is carried so the recreated edge matches
 * the origin page's provenance (`okf` for memory pages, `wiki` for wiki pages).
 */
export const pendingLinks = sqliteTable(
  "pending_links",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fromPageId: text("from_page_id").notNull(), // ALWAYS a pages.id (the page that authored the link)
    targetSlug: text("target_slug").notNull(), // the slug the link points at (no page yet)
    linkSource: text("link_source").notNull().default("wiki"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    unique().on(t.tenantId, t.fromPageId, t.targetSlug), // idempotent per (page, target)
    index("ix_pending_links_target").on(t.tenantId, t.targetSlug), // retroactive resolution lookup
  ],
)

// doc_links: typed page→page edges; from_id/to_id ALWAYS pages.id.
export const docLinks = sqliteTable(
  "doc_links",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fromId: text("from_id").notNull(), // ALWAYS a pages.id
    toId: text("to_id").notNull(), // ALWAYS a pages.id
    linkType: text("link_type").notNull().default(""),
    linkSource: text("link_source").notNull().default("manual"),
    originId: text("origin_id"),
    originField: text("origin_field"),
    context: text("context").notNull().default(""),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_doc_links_from").on(t.tenantId, t.fromId),
    index("idx_doc_links_to").on(t.tenantId, t.toId), // backlinks arm
  ],
)

export const tags = sqliteTable(
  "tags",
  {
    tenantId: text("tenant_id").notNull(),
    pageId: text("page_id").notNull(),
    tag: text("tag").notNull(),
  },
  (t) => [unique().on(t.tenantId, t.pageId, t.tag), index("idx_tags_tag").on(t.tenantId, t.tag)],
)

export const timelineEntries = sqliteTable(
  "timeline_entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    pageId: text("page_id").notNull(),
    date: text("date").notNull(),
    source: text("source").notNull().default(""),
    summary: text("summary").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [unique().on(t.tenantId, t.pageId, t.date, t.summary)], // INSERT OR IGNORE dedup key
)

export const pageVersions = sqliteTable(
  "page_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    pageId: text("page_id").notNull(),
    compiledTruth: text("compiled_truth").notNull(), // markdown preview body (full body in R2)
    frontmatter: text("frontmatter").notNull().default("{}"),
    snapshotAt: text("snapshot_at").notNull(),
  },
  (t) => [index("idx_page_versions_page").on(t.tenantId, t.pageId, desc(t.snapshotAt))],
)

// page_revisions: per-concept edit history for OKF agent memory (docs/okf-memory-plan.md §5).
// One row per committed state of a page; the live `pages` row mirrors the latest revision.
// Backs memory_history + forward-only memory_rollback. Integer `id` = monotonic version handle.
export const pageRevisions = sqliteTable(
  "page_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    pageId: text("page_id").notNull(),
    version: integer("version").notNull(), // per-page 1..N (prior max + 1 at write)
    slug: text("slug").notNull(), // denormalized so history survives soft-delete of the live row
    type: text("type").notNull(),
    title: text("title").notNull().default(""),
    compiledTruth: text("compiled_truth").notNull(), // full body snapshot (inline for memory pages)
    frontmatter: text("frontmatter").notNull().default("{}"),
    visibility: text("visibility").notNull(),
    authorUserId: text("author_user_id"),
    reason: text("reason"), // 'set' | 'revert:<fromVersion>' | 'import'
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_page_revisions_page").on(t.tenantId, t.pageId, desc(t.id))],
)

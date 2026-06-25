import { VISIBILITIES } from "@brain/shared"
import { desc } from "drizzle-orm"
import { check, index, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core"
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

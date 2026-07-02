import { VISIBILITIES } from "@brain/shared"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { enumCheck } from "./helpers"

/**
 * Core content — `documents` + `chunks` (PRD §3.1.1, authoritative: §4.9).
 *
 * D1 holds the index + lean rows + `markdown_preview` only; full bodies live in R2
 * under `documents.body_r2_key`. `trust_grade` is NOT a column here (LEFT-JOINed from
 * the `memory_use_policy` sidecar at read). `documents` has NO `visibility` column —
 * the intra-tenant tier lives on `chunks`. The matching `chunks_fts` FTS5 table and
 * its triggers are raw SQL (Drizzle cannot model FTS5).
 */

// documents: index + provenance + dedup, NO full body.
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id"),
    scope: text("scope"),
    userId: text("user_id").notNull(),
    slug: text("slug").notNull(), // citation field (JOIN target for §5.3)
    title: text("title"),
    contentType: text("content_type"),
    bodyR2Key: text("body_r2_key"),
    markdownPreview: text("markdown_preview"), // preview only; body via body_r2_key
    status: text("status").notNull().default("pending"), // pending|processing|indexed|failed|duplicate|skipped
    parentDocumentId: text("parent_document_id"), // oversized-upload split (§4.3)
    partIndex: integer("part_index"),
    partCount: integer("part_count"),
    fingerprint: text("fingerprint").notNull(),
    chunkCount: integer("chunk_count").default(0),
    sourceId: text("source_id"),
    sourceKind: text("source_kind"),
    sourceUri: text("source_uri"),
    ingestedVia: text("ingested_via"),
    ingestedAt: text("ingested_at"),
    tags: text("tags").default("[]"),
    path: text("path"), // optional namespace prefix, e.g. "/project/x"
    origin: text("origin"), // NULL for normal docs; 'dream' for reflection insights (D2 anti-loop D-i2)
    metadata: text("metadata"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
    deletedAt: text("deleted_at"), // soft-delete; search and listDocuments filter deleted_at IS NULL
  },
  (t) => [
    uniqueIndex("ux_documents_tenant_fp").on(t.tenantId, t.scope, t.fingerprint), // dedup backstop
    uniqueIndex("ux_documents_tenant_slug").on(t.tenantId, t.slug),
    index("ix_documents_tenant_source").on(t.tenantId, t.sourceId, t.status),
    // Dream reflection's namespace-growth scan filters (tenant_id, created_at >= since).
    index("idx_documents_created").on(t.tenantId, t.createdAt),
  ],
)

// chunks: stable nanoid id (re-embed target), per-row embedding state.
export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    scope: text("scope"), // mirrored from parent doc (allowedScopes gate)
    teamId: text("team_id"), // mirrored (visibility gate)
    userId: text("user_id"), // author mirrored (visibility gate)
    visibility: text("visibility").notNull().default("world"), // intra-tenant access tier
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    headingPath: text("heading_path"),
    tokenCount: integer("token_count"),
    chunkSource: text("chunk_source"),
    embeddedAt: text("embedded_at"), // staleness (gbrain 0002_search.sql)
    embedError: text("embed_error"),
    embeddingModel: text("embedding_model").notNull(), // per-row model tracking
    embeddingDims: integer("embedding_dims").notNull(),
    updatedAt: text("updated_at").notNull(), // drives computeStale (updated_at > embedded_at)
    deletedAt: text("deleted_at"), // soft-delete; search filters deleted_at IS NULL
    path: text("path"), // namespace prefix mirrored from parent document, e.g. "/project/x"
  },
  (t) => [
    check("chunks_visibility_ck", enumCheck("visibility", VISIBILITIES)),
    index("ix_chunks_tenant_doc").on(t.tenantId, t.documentId),
  ],
)

import { ENTITY_VISIBILITIES } from "@brain/shared"
import { desc } from "drizzle-orm"
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { enumCheck } from "./helpers"

/**
 * Knowledge graph (extracted) — PRD §3.1.3 (authoritative: §6.1).
 *
 * Separate graph from the doc graph; `entity_mentions` is the ONLY bridge to
 * documents/chunks/sessions/pages. `entities` has NO `user_id` and its `visibility`
 * is 2-value `{team,world}` only (merged max-permissive). The deterministic dedup
 * key `idx_entities_key` is case-insensitive + scope-partitioned via
 * `COALESCE(scope,''), lower(canonical_name)` — an expression index hand-written in
 * the raw migration. `entity_fts` (FTS5) + triggers are also raw SQL.
 */

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(), // person|org|project|concept|...
    canonicalName: text("canonical_name").notNull(),
    aliases: text("aliases").notNull().default("[]"), // JSON string[] (set-union, capped 50)
    description: text("description").notNull().default(""),
    sourceChunkIds: text("source_chunk_ids").notNull().default("[]"), // JSON string[]
    mentionCount: integer("mention_count").notNull().default(0),
    scope: text("scope"), // PARTITIONED, in the dedup key
    visibility: text("visibility").notNull().default("world"), // {team,world} only (no private)
    teamId: text("team_id"), // set only when visibility='team'
    embeddedAt: text("embedded_at"), // entity-vector staleness
    embedError: text("embed_error"),
    embeddingModel: text("embedding_model"), // per-row model tracking for brain-entities
    embeddingDims: integer("embedding_dims"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(), // updated_at > embedded_at drives computeStale
  },
  (t) => [
    check("entities_visibility_ck", enumCheck("visibility", ENTITY_VISIBILITIES)),
    index("idx_entities_kind").on(t.tenantId, t.kind, desc(t.updatedAt)),
  ],
)

export const entityRelations = sqliteTable(
  "entity_relations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    kind: text("kind").notNull(), // relation type
    confidence: real("confidence").notNull().default(0.5), // 0..1; on conflict -> max
    evidenceChunkIds: text("evidence_chunk_ids").notNull().default("[]"), // JSON string[]; union
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_entity_relations_key").on(t.tenantId, t.fromEntityId, t.toEntityId, t.kind),
    index("idx_entity_relations_from").on(t.tenantId, t.fromEntityId),
    index("idx_entity_relations_to").on(t.tenantId, t.toEntityId),
  ],
)

// entity_mentions: the BRIDGE from the KG to chunk|document|session|page.
export const entityMentions = sqliteTable(
  "entity_mentions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    entityId: text("entity_id").notNull(),
    sourceKind: text("source_kind").notNull(), // 'chunk'|'document'|'session'|'page'
    sourceId: text("source_id").notNull(),
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_entity_mentions_uniq").on(t.tenantId, t.entityId, t.sourceKind, t.sourceId),
    index("idx_entity_mentions_by_source").on(t.tenantId, t.sourceKind, t.sourceId),
  ],
)

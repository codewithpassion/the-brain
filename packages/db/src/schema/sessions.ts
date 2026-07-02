import { VISIBILITIES } from "@brain/shared"
import { desc, sql } from "drizzle-orm"
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { enumCheck, isoNow } from "./helpers"

/**
 * Sessions & hot memory — PRD §3.1.6 (authoritative: §8.1).
 *
 * `sessions`/`session_turns` are net-new; there is NO `session_chunks` table —
 * transcript chunks go into the shared `chunks` table inheriting the session tier.
 * Idle promotion keys on `last_activity_at` (NOT `ended_at`). `facts` ports gbrain
 * `0004_facts.sql` verbatim: the ONE `INTEGER PRIMARY KEY AUTOINCREMENT` (its
 * `superseded_by` self-ref + `facts_fts content_rowid='id'` depend on the integer
 * rowid) + the tenancy spine + 3-value `visibility`. `facts_fts` + triggers are raw SQL.
 */

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id"),
    userId: text("user_id").notNull(),
    scope: text("scope"),
    client: text("client").notNull(),
    sourceSessionId: text("source_session_id"), // the client's own id (idempotent upsert)
    title: text("title"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"), // set ONLY on explicit close
    lastActivityAt: text("last_activity_at").notNull().default(isoNow), // idle-sweep key
    status: text("status").notNull().default("open"),
    turnCount: integer("turn_count").notNull().default(0),
    r2Key: text("r2_key"), // ${tenantId}/sessions/${id}.jsonl
    contentHash: text("content_hash"), // dedup
    metadata: text("metadata"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    check(
      "sessions_client_ck",
      enumCheck("client", ["claude-code", "claude-desktop", "chatgpt", "cli", "web", "import"]),
    ),
    check("sessions_status_ck", enumCheck("status", ["open", "finalizing", "promoted", "failed"])),
    index("idx_sessions_user").on(t.tenantId, t.userId, desc(t.startedAt)),
    index("idx_sessions_client").on(t.tenantId, t.client, desc(t.startedAt)),
    index("idx_sessions_open").on(t.tenantId, t.status, t.lastActivityAt), // idle-promotion sweep
    uniqueIndex("idx_sessions_source")
      .on(t.tenantId, t.client, t.sourceSessionId)
      .where(sql`source_session_id IS NOT NULL`), // idempotent re-push
  ],
)

export const sessionTurns = sqliteTable(
  "session_turns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    idx: integer("idx").notNull(), // ordinal within session
    role: text("role").notNull(),
    content: text("content"), // short turns inline; NULL when offloaded
    r2Offset: text("r2_offset"), // "${r2_key}#L<start>-L<end>" when offloaded
    tokenCount: integer("token_count"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    check("session_turns_role_ck", enumCheck("role", ["user", "assistant", "system", "tool"])),
    uniqueIndex("idx_session_turns_order").on(t.tenantId, t.sessionId, t.idx),
  ],
)

// facts: gbrain 0004_facts.sql verbatim + tenancy + 3-value visibility.
// facts.id is the ONE INTEGER AUTOINCREMENT PK (superseded_by self-ref + facts_fts depend on it).
export const facts = sqliteTable(
  "facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    scope: text("scope"),
    teamId: text("team_id"),
    userId: text("user_id"),
    entitySlug: text("entity_slug"),
    fact: text("fact").notNull(),
    kind: text("kind").notNull().default("fact"),
    visibility: text("visibility").notNull().default("private"), // 3-value (gbrain was 2)
    notability: text("notability").notNull().default("medium"),
    context: text("context"),
    validFrom: text("valid_from").notNull().default(isoNow),
    validUntil: text("valid_until"),
    expiredAt: text("expired_at"),
    supersededBy: integer("superseded_by").references((): AnySQLiteColumn => facts.id),
    consolidatedAt: text("consolidated_at"),
    consolidatedInto: integer("consolidated_into"),
    source: text("source").notNull(), // 'mcp:extract_facts'|'session:promote'|...
    sourceSessionId: text("source_session_id"),
    confidence: real("confidence").notNull().default(1.0),
    isDreamGenerated: integer("is_dream_generated").notNull().default(0), // anti-loop guard
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    check(
      "facts_kind_ck",
      enumCheck("kind", ["event", "preference", "commitment", "belief", "fact"]),
    ),
    check("facts_visibility_ck", enumCheck("visibility", VISIBILITIES)),
    check("facts_notability_ck", enumCheck("notability", ["high", "medium", "low"])),
    check("facts_confidence_ck", sql`confidence BETWEEN 0 AND 1`),
    index("idx_facts_entity_active")
      .on(t.tenantId, t.entitySlug, desc(t.validFrom))
      .where(sql`expired_at IS NULL`),
    index("idx_facts_session")
      .on(t.tenantId, t.sourceSessionId, desc(t.createdAt))
      .where(sql`expired_at IS NULL`),
    index("idx_facts_since").on(t.tenantId, desc(t.createdAt)).where(sql`expired_at IS NULL`),
  ],
)

// brain_snapshots — two kinds (W2): 'pinned' = §8.5 page-version pins (manifest); 'session-context'
// = the auto-injected curated markdown (content), one per tenant at a deterministic id.
export const brainSnapshots = sqliteTable(
  "brain_snapshots",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    scope: text("scope"),
    label: text("label").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    manifest: text("manifest").notNull(), // JSON: pinned immutable version ids ('pinned' kind)
    kind: text("kind").notNull().default("pinned"), // 'pinned' | 'session-context' (W2)
    content: text("content"), // curated markdown for the 'session-context' kind (W2)
  },
  (t) => [index("idx_snapshots_tenant").on(t.tenantId, desc(t.createdAt))],
)

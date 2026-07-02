import { desc, sql } from "drizzle-orm"
import {
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
 * Jobs, ingest & ops — PRD §3.1.7. `backfill_runs` is authoritative §8.1; `sources`/
 * `mcp_request_log` re-scoped from gbrain `0005_platform.sql`/`0009_sync.sql`;
 * `ingest_log` and `token_spend` consolidated from their §4/§5/§10 call sites.
 * `token_spend` is the ENFORCING cost cap (429 before `env.AI.run`).
 */

export const backfillRuns = sqliteTable(
  "backfill_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(), // session|repo|doc|gmail|ob1|reembed
    direction: text("direction").notNull().default("backfill"),
    status: text("status").notNull().default("queued"),
    cursor: text("cursor"), // importer opaque resume cursor
    anchor: text("anchor"), // durable anchor (advances only on clean pass)
    stats: text("stats"), // JSON {processed,created,skipped,errors,merged}
    attempts: integer("attempts").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    note: text("note"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    check("backfill_runs_direction_ck", enumCheck("direction", ["backfill", "incremental"])),
    check(
      "backfill_runs_status_ck",
      enumCheck("status", ["queued", "running", "success", "failure", "cancelled"]),
    ),
    index("idx_backfill_status").on(t.tenantId, t.sourceId, t.status),
  ],
)

/**
 * `dream_runs` — the Dream engine's run-state row (v2 W1/D1), a deliberate SIBLING of
 * `backfill_runs` (not a `kind='dream'` reuse) so the Jobs/Dreams dashboards can label and
 * query dream runs on their own. Same OPS-table discipline: `tenant_id` FORCED from the
 * Principal, writes carry NO `memory_audit` row and are NOT `readOnly`-gated (run counters,
 * recorded regardless of actor). `stats` is a JSON `DreamRunStats` roll-up; `cursor` is the
 * last-processed cluster key (a non-null cursor on a `success` row means the run stopped on
 * budget and is resumable — D-i3).
 */
export const dreamRuns = sqliteTable(
  "dream_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(), // consolidation|reflection|dedup|hygiene
    status: text("status").notNull().default("queued"),
    cursor: text("cursor"), // last-processed cluster key (resume point)
    stats: text("stats"), // JSON {clustersJudged,merged,superseded,contradictions,kept,neurons}
    attempts: integer("attempts").notNull().default(0),
    note: text("note"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    check(
      "dream_runs_kind_ck",
      enumCheck("kind", ["consolidation", "reflection", "digest", "dedup", "hygiene"]),
    ),
    check(
      "dream_runs_status_ck",
      enumCheck("status", ["queued", "running", "paused", "success", "failure", "cancelled"]),
    ),
    index("idx_dream_status").on(t.tenantId, t.status),
  ],
)

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind"),
    localPath: text("local_path"),
    lastCommit: text("last_commit"),
    lastSyncAt: text("last_sync_at"), // durable anchor (advances only on clean pass)
    config: text("config").notNull().default("{}"),
    lastAttemptAt: text("last_attempt_at"), // gates exponential backoff
    syncFailCount: integer("sync_fail_count").notNull().default(0), // backoff = base * 2^this
    archived: integer("archived").notNull().default(0),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [uniqueIndex("ux_sources_tenant").on(t.tenantId, t.id)],
)

export const ingestLog = sqliteTable(
  "ingest_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sourceId: text("source_id"),
    sourceKind: text("source_kind"),
    action: text("action").notNull(), // 'received'|'skipped'|'indexed'|'duplicate'|'failed'
    fingerprint: text("fingerprint"),
    chunks: integer("chunks"),
    summary: text("summary").notNull().default(""),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("idx_ingest_log_tenant_created").on(t.tenantId, t.createdAt)],
)

// token_spend: per-tenant model-spend ledger. One row per (tenant, window, model).
export const tokenSpend = sqliteTable(
  "token_spend",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    window: text("window").notNull(), // '2026-06' | 'YYYY-MM-DD'
    model: text("model").notNull(), // '@cf/baai/bge-m3' | ...
    surface: text("surface"), // 'think'|'ingest'|'migration'
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    neurons: real("neurons").notNull().default(0), // @cf/ neuron accounting (v1 billed unit)
    budgetNeurons: real("budget_neurons"), // per-window cap; NULL = unlimited
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    // Surface is part of the key (COALESCE null→'') so dream/think/ingest spend on the SAME model
    // do NOT collide into one row (they share GENERATION_MODEL). Legacy null-surface rows stay unique.
    uniqueIndex("ux_token_spend_window").on(
      t.tenantId,
      t.window,
      t.model,
      sql`coalesce(${t.surface}, '')`,
    ),
    index("ix_token_spend_tenant").on(t.tenantId, desc(t.updatedAt)),
  ],
)

export const mcpRequestLog = sqliteTable(
  "mcp_request_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(), // NET-NEW vs gbrain
    tokenName: text("token_name"),
    operation: text("operation").notNull(),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull().default("ok"), // 'ok'|'error'
    errorMessage: text("error_message"), // message only; never params/PII
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("idx_mcp_log_tenant_created").on(t.tenantId, t.createdAt),
    index("idx_mcp_log_operation").on(t.operation),
  ],
)

import { TRUST_GRADES } from "@brain/shared"
import { desc } from "drizzle-orm"
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { enumCheck } from "./helpers"

/**
 * Trust & governance sidecars — PRD §3.1.5 (authoritative: §7.5/§7.6).
 *
 * PRINCIPLED req-4 exception: these carry `tenant_id` + `target_id` only (they hang
 * off a target, not a tenancy spine). `trust_grade` lives HERE, never on
 * chunks/facts/documents (LEFT-JOINed at read, default 'evidence'). `memory_audit`
 * and `memory_recall_traces` are APPEND-ONLY and use epoch-ms `INTEGER at` with NO
 * default (set by the writer in the same `db.batch` as the change, §7.6).
 */

// trust_grade lives HERE, not on chunks/facts.
export const memoryUsePolicy = sqliteTable(
  "memory_use_policy",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    targetId: text("target_id").notNull(), // fact/chunk/document id
    trustGrade: text("trust_grade").notNull().default("evidence"),
    scopes: text("scopes").notNull().default("[]"),
    expiresAt: text("expires_at"),
  },
  () => [check("memory_use_policy_trust_grade_ck", enumCheck("trust_grade", TRUST_GRADES))],
)

export const memoryProvenance = sqliteTable(
  "memory_provenance",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    targetId: text("target_id").notNull(),
    origin: text("origin").notNull(),
    agent: text("agent"),
    sessionId: text("session_id"),
    capturedAt: text("captured_at").notNull(),
  },
  () => [
    check(
      "memory_provenance_origin_ck",
      enumCheck("origin", ["human", "agent_inferred", "agent_generated", "import"]),
    ),
  ],
)

export const memoryReview = sqliteTable(
  "memory_review",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    targetId: text("target_id").notNull(),
    status: text("status").notNull(),
    reviewer: text("reviewer").notNull(),
    reviewedAt: text("reviewed_at").notNull(),
    note: text("note"),
  },
  () => [
    check(
      "memory_review_status_ck",
      enumCheck("status", ["unreviewed", "confirmed", "rejected", "needs_revision"]),
    ),
  ],
)

// append-only; epoch-ms `at`; written IN the same db.batch as the change.
export const memoryAudit = sqliteTable(
  "memory_audit",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(), // actor
    action: text("action").notNull(), // 'fact.create'|'usePolicy.promote'|...
    targetId: text("target_id"),
    at: integer("at").notNull(), // epoch-ms (no default)
    diff: text("diff"), // opaque JSON
  },
  (t) => [index("memory_audit_tenant_at").on(t.tenantId, desc(t.at))],
)

// one row per KEPT hit; append-only; off the synchronous read path.
export const memoryRecallTraces = sqliteTable(
  "memory_recall_traces",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(), // author of the recall (read-restricted)
    query: text("query").notNull(),
    targetId: text("target_id").notNull(),
    score: real("score").notNull(),
    clientId: text("client_id").notNull(), // which AI client surfaced it
    at: integer("at").notNull(), // epoch-ms (no default)
  },
  (t) => [index("recall_traces_tenant_at").on(t.tenantId, desc(t.at))],
)

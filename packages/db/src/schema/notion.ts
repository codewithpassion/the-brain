import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { isoNow } from "./helpers"

/**
 * Notion connection store — per-tenant OAuth bot tokens for the Notion sync integration
 * (docs/notion-integration-plan.md §2). The reversed-direction sibling of `vault_credentials`:
 * the Brain holds Notion's bearer token and calls Notion AS the client, so — unlike the vault
 * credential (only ever hashed) — this token must be REVERSIBLY encrypted (AES-GCM via the
 * `NOTION_TOKEN_ENC_KEY` Worker secret). `token_ciphertext`/`refresh_token_ciphertext` are the
 * ONLY stored form; the plaintext token is never persisted, logged, or returned from any op.
 *
 * `workspace_id` is GLOBALLY unique (one workspace maps to exactly one tenant) — that mapping
 * is what routes inbound webhooks to a tenant (`workspace_id → tenant`). Revocation is soft
 * (`revoked_at`) so audit history is preserved and the poller/webhook fail closed on a revoked
 * connection.
 */
export const notionConnections = sqliteTable(
  "notion_connections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** Notion workspace id — globally unique; the `workspace_id → tenant` webhook-routing key. */
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name"),
    botId: text("bot_id"),
    /** AES-GCM(access_token). Never returned to any caller. */
    tokenCiphertext: text("token_ciphertext").notNull(),
    /** AES-GCM(refresh_token). Nullable — older Notion grants omit it. Never returned. */
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    /** The Clerk userId of the actor who established this connection. */
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    /** NULL = active; ISO-8601 timestamp = revoked. */
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("ux_notion_workspace").on(t.workspaceId), // workspace→tenant routing (O(1))
    index("ix_notion_conn_tenant").on(t.tenantId), // tenant-scoped list
  ],
)

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { isoNow } from "./helpers"

/**
 * Tenancy & auth spine — PRD §3.1.4 (authoritative: §7.1).
 *
 * `orgs` IS the tenant (its `id` is the `tenant_id` everywhere else). There is NO
 * `users` table — `memberships.user_id` is the Clerk subject and the row IS the
 * per-tenant user record. `bdev_` machine tokens are STATELESS HMAC (tenant baked
 * into the claims, §7) and therefore have NO table here; the only CLI-credential
 * rows are the device-flow `cli_auth_sessions`/`cli_refresh_tokens` ported from
 * cf-graph.
 */

// orgs: org IS the tenant — principled exception to the req-4 tenancy columns.
export const orgs = sqliteTable(
  "orgs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    flags: text("flags").default("{}"),
    // createdBy: the Clerk userId of the user who created this org. NULL for orgs that were
    // auto-provisioned before this column was added (personal orgs from before migration 0002).
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [uniqueIndex("orgs_slug_ux").on(t.slug)],
)

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
  },
  (t) => [uniqueIndex("teams_tenant_slug_ux").on(t.tenantId, t.slug)],
)

// memberships: the local user↔tenant join (net-new; there is no `users` table).
export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(), // Clerk sub
    teamId: text("team_id"), // NULL = tenant-wide membership
    role: text("role").notNull(), // 'owner'|'admin'|'member'|'readonly'
    allowedScopes: text("allowed_scopes"), // DATA-partition grant: JSON string[] | NULL(='*')
    // createdBy: the Clerk userId of the admin who added this membership. NULL for memberships that
    // existed before this column was added (auto-provisioned personal memberships + org-create).
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("memberships_user_ix").on(t.userId),
    index("memberships_tenant_ix").on(t.tenantId, t.userId),
  ],
)

// scopes: ports openbrains `projects` + tenant_id/team_id.
export const scopes = sqliteTable(
  "scopes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("scopes_tenant_slug_ux").on(t.tenantId, t.slug)],
)

// api_keys: SHA-256 hash, bound to ONE tenant. capability axis = `scopes` JSON.
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(), // minting actor
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"), // CAPABILITY axis, e.g. ["read","write"]
    allowedScopes: text("allowed_scopes"), // DATA-partition grant, pinned at mint
    readOnly: integer("read_only").notNull().default(0),
    createdAt: text("created_at"),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_hash_ux").on(t.keyHash)],
)

// device-code flow, ported verbatim from cf-graph (tenant_id nullable here).
export const cliAuthSessions = sqliteTable("cli_auth_sessions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  deviceCode: text("device_code").notNull(),
  userCode: text("user_code").notNull(),
  status: text("status").notNull().default("pending"),
  userId: text("user_id"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: text("token_expires_at"),
  expiresAt: text("expires_at").notNull(),
  pollInterval: integer("poll_interval").notNull().default(5),
  createdAt: text("created_at").notNull(),
})

// cli_refresh_tokens: keyed by user_id (an auth artifact, not tenant data — no tenant_id).
export const cliRefreshTokens = sqliteTable("cli_refresh_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
})

// tenant_shards: the shard map (single-shard in v1; columns retained for forward-compat).
// PRINCIPLED EXCEPTION: keyed by tenant_id (it IS the per-tenant routing row).
export const tenantShards = sqliteTable("tenant_shards", {
  tenantId: text("tenant_id").primaryKey(),
  dbBinding: text("db_binding").notNull(), // always 'DB' in v1
  chunkIndex: text("chunk_index").notNull(), // 'brain-chunks' in v1
  entityIndex: text("entity_index"), // 'brain-entities' in v1
})

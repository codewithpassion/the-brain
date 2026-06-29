import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { isoNow } from "./helpers"

/**
 * Vault credential store — per-tenant credentials for the WebDAV sync facade
 * (docs/r2-facade-plan.md §4). Each row is a hashed secret that Remotely Save
 * sends via HTTP Basic; `secret_hash = SHA-256(password)` is the only stored form.
 * The raw password is shown ONCE at creation and is NEVER stored in plaintext.
 * Revocation is soft (`revoked_at`) so audit history is preserved.
 */
export const vaultCredentials = sqliteTable(
  "vault_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    /** `vk_<16 hex>` — the identity exposed to the client (not a secret). */
    username: text("username").notNull(),
    /** SHA-256(password) as lowercase hex. Never returned to any caller. */
    secretHash: text("secret_hash").notNull(),
    label: text("label"),
    createdAt: text("created_at").notNull().default(isoNow),
    /** The Clerk userId of the actor who minted this credential. */
    createdBy: text("created_by").notNull(),
    /** NULL = active; ISO-8601 timestamp = revoked. */
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("ux_vault_cred_username").on(t.username), // O(1) auth lookup
    index("ix_vault_cred_tenant").on(t.tenantId), // tenant-scoped list
  ],
)

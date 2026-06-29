CREATE TABLE `vault_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`username` text NOT NULL,
	`secret_hash` text NOT NULL,
	`label` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_vault_cred_username` ON `vault_credentials` (`username`);--> statement-breakpoint
CREATE INDEX `ix_vault_cred_tenant` ON `vault_credentials` (`tenant_id`);
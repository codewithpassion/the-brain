CREATE TABLE `notion_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_name` text,
	`bot_id` text,
	`token_ciphertext` text NOT NULL,
	`refresh_token_ciphertext` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_notion_workspace` ON `notion_connections` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `ix_notion_conn_tenant` ON `notion_connections` (`tenant_id`);

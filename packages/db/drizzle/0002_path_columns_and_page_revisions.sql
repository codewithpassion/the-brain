-- Drizzle-generated base-table catch-up (registered in meta/_journal.json + 0002_snapshot.json):
-- the `page_revisions` history table (OKF memory) + the path/created_by/created_at columns that
-- were previously applied via hand-written ALTERs. Re-running `db:generate` is now a clean no-op.
-- FTS5 + expression/partial indexes Drizzle cannot model stay hand-written in 0001.
CREATE TABLE `page_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`page_id` text NOT NULL,
	`version` integer NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`compiled_truth` text NOT NULL,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`visibility` text NOT NULL,
	`author_user_id` text,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_page_revisions_page` ON `page_revisions` (`tenant_id`,`page_id`,"id" desc);--> statement-breakpoint
ALTER TABLE `chunks` ADD `path` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `path` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `memberships` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `created_by` text;
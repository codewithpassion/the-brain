-- Per-page version history for OKF-compatible agent memory (docs/okf-memory-plan.md §5).
-- Distinct from `page_versions` (snapshot-pinning): this is the per-concept edit log that
-- backs `memory_history` + forward-only `memory_rollback`. Integer rowid `id` gives a
-- monotonic, collision-free ordering + a stable version handle.
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
CREATE INDEX `idx_page_revisions_page` ON `page_revisions` (`tenant_id`,`page_id`,`id` DESC);

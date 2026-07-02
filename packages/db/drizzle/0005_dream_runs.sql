CREATE TABLE `dream_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`cursor` text,
	`stats` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`note` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "dream_runs_kind_ck" CHECK(kind IN ('consolidation', 'reflection', 'dedup', 'hygiene')),
	CONSTRAINT "dream_runs_status_ck" CHECK(status IN ('queued', 'running', 'paused', 'success', 'failure', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_dream_status` ON `dream_runs` (`tenant_id`,`status`);

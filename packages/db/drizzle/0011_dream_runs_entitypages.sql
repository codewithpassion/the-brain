CREATE TABLE `dream_runs_new` (
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
	CONSTRAINT "dream_runs_kind_ck" CHECK(kind IN ('consolidation', 'reflection', 'digest', 'dedup', 'hygiene', 'entitypages')),
	CONSTRAINT "dream_runs_status_ck" CHECK(status IN ('queued', 'running', 'paused', 'success', 'failure', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `dream_runs_new` SELECT * FROM `dream_runs`;--> statement-breakpoint
DROP TABLE `dream_runs`;--> statement-breakpoint
ALTER TABLE `dream_runs_new` RENAME TO `dream_runs`;--> statement-breakpoint
CREATE INDEX `idx_dream_status` ON `dream_runs` (`tenant_id`,`status`);

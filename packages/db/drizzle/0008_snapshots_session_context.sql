ALTER TABLE `brain_snapshots` ADD `kind` text DEFAULT 'pinned' NOT NULL;--> statement-breakpoint
ALTER TABLE `brain_snapshots` ADD `content` text;--> statement-breakpoint
ALTER TABLE `memory_use_policy` ADD `updated_at` text;

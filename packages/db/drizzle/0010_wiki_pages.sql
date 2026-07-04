ALTER TABLE `pages` ADD `entity_id` text;--> statement-breakpoint
CREATE INDEX `ix_pages_entity` ON `pages` (`tenant_id`,`entity_id`);--> statement-breakpoint
CREATE TABLE `pending_links` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`from_page_id` text NOT NULL,
	`target_slug` text NOT NULL,
	`link_source` text DEFAULT 'wiki' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_pending_links` ON `pending_links` (`tenant_id`,`from_page_id`,`target_slug`);--> statement-breakpoint
CREATE INDEX `ix_pending_links_target` ON `pending_links` (`tenant_id`,`target_slug`);

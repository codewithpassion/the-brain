ALTER TABLE `documents` ADD `origin` text;--> statement-breakpoint
DROP INDEX `ux_token_spend_window`;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_token_spend_window` ON `token_spend` (`tenant_id`,`window`,`model`,(coalesce(`surface`, '')));--> statement-breakpoint
CREATE INDEX `idx_entity_mentions_created` ON `entity_mentions` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_documents_created` ON `documents` (`tenant_id`,`created_at`);

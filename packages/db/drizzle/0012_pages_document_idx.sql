CREATE UNIQUE INDEX `ix_pages_document` ON `pages` (`tenant_id`,`document_id`) WHERE `document_id` IS NOT NULL AND `deleted_at` IS NULL;

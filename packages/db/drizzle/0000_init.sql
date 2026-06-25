CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`document_id` text NOT NULL,
	`scope` text,
	`team_id` text,
	`user_id` text,
	`visibility` text DEFAULT 'world' NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`heading_path` text,
	`token_count` integer,
	`chunk_source` text,
	`embedded_at` text,
	`embed_error` text,
	`embedding_model` text NOT NULL,
	`embedding_dims` integer NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "chunks_visibility_ck" CHECK(visibility IN ('private', 'team', 'world'))
);
--> statement-breakpoint
CREATE INDEX `ix_chunks_tenant_doc` ON `chunks` (`tenant_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`team_id` text,
	`scope` text,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text,
	`content_type` text,
	`body_r2_key` text,
	`markdown_preview` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`parent_document_id` text,
	`part_index` integer,
	`part_count` integer,
	`fingerprint` text NOT NULL,
	`chunk_count` integer DEFAULT 0,
	`source_id` text,
	`source_kind` text,
	`source_uri` text,
	`ingested_via` text,
	`ingested_at` text,
	`tags` text DEFAULT '[]',
	`metadata` text,
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_documents_tenant_fp` ON `documents` (`tenant_id`,`scope`,`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_documents_tenant_slug` ON `documents` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `ix_documents_tenant_source` ON `documents` (`tenant_id`,`source_id`,`status`);--> statement-breakpoint
CREATE TABLE `doc_links` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`link_type` text DEFAULT '' NOT NULL,
	`link_source` text DEFAULT 'manual' NOT NULL,
	`origin_id` text,
	`origin_field` text,
	`context` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_doc_links_from` ON `doc_links` (`tenant_id`,`from_id`);--> statement-breakpoint
CREATE INDEX `idx_doc_links_to` ON `doc_links` (`tenant_id`,`to_id`);--> statement-breakpoint
CREATE TABLE `page_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`page_id` text NOT NULL,
	`compiled_truth` text NOT NULL,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`snapshot_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_page_versions_page` ON `page_versions` (`tenant_id`,`page_id`,"snapshot_at" desc);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`team_id` text,
	`scope` text,
	`user_id` text,
	`slug` text NOT NULL,
	`type` text DEFAULT 'note' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`visibility` text DEFAULT 'world' NOT NULL,
	`compiled_truth` text DEFAULT '' NOT NULL,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`document_id` text,
	`source_id` text,
	`source_kind` text,
	`source_uri` text,
	`ingested_via` text,
	`ingested_at` text,
	`effective_date` text,
	`effective_date_source` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text,
	CONSTRAINT "pages_visibility_ck" CHECK(visibility IN ('private', 'team', 'world'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_pages_tenant_slug` ON `pages` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `ix_pages_tenant_type` ON `pages` (`tenant_id`,`type`);--> statement-breakpoint
CREATE INDEX `ix_pages_tenant_updated` ON `pages` (`tenant_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_pages_source` ON `pages` (`tenant_id`,`source_id`,`ingested_via`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`tenant_id` text NOT NULL,
	`page_id` text NOT NULL,
	`tag` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tags_tag` ON `tags` (`tenant_id`,`tag`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_tenant_id_page_id_tag_unique` ON `tags` (`tenant_id`,`page_id`,`tag`);--> statement-breakpoint
CREATE TABLE `timeline_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`page_id` text NOT NULL,
	`date` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`summary` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `timeline_entries_tenant_id_page_id_date_summary_unique` ON `timeline_entries` (`tenant_id`,`page_id`,`date`,`summary`);--> statement-breakpoint
CREATE TABLE `memory_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text,
	`at` integer NOT NULL,
	`diff` text
);
--> statement-breakpoint
CREATE INDEX `memory_audit_tenant_at` ON `memory_audit` (`tenant_id`,"at" desc);--> statement-breakpoint
CREATE TABLE `memory_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`target_id` text NOT NULL,
	`origin` text NOT NULL,
	`agent` text,
	`session_id` text,
	`captured_at` text NOT NULL,
	CONSTRAINT "memory_provenance_origin_ck" CHECK(origin IN ('human', 'agent_inferred', 'agent_generated', 'import'))
);
--> statement-breakpoint
CREATE TABLE `memory_recall_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`query` text NOT NULL,
	`target_id` text NOT NULL,
	`score` real NOT NULL,
	`client_id` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recall_traces_tenant_at` ON `memory_recall_traces` (`tenant_id`,"at" desc);--> statement-breakpoint
CREATE TABLE `memory_review` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`reviewer` text NOT NULL,
	`reviewed_at` text NOT NULL,
	`note` text,
	CONSTRAINT "memory_review_status_ck" CHECK(status IN ('unreviewed', 'confirmed', 'rejected', 'needs_revision'))
);
--> statement-breakpoint
CREATE TABLE `memory_use_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`target_id` text NOT NULL,
	`trust_grade` text DEFAULT 'evidence' NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`expires_at` text,
	CONSTRAINT "memory_use_policy_trust_grade_ck" CHECK(trust_grade IN ('instruction', 'evidence', 'draft'))
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`canonical_name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_chunk_ids` text DEFAULT '[]' NOT NULL,
	`mention_count` integer DEFAULT 0 NOT NULL,
	`scope` text,
	`visibility` text DEFAULT 'world' NOT NULL,
	`team_id` text,
	`embedded_at` text,
	`embed_error` text,
	`embedding_model` text,
	`embedding_dims` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "entities_visibility_ck" CHECK(visibility IN ('team', 'world'))
);
--> statement-breakpoint
CREATE INDEX `idx_entities_kind` ON `entities` (`tenant_id`,`kind`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `entity_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`span_start` integer,
	`span_end` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entity_mentions_uniq` ON `entity_mentions` (`tenant_id`,`entity_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_mentions_by_source` ON `entity_mentions` (`tenant_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `entity_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`from_entity_id` text NOT NULL,
	`to_entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`evidence_chunk_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entity_relations_key` ON `entity_relations` (`tenant_id`,`from_entity_id`,`to_entity_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_entity_relations_from` ON `entity_relations` (`tenant_id`,`from_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_relations_to` ON `entity_relations` (`tenant_id`,`to_entity_id`);--> statement-breakpoint
CREATE TABLE `backfill_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`direction` text DEFAULT 'backfill' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`cursor` text,
	`anchor` text,
	`stats` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`note` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "backfill_runs_direction_ck" CHECK(direction IN ('backfill', 'incremental')),
	CONSTRAINT "backfill_runs_status_ck" CHECK(status IN ('queued', 'running', 'success', 'failure', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_backfill_status` ON `backfill_runs` (`tenant_id`,`source_id`,`status`);--> statement-breakpoint
CREATE TABLE `ingest_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_id` text,
	`source_kind` text,
	`action` text NOT NULL,
	`fingerprint` text,
	`chunks` integer,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ingest_log_tenant_created` ON `ingest_log` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mcp_request_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`token_name` text,
	`operation` text NOT NULL,
	`latency_ms` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_log_tenant_created` ON `mcp_request_log` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_log_operation` ON `mcp_request_log` (`operation`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`local_path` text,
	`last_commit` text,
	`last_sync_at` text,
	`config` text DEFAULT '{}' NOT NULL,
	`last_attempt_at` text,
	`sync_fail_count` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_sources_tenant` ON `sources` (`tenant_id`,`id`);--> statement-breakpoint
CREATE TABLE `token_spend` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`window` text NOT NULL,
	`model` text NOT NULL,
	`surface` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`neurons` real DEFAULT 0 NOT NULL,
	`budget_neurons` real,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_token_spend_window` ON `token_spend` (`tenant_id`,`window`,`model`);--> statement-breakpoint
CREATE INDEX `ix_token_spend_tenant` ON `token_spend` (`tenant_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `brain_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`scope` text,
	`label` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`manifest` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_tenant` ON `brain_snapshots` (`tenant_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`scope` text,
	`team_id` text,
	`user_id` text,
	`entity_slug` text,
	`fact` text NOT NULL,
	`kind` text DEFAULT 'fact' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`notability` text DEFAULT 'medium' NOT NULL,
	`context` text,
	`valid_from` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`valid_until` text,
	`expired_at` text,
	`superseded_by` integer,
	`consolidated_at` text,
	`consolidated_into` integer,
	`source` text NOT NULL,
	`source_session_id` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`is_dream_generated` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`superseded_by`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "facts_kind_ck" CHECK(kind IN ('event', 'preference', 'commitment', 'belief', 'fact')),
	CONSTRAINT "facts_visibility_ck" CHECK(visibility IN ('private', 'team', 'world')),
	CONSTRAINT "facts_notability_ck" CHECK(notability IN ('high', 'medium', 'low')),
	CONSTRAINT "facts_confidence_ck" CHECK(confidence BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE INDEX `idx_facts_entity_active` ON `facts` (`tenant_id`,`entity_slug`,"valid_from" desc) WHERE expired_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_facts_session` ON `facts` (`tenant_id`,`source_session_id`,"created_at" desc) WHERE expired_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_facts_since` ON `facts` (`tenant_id`,"created_at" desc) WHERE expired_at IS NULL;--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`r2_offset` text,
	`token_count` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "session_turns_role_ck" CHECK(role IN ('user', 'assistant', 'system', 'tool'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_turns_order` ON `session_turns` (`tenant_id`,`session_id`,`idx`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`team_id` text,
	`user_id` text NOT NULL,
	`scope` text,
	`client` text NOT NULL,
	`source_session_id` text,
	`title` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`last_activity_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`r2_key` text,
	`content_hash` text,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "sessions_client_ck" CHECK(client IN ('claude-code', 'claude-desktop', 'chatgpt', 'cli', 'web', 'import')),
	CONSTRAINT "sessions_status_ck" CHECK(status IN ('open', 'finalizing', 'promoted', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`tenant_id`,`user_id`,"started_at" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_client` ON `sessions` (`tenant_id`,`client`,"started_at" desc);--> statement-breakpoint
CREATE INDEX `idx_sessions_open` ON `sessions` (`tenant_id`,`status`,`last_activity_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_source` ON `sessions` (`tenant_id`,`client`,`source_session_id`) WHERE source_session_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`allowed_scopes` text,
	`read_only` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_ux` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `cli_auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` text,
	`expires_at` text NOT NULL,
	`poll_interval` integer DEFAULT 5 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cli_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text,
	`role` text NOT NULL,
	`allowed_scopes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memberships_user_ix` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_ix` ON `memberships` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`flags` text DEFAULT '{}',
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_slug_ux` ON `orgs` (`slug`);--> statement-breakpoint
CREATE TABLE `scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`team_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scopes_tenant_slug_ux` ON `scopes` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_tenant_slug_ux` ON `teams` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE TABLE `tenant_shards` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`db_binding` text NOT NULL,
	`chunk_index` text NOT NULL,
	`entity_index` text
);

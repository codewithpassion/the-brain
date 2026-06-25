-- Phase 1b raw DDL that Drizzle sqlite-core cannot model.
-- Two parts, both authoritative per PRD §3:
--   (A) expression indexes (COALESCE/lower) — the deterministic dedup keys;
--   (B) FTS5 external-content virtual tables + their INSERT/DELETE/UPDATE sync
--       triggers. The _fts tables carry NO tenant_id by design (invariant 4):
--       MATCH stays pure text; the search layer JOINs each rowid back to the
--       tenant-scoped base table and re-checks tenant_id/scope/visibility before
--       any row leaves the keyword arm. `chunks_fts`/`entity_fts` are
--       content_rowid='rowid'; `facts_fts` is content_rowid='id' (facts' INTEGER
--       AUTOINCREMENT PK), so its triggers reference new.id/old.id.

-- ── (A) Expression indexes ───────────────────────────────────────────────────
-- entities deterministic dedup key: case-insensitive + scope-partitioned
-- (COALESCE(scope,'') so the unrestricted scope=NULL partition still dedups).
CREATE UNIQUE INDEX `idx_entities_key` ON `entities` (`tenant_id`, COALESCE(`scope`, ''), `kind`, lower(`canonical_name`));--> statement-breakpoint
-- doc_links edge-dedup key (gbrain COALESCE-on-nullable origin_id, + tenant_id).
CREATE UNIQUE INDEX `idx_doc_links_unique` ON `doc_links` (`tenant_id`, `from_id`, `to_id`, `link_type`, `link_source`, COALESCE(`origin_id`, ''));--> statement-breakpoint

-- ── (B) chunks_fts (authoritative: §4.9) ─────────────────────────────────────
CREATE VIRTUAL TABLE `chunks_fts` USING fts5(heading_path, content, content='chunks', content_rowid='rowid');--> statement-breakpoint
CREATE TRIGGER `chunks_ai` AFTER INSERT ON `chunks` BEGIN
  INSERT INTO chunks_fts(rowid, heading_path, content) VALUES (new.rowid, new.heading_path, new.content);
END;--> statement-breakpoint
CREATE TRIGGER `chunks_ad` AFTER DELETE ON `chunks` BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content) VALUES('delete', old.rowid, old.heading_path, old.content);
END;--> statement-breakpoint
CREATE TRIGGER `chunks_au` AFTER UPDATE ON `chunks` BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content) VALUES('delete', old.rowid, old.heading_path, old.content);
  INSERT INTO chunks_fts(rowid, heading_path, content) VALUES (new.rowid, new.heading_path, new.content);
END;--> statement-breakpoint

-- ── (B) entity_fts (authoritative: §6.1) ─────────────────────────────────────
CREATE VIRTUAL TABLE `entity_fts` USING fts5(canonical_name, aliases, description, content='entities', content_rowid='rowid');--> statement-breakpoint
CREATE TRIGGER `entities_ai` AFTER INSERT ON `entities` BEGIN
  INSERT INTO entity_fts(rowid, canonical_name, aliases, description) VALUES (new.rowid, new.canonical_name, new.aliases, new.description);
END;--> statement-breakpoint
CREATE TRIGGER `entities_ad` AFTER DELETE ON `entities` BEGIN
  INSERT INTO entity_fts(entity_fts, rowid, canonical_name, aliases, description) VALUES('delete', old.rowid, old.canonical_name, old.aliases, old.description);
END;--> statement-breakpoint
CREATE TRIGGER `entities_au` AFTER UPDATE ON `entities` BEGIN
  INSERT INTO entity_fts(entity_fts, rowid, canonical_name, aliases, description) VALUES('delete', old.rowid, old.canonical_name, old.aliases, old.description);
  INSERT INTO entity_fts(rowid, canonical_name, aliases, description) VALUES (new.rowid, new.canonical_name, new.aliases, new.description);
END;--> statement-breakpoint

-- ── (B) facts_fts (authoritative: §8.1; content_rowid='id') ──────────────────
CREATE VIRTUAL TABLE `facts_fts` USING fts5(fact, entity_slug, content='facts', content_rowid='id');--> statement-breakpoint
CREATE TRIGGER `facts_ai` AFTER INSERT ON `facts` BEGIN
  INSERT INTO facts_fts(rowid, fact, entity_slug) VALUES (new.id, new.fact, new.entity_slug);
END;--> statement-breakpoint
CREATE TRIGGER `facts_ad` AFTER DELETE ON `facts` BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, fact, entity_slug) VALUES('delete', old.id, old.fact, old.entity_slug);
END;--> statement-breakpoint
CREATE TRIGGER `facts_au` AFTER UPDATE ON `facts` BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, fact, entity_slug) VALUES('delete', old.id, old.fact, old.entity_slug);
  INSERT INTO facts_fts(rowid, fact, entity_slug) VALUES (new.id, new.fact, new.entity_slug);
END;

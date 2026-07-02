import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Phase 1b migration-validity gate.
 *
 * Loads EVERY generated migration SQL file (base tables + the raw FTS5/expression
 * file) in lexicographic order into a fresh in-memory SQLite (bun:sqlite ships FTS5),
 * then asserts:
 *   1. all tables / indexes / FTS5 virtual tables / triggers create without error;
 *   2. the FTS5 sync triggers actually keep each _fts shadow in step on
 *      INSERT / UPDATE / DELETE (the part most likely to be silently wrong);
 *   3. the high-risk faithfulness invariants of PRD §3 survived generation — CHECK
 *      lists, facts' INTEGER AUTOINCREMENT pk, the COALESCE/lower expression indexes,
 *      the epoch-ms audit columns, and the partial indexes.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle")

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()

const freshDb = (): Database => {
  const db = new Database(":memory:")
  for (const file of migrationFiles()) {
    db.run(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  }
  return db
}

const names = (db: Database, type: string): string[] =>
  (db.query(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map(
    (row) => row.name,
  )

const sqlOf = (db: Database, name: string): string =>
  (db.query(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as { sql: string | null })
    .sql ?? ""

const BASE_TABLES = [
  "orgs",
  "teams",
  "memberships",
  "scopes",
  "api_keys",
  "cli_auth_sessions",
  "cli_refresh_tokens",
  "tenant_shards",
  "documents",
  "chunks",
  "pages",
  "doc_links",
  "tags",
  "timeline_entries",
  "page_versions",
  "page_revisions",
  "entities",
  "entity_relations",
  "entity_mentions",
  "memory_use_policy",
  "memory_provenance",
  "memory_review",
  "memory_audit",
  "memory_recall_traces",
  "sessions",
  "session_turns",
  "facts",
  "brain_snapshots",
  "backfill_runs",
  "sources",
  "ingest_log",
  "token_spend",
  "mcp_request_log",
  "vault_credentials",
]

describe("migrations apply cleanly", () => {
  test("the migration set is the drizzle-managed base + hand-written FTS + the base catch-up", () => {
    // Base-table DDL is drizzle-generated (0000, 0002, 0003); only the FTS5/expression SQL drizzle
    // cannot model stays hand-written (0001). `db:generate` is a clean no-op after each migration.
    expect(migrationFiles()).toEqual([
      "0000_init.sql",
      "0001_fts5_and_expression_indexes.sql",
      "0002_path_columns_and_page_revisions.sql",
      "0003_smooth_leper_queen.sql",
      "0004_huge_harpoon.sql",
      "0005_dream_runs.sql",
    ])
  })

  test("loading every migration in order does not throw", () => {
    expect(() => freshDb()).not.toThrow()
  })

  test("every base table from PRD §3.1 exists", () => {
    const tables = new Set(names(freshDb(), "table"))
    for (const table of BASE_TABLES) {
      expect(tables.has(table)).toBe(true)
    }
  })

  test("the three FTS5 external-content virtual tables exist", () => {
    const db = freshDb()
    for (const fts of ["chunks_fts", "entity_fts", "facts_fts"]) {
      expect(sqlOf(db, fts)).toContain("USING fts5")
    }
  })

  test("all nine FTS sync triggers exist", () => {
    const triggers = new Set(names(freshDb(), "trigger"))
    for (const trigger of [
      "chunks_ai",
      "chunks_ad",
      "chunks_au",
      "entities_ai",
      "entities_ad",
      "entities_au",
      "facts_ai",
      "facts_ad",
      "facts_au",
    ]) {
      expect(triggers.has(trigger)).toBe(true)
    }
  })

  test("the expression indexes Drizzle cannot model exist", () => {
    const indexes = new Set(names(freshDb(), "index"))
    expect(indexes.has("idx_entities_key")).toBe(true)
    expect(indexes.has("idx_doc_links_unique")).toBe(true)
  })
})

describe("FTS5 triggers keep the shadow in step", () => {
  const matchCount = (db: Database, table: string, term: string): number =>
    (
      db.query(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(term) as {
        n: number
      }
    ).n

  test("chunks_fts syncs on insert / update / delete", () => {
    const db = freshDb()
    db.run(
      `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content, heading_path, embedding_model, embedding_dims, updated_at)
       VALUES ('c1', 't1', 'd1', 'world', 0, 'alpha needle content', 'Intro', '@cf/baai/bge-m3', 1024, '2026-06-25T00:00:00.000Z')`,
    )
    expect(matchCount(db, "chunks_fts", "needle")).toBe(1)

    db.run(`UPDATE chunks SET content = 'beta haystack content' WHERE id = 'c1'`)
    expect(matchCount(db, "chunks_fts", "needle")).toBe(0)
    expect(matchCount(db, "chunks_fts", "haystack")).toBe(1)

    db.run(`DELETE FROM chunks WHERE id = 'c1'`)
    expect(matchCount(db, "chunks_fts", "haystack")).toBe(0)
  })

  test("entity_fts syncs on insert / update / delete", () => {
    const db = freshDb()
    db.run(
      `INSERT INTO entities (id, tenant_id, kind, canonical_name, visibility, created_at, updated_at)
       VALUES ('e1', 't1', 'person', 'Zaphod Beeblebrox', 'world', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')`,
    )
    expect(matchCount(db, "entity_fts", "Zaphod")).toBe(1)

    db.run(`UPDATE entities SET canonical_name = 'Ford Prefect' WHERE id = 'e1'`)
    expect(matchCount(db, "entity_fts", "Zaphod")).toBe(0)
    expect(matchCount(db, "entity_fts", "Ford")).toBe(1)

    db.run(`DELETE FROM entities WHERE id = 'e1'`)
    expect(matchCount(db, "entity_fts", "Ford")).toBe(0)
  })

  test("facts_fts (content_rowid='id') syncs on insert / update / delete", () => {
    const db = freshDb()
    db.run(
      `INSERT INTO facts (tenant_id, fact, source) VALUES ('t1', 'the towel is essential', 'mcp:extract_facts')`,
    )
    expect(matchCount(db, "facts_fts", "towel")).toBe(1)

    db.run(`UPDATE facts SET fact = 'the babelfish translates' WHERE tenant_id = 't1'`)
    expect(matchCount(db, "facts_fts", "towel")).toBe(0)
    expect(matchCount(db, "facts_fts", "babelfish")).toBe(1)

    db.run(`DELETE FROM facts WHERE tenant_id = 't1'`)
    expect(matchCount(db, "facts_fts", "babelfish")).toBe(0)
  })
})

describe("PRD §3 faithfulness invariants survived generation", () => {
  test("facts.id is the one INTEGER PRIMARY KEY AUTOINCREMENT", () => {
    const db = freshDb()
    expect(sqlOf(db, "facts")).toContain("AUTOINCREMENT")
    const idCol = (
      db.query(`PRAGMA table_info(facts)`).all() as {
        name: string
        type: string
        pk: number
      }[]
    ).find((col) => col.name === "id")
    expect(idCol?.type.toLowerCase()).toBe("integer")
    expect(idCol?.pk).toBe(1)
  })

  test("CHECK lists are present and correct (invariant 6/7)", () => {
    const db = freshDb()
    expect(sqlOf(db, "chunks")).toContain("visibility IN ('private', 'team', 'world')")
    expect(sqlOf(db, "memory_use_policy")).toContain(
      "trust_grade IN ('instruction', 'evidence', 'draft')",
    )
    // entities is {team,world} only — never 'private'.
    const entitiesSql = sqlOf(db, "entities")
    expect(entitiesSql).toContain("visibility IN ('team', 'world')")
    expect(entitiesSql).not.toContain("'private'")
  })

  test("documents has NO visibility column (it lives on chunks)", () => {
    const cols = (db: Database) =>
      (db.query(`PRAGMA table_info(documents)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols(freshDb())).not.toContain("visibility")
  })

  test("orgs has created_by column", () => {
    const cols = (db: Database) =>
      (db.query(`PRAGMA table_info(orgs)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols(freshDb())).toContain("created_by")
  })

  test("memberships has created_by column", () => {
    const cols = (db: Database) =>
      (db.query(`PRAGMA table_info(memberships)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols(freshDb())).toContain("created_by")
  })

  test("documents has path column", () => {
    const cols = (db: Database) =>
      (db.query(`PRAGMA table_info(documents)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols(freshDb())).toContain("path")
  })

  test("chunks has path column", () => {
    const cols = (db: Database) =>
      (db.query(`PRAGMA table_info(chunks)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols(freshDb())).toContain("path")
  })

  test("expression indexes carry their COALESCE/lower fragments", () => {
    const db = freshDb()
    const entitiesKey = sqlOf(db, "idx_entities_key")
    expect(entitiesKey).toContain("lower(")
    expect(entitiesKey).toContain("COALESCE(")
    expect(sqlOf(db, "idx_doc_links_unique")).toContain("COALESCE(")
  })

  test("memory_audit / memory_recall_traces use epoch-ms INTEGER `at` with no default", () => {
    const db = freshDb()
    for (const table of ["memory_audit", "memory_recall_traces"]) {
      const atCol = (
        db.query(`PRAGMA table_info(${table})`).all() as {
          name: string
          type: string
          dflt_value: string | null
        }[]
      ).find((col) => col.name === "at")
      expect(atCol?.type.toLowerCase()).toBe("integer")
      expect(atCol?.dflt_value).toBeNull()
    }
  })

  test("partial indexes keep their WHERE predicate", () => {
    const db = freshDb()
    expect(sqlOf(db, "idx_facts_since")).toContain("WHERE expired_at IS NULL")
    expect(sqlOf(db, "idx_sessions_source")).toContain("WHERE source_session_id IS NOT NULL")
  })
})

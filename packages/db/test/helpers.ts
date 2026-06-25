import { Database } from "bun:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "../src/schema"

/**
 * Build a fresh in-memory bun:sqlite DB with every migration applied, wrapped in a Drizzle
 * `bun-sqlite` instance. The SAME underlying connection backs both the raw `sqlite` (used
 * for fixture inserts so the FTS5 triggers fire) and `db` (handed to `ScopedDB`). This
 * proves the chokepoints against a real SQLite, exactly the shape D1 presents at runtime.
 */
const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle")

export const makeDb = (): { sqlite: Database; db: ReturnType<typeof drizzle> } => {
  const sqlite = new Database(":memory:")
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
  for (const file of files) {
    sqlite.run(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  }
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

/**
 * Add a D1-shaped `.batch([...])` to a bun:sqlite Drizzle instance for the write-path tests.
 * Production/workerd run on the real D1 binding, whose `.batch` is natively all-or-nothing;
 * bun:sqlite has no `.batch`, so we map it to a SYNCHRONOUS `db.transaction` that runs each
 * statement and rolls the whole group back if any one throws — the SAME atomicity the
 * chokepoint relies on (invariant 11), so the unit tests exercise the real `commitBatch`.
 */
export const withBatch = (db: ReturnType<typeof drizzle>): ReturnType<typeof drizzle> => {
  const tx = db as unknown as { transaction: (fn: () => void) => void }
  const target = db as unknown as {
    batch: (statements: ReadonlyArray<{ run: () => void }>) => Promise<unknown>
  }
  target.batch = (statements) => {
    tx.transaction(() => {
      for (const statement of statements) {
        statement.run()
      }
    })
    return Promise.resolve([])
  }
  return db
}

/** A `Principal` with sensible defaults; override per test. */
export const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "t1",
  userId: "userA",
  teamIds: [],
  role: "member",
  allowedScopes: "*",
  capabilities: ["read"],
  readOnly: false,
  ...overrides,
})

/** Insert a `documents` row (only the columns the re-check JOIN/predicates touch). */
export const insertDoc = (
  sqlite: Database,
  row: { id: string; tenantId: string; scope?: string | null; slug: string },
): void => {
  sqlite.run(
    `INSERT INTO documents (id, tenant_id, user_id, slug, scope, status, fingerprint)
     VALUES (?, ?, ?, ?, ?, 'indexed', ?)`,
    [row.id, row.tenantId, "userA", row.slug, row.scope ?? null, `fp-${row.id}`],
  )
}

/** Insert a `chunks` row (FTS5 trigger fires off this raw INSERT). */
export const insertChunk = (
  sqlite: Database,
  row: {
    id: string
    tenantId: string
    documentId: string
    scope?: string | null
    teamId?: string | null
    userId?: string | null
    visibility?: string
    content?: string
    deletedAt?: string | null
  },
): void => {
  sqlite.run(
    `INSERT INTO chunks
       (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
        content, embedding_model, embedding_dims, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '@cf/baai/bge-m3', 1024, '2026-06-25T00:00:00.000Z', ?)`,
    [
      row.id,
      row.tenantId,
      row.documentId,
      row.scope ?? null,
      row.teamId ?? null,
      row.userId ?? null,
      row.visibility ?? "world",
      row.content ?? "alpha needle content",
      row.deletedAt ?? null,
    ],
  )
}

/** Insert a `facts` row (FTS5 trigger fires); returns the autoincrement id. */
export const insertFact = (
  sqlite: Database,
  row: {
    tenantId: string
    scope?: string | null
    teamId?: string | null
    userId?: string | null
    visibility?: string
    fact?: string
    expiredAt?: string | null
  },
): number => {
  const result = sqlite.run(
    `INSERT INTO facts (tenant_id, scope, team_id, user_id, visibility, fact, source, expired_at)
     VALUES (?, ?, ?, ?, ?, ?, 'mcp:extract_facts', ?)`,
    [
      row.tenantId,
      row.scope ?? null,
      row.teamId ?? null,
      row.userId ?? null,
      row.visibility ?? "world",
      row.fact ?? "the towel needle is essential",
      row.expiredAt ?? null,
    ],
  )
  return Number(result.lastInsertRowid)
}

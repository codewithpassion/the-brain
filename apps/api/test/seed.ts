import { env } from "cloudflare:test"

/**
 * Seed helpers for the isolation canary suite — raw `env.DB` INSERTs into the REAL local
 * D1 running inside workerd (the FTS5 triggers fire off these inserts, so the `_fts` shadow
 * stays in step). Seeding through the raw binding is the ONE sanctioned non-`packages/db`
 * use of `env.DB`; the boundary-lint scanner excludes test dirs for exactly this reason.
 *
 * Every helper takes explicit ids so each test owns a UNIQUE tenant/id namespace — the suite
 * is robust whether or not pool-workers rolls storage back between tests (no reuse of the
 * `orgs.slug` / `documents(tenant,slug)` / `(tenant,scope,fingerprint)` unique indexes).
 */

const STAMP = "2026-06-25T00:00:00.000Z"

export const seedOrg = async (id: string, slug: string): Promise<void> => {
  await env.DB.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)")
    .bind(id, id, slug)
    .run()
}

export const seedMembership = async (opts: {
  tenantId: string
  userId: string
  role?: string
  /** JSON string[] grant, or `null` for the `'*'` wildcard (owner/admin default). */
  allowedScopes?: string | null
  teamId?: string | null
}): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO memberships (id, tenant_id, user_id, team_id, role, allowed_scopes) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `mem-${opts.tenantId}-${opts.userId}-${opts.teamId ?? "none"}`,
      opts.tenantId,
      opts.userId,
      opts.teamId ?? null,
      opts.role ?? "owner",
      opts.allowedScopes ?? null,
    )
    .run()
}

export const seedDoc = async (opts: {
  id: string
  tenantId: string
  slug: string
  scope?: string | null
}): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO documents (id, tenant_id, user_id, slug, scope, status, fingerprint) VALUES (?, ?, ?, ?, ?, 'indexed', ?)",
  )
    .bind(opts.id, opts.tenantId, "seed-author", opts.slug, opts.scope ?? null, `fp-${opts.id}`)
    .run()
}

export const seedChunk = async (opts: {
  id: string
  tenantId: string
  documentId: string
  scope?: string | null
  teamId?: string | null
  userId?: string | null
  visibility?: string
  content?: string
  deletedAt?: string | null
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO chunks
       (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
        content, embedding_model, embedding_dims, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '@cf/baai/bge-m3', 1024, ?, ?)`,
  )
    .bind(
      opts.id,
      opts.tenantId,
      opts.documentId,
      opts.scope ?? null,
      opts.teamId ?? null,
      opts.userId ?? null,
      opts.visibility ?? "world",
      opts.content ?? "alpha needle content",
      STAMP,
      opts.deletedAt ?? null,
    )
    .run()
}

/** Insert a `facts` row (autoincrement id); returns the new id for exact-match assertions. */
export const seedFact = async (opts: {
  tenantId: string
  scope?: string | null
  teamId?: string | null
  userId?: string | null
  visibility?: string
  fact?: string
  expiredAt?: string | null
}): Promise<number> => {
  const res = await env.DB.prepare(
    `INSERT INTO facts (tenant_id, scope, team_id, user_id, visibility, fact, source, expired_at)
     VALUES (?, ?, ?, ?, ?, ?, 'mcp:extract_facts', ?) RETURNING id`,
  )
    .bind(
      opts.tenantId,
      opts.scope ?? null,
      opts.teamId ?? null,
      opts.userId ?? null,
      opts.visibility ?? "world",
      opts.fact ?? "the needle fact is essential",
      opts.expiredAt ?? null,
    )
    .first<{ id: number }>()
  if (!res) throw new Error("seedFact: no id returned")
  return res.id
}

export const countRows = async (table: "orgs" | "memberships", id: string): Promise<number> => {
  const column = table === "orgs" ? "id" : "tenant_id"
  const res = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(id)
    .first<{ n: number }>()
  return res?.n ?? 0
}

/**
 * `ScopedDB` — the ONLY way to read tenant D1 data (PRD §7.3/§7.4, invariants 1–4, 8).
 *
 * Constructed from a Drizzle SQLite database + a `Principal`. Every method injects
 * `tenant_id = p.tenantId` (invariant 1) and routes visibility-bearing reads through
 * `scopePredicate` + `visibilityPredicate` (invariants 5, 8). There is NO raw-SQL
 * passthrough: the only way out is the typed predicate methods below.
 *
 * The load-bearing security property is the **D1 re-check** (invariant 3): ids handed
 * back from a Vectorize OR FTS arm are JOINed back to the live, scoped base table; any
 * id that is cross-tenant / out-of-scope / out-of-visibility / soft-deleted is silently
 * DROPPED (drop-don't-error — no existence leak, no throw). Isolation does NOT rest on
 * the Vectorize namespace; it rests here.
 *
 * Typed on the portable `BaseSQLiteDatabase` base so the SAME query builder runs against
 * D1 (`drizzle-orm/d1`, runtime) and bun:sqlite (`drizzle-orm/bun-sqlite`, tests).
 *
 * WRITE PATH (deferred): tenant-injecting write methods land with the ingestion/
 * governance phases and MUST go through `db.batch([...])` (invariant 11) — no interactive
 * cross-await transaction, no raw passthrough. This file ships the read chokepoints only.
 */
import type { Principal } from "@brain/shared"
import { CHUNK_DB_BATCH_SIZE } from "@brain/shared"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { chunks, documents, facts, memoryUsePolicy } from "../schema"
import { scopePredicate, visibilityPredicate } from "./predicates"

/** Both `drizzle-orm/d1` (async) and `drizzle-orm/bun-sqlite` (sync) satisfy this. */
export type BrainDrizzle = BaseSQLiteDatabase<"sync" | "async", unknown>

/** A chunk row after the re-check JOIN-back (the citation-bearing projection). */
export interface ScopedChunk {
  id: string
  documentId: string
  content: string
  headingPath: string | null
  chunkSource: string | null
  embeddedAt: string | null
  embeddingModel: string
  updatedAt: string
  slug: string
  title: string | null
  sourceId: string | null
  /** LEFT-JOINed from `memory_use_policy`, default `'evidence'` (invariant 6). */
  trustGrade: string
}

/** A fact row after the scoped + visibility-gated read. */
export interface ScopedFact {
  id: number
  entitySlug: string | null
  fact: string
  kind: string
  visibility: string
  notability: string
  validFrom: string
  source: string
}

/** A document row after the scoped read (documents have NO visibility column). */
export interface ScopedDocument {
  id: string
  slug: string
  title: string | null
  scope: string | null
  status: string
  fingerprint: string
}

/** The single break-glass event handed to the audit/alert sink. */
export interface BreakGlassEvent {
  tenantId: string
  actorUserId: string
  actorRole: string
  targetIds: string[]
  reason: string
}

/**
 * Sink for an audited+alerted break-glass read (invariant 8). Injected at construction;
 * if absent, `breakGlass` fails closed — an UNAUDITED break-glass is impossible by
 * construction. The real sink writes a `memory_audit` row in the same `db.batch` as the
 * read and fires a high-severity alert (wired in a later phase).
 */
export type BreakGlassAudit = (event: BreakGlassEvent) => Promise<void>

const visibilityCols = {
  chunk: { visibility: chunks.visibility, teamId: chunks.teamId, userId: chunks.userId },
  fact: { visibility: facts.visibility, teamId: facts.teamId, userId: facts.userId },
} as const

/** Quote each whitespace term so a hostile query cannot inject FTS5 operators. */
const sanitizeFts = (query: string): string =>
  query
    .split(/\s+/)
    .map((term) => term.replace(/["()*]/g, "").trim())
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" ")

export class ScopedDB {
  private readonly db: BrainDrizzle
  private readonly p: Principal
  private readonly audit: BreakGlassAudit | undefined

  constructor(db: BrainDrizzle, principal: Principal, audit?: BreakGlassAudit) {
    this.db = db
    this.p = principal
    this.audit = audit
  }

  /** The re-check projection: chunk + its citation fields + LEFT-JOINed trust_grade. */
  private chunkProjection() {
    return {
      id: chunks.id,
      documentId: chunks.documentId,
      content: chunks.content,
      headingPath: chunks.headingPath,
      chunkSource: chunks.chunkSource,
      embeddedAt: chunks.embeddedAt,
      embeddingModel: chunks.embeddingModel,
      updatedAt: chunks.updatedAt,
      slug: documents.slug,
      title: documents.title,
      sourceId: documents.sourceId,
      trustGrade: sql<string>`COALESCE(${memoryUsePolicy.trustGrade}, 'evidence')`,
    }
  }

  /**
   * The mandatory D1 re-check (invariant 3). JOIN the candidate ids back to the live
   * `chunks` base table (tenant + scope + soft-delete + visibility), INNER-JOIN
   * `documents` on `(id, tenant_id)`, LEFT-JOIN the trust sidecar. Any id failing ANY
   * predicate is simply absent from the result — dropped, never errored. The id list is
   * chunked into `CHUNK_DB_BATCH_SIZE` groups to respect D1's 100 bound-param cap
   * (invariant 11). `breakGlass` drops only the visibility arm; tenant + scope stay.
   */
  private async recheckChunks(ids: string[], breakGlass = false): Promise<ScopedChunk[]> {
    if (ids.length === 0) return []
    const out: ScopedChunk[] = []
    for (let i = 0; i < ids.length; i += CHUNK_DB_BATCH_SIZE) {
      const batch = ids.slice(i, i + CHUNK_DB_BATCH_SIZE)
      const rows = await this.db
        .select(this.chunkProjection())
        .from(chunks)
        .innerJoin(
          documents,
          and(eq(documents.id, chunks.documentId), eq(documents.tenantId, chunks.tenantId)),
        )
        .leftJoin(
          memoryUsePolicy,
          and(
            eq(memoryUsePolicy.targetId, chunks.id),
            eq(memoryUsePolicy.tenantId, chunks.tenantId),
          ),
        )
        .where(
          and(
            eq(chunks.tenantId, this.p.tenantId),
            inArray(chunks.id, batch),
            isNull(chunks.deletedAt),
            scopePredicate(this.p, chunks.scope),
            breakGlass ? undefined : visibilityPredicate(this.p, visibilityCols.chunk),
          ),
        )
      out.push(...rows)
    }
    return out
  }

  /** Re-check a set of ids (from a vector OR FTS arm) → the surviving scoped chunk rows. */
  async getChunksByIds(ids: string[]): Promise<ScopedChunk[]> {
    return this.recheckChunks(ids)
  }

  /** Same re-check, keyed by id for the caller to re-attach vector/FTS scores by id. */
  async hydrateChunks(ids: string[]): Promise<Map<string, ScopedChunk>> {
    const rows = await this.recheckChunks(ids)
    return new Map(rows.map((row) => [row.id, row]))
  }

  /** Scoped + visibility-gated fact read (invariant 8); only live (`expired_at IS NULL`) rows. */
  async readFacts(opts?: { entitySlug?: string }): Promise<ScopedFact[]> {
    return this.db
      .select({
        id: facts.id,
        entitySlug: facts.entitySlug,
        fact: facts.fact,
        kind: facts.kind,
        visibility: facts.visibility,
        notability: facts.notability,
        validFrom: facts.validFrom,
        source: facts.source,
      })
      .from(facts)
      .where(
        and(
          eq(facts.tenantId, this.p.tenantId),
          isNull(facts.expiredAt),
          scopePredicate(this.p, facts.scope),
          visibilityPredicate(this.p, visibilityCols.fact),
          opts?.entitySlug ? eq(facts.entitySlug, opts.entitySlug) : undefined,
        ),
      )
  }

  /** Scoped document read. `documents` has NO visibility column — tenant + scope only. */
  async listDocuments(opts?: { status?: string }): Promise<ScopedDocument[]> {
    return this.db
      .select({
        id: documents.id,
        slug: documents.slug,
        title: documents.title,
        scope: documents.scope,
        status: documents.status,
        fingerprint: documents.fingerprint,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, this.p.tenantId),
          scopePredicate(this.p, documents.scope),
          opts?.status ? eq(documents.status, opts.status) : undefined,
        ),
      )
  }

  /**
   * Audited break-glass read of chunks across the visibility tier (invariant 8). Fails
   * CLOSED: non-owner/admin → throws; missing audit sink → throws (no unaudited path).
   * NEVER bypasses `tenant_id` or `scopePredicate` — it only drops the visibility arm.
   */
  async breakGlass(ids: string[], reason: string): Promise<ScopedChunk[]> {
    if (this.p.role !== "owner" && this.p.role !== "admin") {
      throw new Error("break-glass denied: requires owner or admin role")
    }
    if (!this.audit) {
      throw new Error("break-glass denied: no audit sink configured")
    }
    await this.audit({
      tenantId: this.p.tenantId,
      actorUserId: this.p.userId,
      actorRole: this.p.role,
      targetIds: ids,
      reason,
    })
    return this.recheckChunks(ids, true)
  }

  /**
   * FTS5 keyword arm for chunks (invariant 4). MATCH stays PURE TEXT against the
   * external-content `chunks_fts` table (which carries no tenant_id); the result JOINs
   * back to the scoped `chunks` base table **by rowid** (`content_rowid='rowid'`), where
   * tenant + soft-delete + scope are re-checked BEFORE any id leaves. Returns ids only —
   * the caller still hydrates through the full re-check above. A MATCH-then-unscoped-read
   * is impossible through this API.
   */
  async ftsChunkIds(query: string, topK: number): Promise<string[]> {
    const match = sanitizeFts(query)
    if (match.length === 0) return []
    const scopeFragment =
      this.p.allowedScopes === "*"
        ? sql``
        : sql` AND c.scope IN (${sql.join(
            [...this.p.allowedScopes].map((scope) => sql`${scope}`),
            sql`, `,
          )})`
    const statement = sql`
      SELECT c.id AS id
      FROM chunks_fts f
      JOIN chunks c ON c.rowid = f.rowid
      WHERE chunks_fts MATCH ${match}
        AND c.tenant_id = ${this.p.tenantId}
        AND c.deleted_at IS NULL${scopeFragment}
      ORDER BY bm25(chunks_fts)
      LIMIT ${topK}`
    try {
      const rows = await this.db.all<{ id: string }>(statement)
      return rows.map((row) => row.id)
    } catch {
      return []
    }
  }

  /**
   * FTS5 keyword arm for facts (invariant 4). Unlike chunks/entities, `facts_fts` is
   * `content_rowid='id'` (facts' INTEGER AUTOINCREMENT pk), so the JOIN-back is **by id**
   * (`f.rowid` IS `facts.id`) — NOT by the chunks-style rowid. Tenant + scope + visibility
   * + live (`expired_at IS NULL`) are re-checked on the base table before any id leaves.
   */
  async ftsFactIds(query: string, topK: number): Promise<number[]> {
    const match = sanitizeFts(query)
    if (match.length === 0) return []
    const scopeFragment =
      this.p.allowedScopes === "*"
        ? sql``
        : sql` AND x.scope IN (${sql.join(
            [...this.p.allowedScopes].map((scope) => sql`${scope}`),
            sql`, `,
          )})`
    const teamFragment =
      this.p.teamIds.length > 0
        ? sql` OR (x.visibility = 'team' AND x.team_id IN (${sql.join(
            [...this.p.teamIds].map((team) => sql`${team}`),
            sql`, `,
          )}))`
        : sql``
    const statement = sql`
      SELECT x.id AS id
      FROM facts_fts f
      JOIN facts x ON x.id = f.rowid
      WHERE facts_fts MATCH ${match}
        AND x.tenant_id = ${this.p.tenantId}
        AND x.expired_at IS NULL${scopeFragment}
        AND (x.visibility = 'world'
             OR (x.visibility = 'private' AND x.user_id = ${this.p.userId})${teamFragment})
      ORDER BY bm25(facts_fts)
      LIMIT ${topK}`
    try {
      const rows = await this.db.all<{ id: number }>(statement)
      return rows.map((row) => row.id)
    } catch {
      return []
    }
  }
}

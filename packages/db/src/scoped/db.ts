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
import { CHUNK_DB_BATCH_SIZE, EMBEDDING_DIMS, EMBEDDING_MODEL } from "@brain/shared"
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import {
  chunks,
  documents,
  facts,
  memoryRecallTraces,
  memoryUsePolicy,
  tokenSpend,
} from "../schema"
import { type AuditSpec, batchWithAudit } from "./audit"
import {
  notSoftExpired,
  notSoftExpiredSql,
  scopePredicate,
  visibilityPredicate,
} from "./predicates"

/** Both `drizzle-orm/d1` (async) and `drizzle-orm/bun-sqlite` (sync) satisfy this. */
export type BrainDrizzle = BaseSQLiteDatabase<"sync" | "async", unknown>

/** A runnable Drizzle insert/update/delete statement, for atomic batch execution. */
type BatchStatement = BatchItem<"sqlite">

/**
 * The atomicity primitive (invariant 11). D1 exposes `.batch([...])`, which runs all the
 * statements in ONE all-or-nothing transaction — the only sanctioned way to write (no
 * interactive cross-await transaction). The portable read base type does not declare it;
 * the runtime D1 binding and the workerd canary's `drizzle(env.DB)` both have it natively,
 * and the bun:sqlite unit tests inject an equivalent `.batch` shim (a synchronous
 * `db.transaction`) so the SAME all-or-nothing semantics hold there.
 */
interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/**
 * Optional filter applied during the D1 re-check (recheckChunks). Both predicates join to
 * the already-inner-joined `documents` table, so they scope retrieval by namespace/tag.
 */
export interface ScopedSearchFilter {
  /** Restrict to documents whose path equals or is a child of this prefix. */
  path?: string
  /** Restrict to documents whose tags JSON array contains this exact value. */
  tag?: string
}

/**
 * Normalize a path namespace string:
 *   - Collapse duplicate slashes, ensure a leading "/", remove trailing "/".
 *   - Returns null for absent/empty input.
 * Examples: "project/x" → "/project/x", "/project/x/" → "/project/x"
 */
export const normalizePath = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  let p = trimmed.replace(/\/+/g, "/")
  if (!p.startsWith("/")) p = `/${p}`
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1)
  return p
}

/** `insertDocument` input — `tenantId` is NEVER accepted; the chokepoint forces it. */
export interface InsertDocumentInput {
  id?: string
  slug: string
  fingerprint: string
  title?: string | null
  scope?: string | null
  teamId?: string | null
  contentType?: string | null
  bodyR2Key?: string | null
  markdownPreview?: string | null
  status?: string
  sourceId?: string | null
  sourceKind?: string | null
  sourceUri?: string | null
  ingestedVia?: string | null
  tags?: string[] | null
  path?: string | null
  /** Provenance marker; `'dream'` flags a reflection insight (D2 anti-loop D-i2). Default NULL. */
  origin?: string | null
}

/** `insertChunks` per-row input — `tenantId` is NEVER accepted; the chokepoint forces it. */
export interface InsertChunkInput {
  id: string
  documentId: string
  chunkIndex: number
  content: string
  scope?: string | null
  teamId?: string | null
  userId?: string | null
  visibility?: string
  headingPath?: string | null
  tokenCount?: number | null
  chunkSource?: string | null
}

/** `updateChunkEmbedding` patch — marks a chunk embedded (or records an embed failure). */
export interface UpdateChunkEmbeddingInput {
  embeddingModel: string
  embeddedAt: string
  embedError?: string | null
}

/**
 * `updateDocumentStatus` patch — drives a `documents` row through its lifecycle
 * (`pending → processing → indexed | failed`, §4.11). `tenant_id` is NEVER accepted; the
 * chokepoint scopes the UPDATE to the principal's tenant. Optional fields are written only
 * when present (so a status flip never clobbers the preview/chunk_count).
 */
export interface UpdateDocumentStatusInput {
  status: string
  markdownPreview?: string | null
  chunkCount?: number | null
  bodyR2Key?: string | null
  ingestedAt?: string | null
}

/**
 * `recordSpend` input — one increment into the per-tenant `token_spend` ledger (the
 * window+model row). `tenant_id` is FORCED from the Principal; the cost cap reads it back
 * through `readWindowSpendNeurons` (invariant 16). Attribution-only in v1.
 */
export interface RecordSpendInput {
  /** Spend window key, e.g. `'2026-06'` (monthly) or `'YYYY-MM-DD'`. */
  window: string
  model: string
  surface?: string | null
  inputTokens?: number
  outputTokens?: number
  /** `@cf/`-neuron accounting (v1 billed unit). */
  neurons: number
}

/** `upsertMemoryPolicy` input — `trust_grade` lives ONLY here (invariant 6). */
export interface UpsertMemoryPolicyInput {
  trustGrade: string
  scopes: readonly string[]
  expiresAt?: string | null
}

/** `appendRecallTrace` input — append-only; `tenantId`/`userId`/`at` are stamped here. */
export interface RecallTraceInput {
  query: string
  targetId: string
  score: number
  clientId: string
  /** Epoch-ms; defaults to `Date.now()` at write time. */
  at?: number
}

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
   * Optional `filter` restricts by document path prefix and/or tag (via json_each).
   */
  private async recheckChunks(
    ids: string[],
    breakGlass = false,
    filter?: ScopedSearchFilter,
  ): Promise<ScopedChunk[]> {
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
            isNull(documents.deletedAt), // exclude soft-deleted document's chunks (D1 — Deliverable 1)
            scopePredicate(this.p, chunks.scope),
            breakGlass ? undefined : visibilityPredicate(this.p, visibilityCols.chunk),
            // path filter on the INNER-JOINed documents table:
            // exact match OR true child (e.g. /project matches /project/x but not /projectfoo).
            filter?.path !== undefined
              ? sql`(${documents.path} = ${filter.path} OR ${documents.path} LIKE ${`${filter.path}/%`})`
              : undefined,
            // tag filter: document's JSON tags array contains this exact value (exact element match).
            filter?.tag !== undefined
              ? sql`EXISTS (SELECT 1 FROM json_each(${documents.tags}) WHERE value = ${filter.tag})`
              : undefined,
          ),
        )
      out.push(...rows)
    }
    return out
  }

  /** Re-check a set of ids (from a vector OR FTS arm) → the surviving scoped chunk rows. */
  async getChunksByIds(ids: string[], filter?: ScopedSearchFilter): Promise<ScopedChunk[]> {
    return this.recheckChunks(ids, false, filter)
  }

  /** Same re-check, keyed by id for the caller to re-attach vector/FTS scores by id. */
  async hydrateChunks(
    ids: string[],
    filter?: ScopedSearchFilter,
  ): Promise<Map<string, ScopedChunk>> {
    const rows = await this.recheckChunks(ids, false, filter)
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
          notSoftExpired(facts.validUntil, new Date().toISOString()), // D5 decay soft-expire
          scopePredicate(this.p, facts.scope),
          visibilityPredicate(this.p, visibilityCols.fact),
          opts?.entitySlug ? eq(facts.entitySlug, opts.entitySlug) : undefined,
        ),
      )
  }

  /** Scoped document read — live docs only (`deleted_at IS NULL`). Tenant + scope gated. */
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
          isNull(documents.deletedAt), // live docs only
          scopePredicate(this.p, documents.scope),
          opts?.status ? eq(documents.status, opts.status) : undefined,
        ),
      )
  }

  /**
   * Point-lookup by slug on the `(tenant_id, slug)` unique index — O(1), not a full scan.
   * Used by the backfill consumer's idempotent recovery path AND the Phase-2 supersede check.
   * Returns BOTH live and soft-deleted rows (slug is still "occupied" when deleted, so callers
   * can handle resurrection). No scope predicate — internal recovery lookup (the system principal
   * has `allowedScopes: '*'`); tenant isolation is enforced by `this.p.tenantId`.
   */
  async getDocumentBySlug(
    slug: string,
  ): Promise<{ id: string; status: string; fingerprint: string; deletedAt: string | null } | null> {
    const rows = await this.db
      .select({
        id: documents.id,
        status: documents.status,
        fingerprint: documents.fingerprint,
        deletedAt: documents.deletedAt,
      })
      .from(documents)
      .where(and(eq(documents.tenantId, this.p.tenantId), eq(documents.slug, slug)))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Return live Phase-2 obsidian docs (sourceKind='obsidian', deleted_at IS NULL) for a given
   * sourceId — used by the deletion-reconcile step to diff vault vs DB and soft-delete vanished
   * notes. Phase-1 docs (slug starts with 'bf-') are excluded by the sourceKind filter.
   */
  async getDocumentsBySource(sourceId: string): Promise<{ id: string; slug: string }[]> {
    return this.db
      .select({ id: documents.id, slug: documents.slug })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, this.p.tenantId),
          eq(documents.sourceId, sourceId),
          eq(documents.sourceKind, "obsidian"),
          isNull(documents.deletedAt),
        ),
      )
  }

  /**
   * Point-lookup by id — returns the full live document row for a single tenant-scoped doc,
   * or `null` when the id is missing, cross-tenant, or soft-deleted. Used by the dashboard
   * get/reprocess/update ops (which need bodyR2Key, contentType, chunkCount, tags, etc.).
   * No scope predicate — the caller holds a tenant-scoped principal; scope is returned as a
   * field so the surface op can mirror it into re-ingest params (same pattern as getDocumentBySlug).
   */
  async getDocumentById(documentId: string): Promise<{
    id: string
    slug: string
    title: string | null
    status: string
    contentType: string | null
    bodyR2Key: string | null
    fingerprint: string
    scope: string | null
    path: string | null
    tags: string | null
    chunkCount: number | null
    createdAt: string | null
    updatedAt: string | null
  } | null> {
    const rows = await this.db
      .select({
        id: documents.id,
        slug: documents.slug,
        title: documents.title,
        status: documents.status,
        contentType: documents.contentType,
        bodyR2Key: documents.bodyR2Key,
        fingerprint: documents.fingerprint,
        scope: documents.scope,
        path: documents.path,
        tags: documents.tags,
        chunkCount: documents.chunkCount,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, this.p.tenantId),
          eq(documents.id, documentId),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1)
    return rows[0] ?? null
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
  async ftsFactIds(
    query: string,
    topK: number,
    includeSuperseded = false,
    includeSoftExpired = false,
  ): Promise<number[]> {
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
    // Hide Dream-superseded/consolidated facts by default (parity with SessionStore.recall — so
    // the keyword arm doesn't starve the visible top-K with rows the default view would drop).
    const activeFragment = includeSuperseded
      ? sql``
      : sql` AND x.superseded_by IS NULL AND x.consolidated_into IS NULL`
    // Soft-expiry is a SEPARATE axis from includeSuperseded — revealed only by includeSoftExpired.
    const softExpireFragment = includeSoftExpired
      ? sql``
      : sql` AND ${notSoftExpiredSql("x", new Date().toISOString())}`
    const statement = sql`
      SELECT x.id AS id
      FROM facts_fts f
      JOIN facts x ON x.id = f.rowid
      WHERE facts_fts MATCH ${match}
        AND x.tenant_id = ${this.p.tenantId}
        AND x.expired_at IS NULL${activeFragment}${softExpireFragment}${scopeFragment}
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

  // ── WRITE PATH (invariants 1, 10, 11) ────────────────────────────────────────
  // tenant_id is ALWAYS forced from the Principal, NEVER read from the caller's payload.
  // Every MUTATING method funnels through `batchWithAudit`, so its `memory_audit` row is
  // physically un-skippable — written in the SAME `db.batch` as its change (invariant 10),
  // all-or-nothing (invariant 11). There is NO generic `exec`/raw `batch` passthrough: the
  // only writes are the typed methods below, so an un-scoped or un-audited write is
  // impossible by construction. The lone audit-exempt path is the append-only recall trace
  // (`appendRecallTrace*`), which IS itself the audit-grade record (invariant 10) — it
  // carries no separate audit row and is not gated by `readOnly` (a read-only principal's
  // `think` still emits traces off the read path).

  /** Authorize an EXPLICIT scope on a write; `'*'` may name any scope, else it must be granted. */
  private assertScopeAllowed(scope: string): void {
    if (this.p.allowedScopes === "*") {
      return
    }
    if (!this.p.allowedScopes.includes(scope)) {
      throw new Error(`scope '${scope}' not in this principal's allowedScopes`)
    }
  }

  /** Run statements atomically (invariant 11). See `BatchCapable` for the D1/test seam. */
  private async commitBatch(statements: BatchStatement[]): Promise<void> {
    const [first, ...rest] = statements
    if (first === undefined) {
      return
    }
    await (this.db as unknown as BatchCapable).batch([first, ...rest])
  }

  /**
   * The single funnel for every mutating write (invariant 10). Rejects a read-only
   * principal, builds the `memory_audit` row with `tenant_id` + actor `user_id` FORCED
   * from the Principal (never the caller), and commits it in the SAME batch as the change
   * — so the change and its audit either both land or neither does.
   */
  private async batchWithAudit(statements: BatchStatement[], audit: AuditSpec): Promise<void> {
    await batchWithAudit(this.db, this.p, statements, audit)
  }

  /**
   * Insert a `documents` row with `tenant_id` + authorship `user_id` forced; returns the id.
   * An explicit `scope`/`teamId` is authorized against the Principal first. Audited in-batch.
   */
  async insertDocument(doc: InsertDocumentInput): Promise<string> {
    if (doc.scope) {
      this.assertScopeAllowed(doc.scope)
    }
    if (doc.teamId && !this.p.teamIds.includes(doc.teamId)) {
      throw new Error(`team '${doc.teamId}' not in this principal's teamIds`)
    }
    const id = doc.id ?? crypto.randomUUID()
    const now = new Date().toISOString()
    const insert = this.db.insert(documents).values({
      id,
      tenantId: this.p.tenantId, // forced
      userId: this.p.userId, // authorship forced
      teamId: doc.teamId ?? null,
      scope: doc.scope ?? null,
      slug: doc.slug,
      title: doc.title ?? null,
      contentType: doc.contentType ?? null,
      bodyR2Key: doc.bodyR2Key ?? null,
      markdownPreview: doc.markdownPreview ?? null,
      status: doc.status ?? "pending",
      fingerprint: doc.fingerprint,
      sourceId: doc.sourceId ?? null,
      sourceKind: doc.sourceKind ?? null,
      sourceUri: doc.sourceUri ?? null,
      ingestedVia: doc.ingestedVia ?? null,
      tags: doc.tags !== null && doc.tags !== undefined ? JSON.stringify(doc.tags) : "[]",
      path: doc.path ?? null,
      origin: doc.origin ?? null,
      createdAt: now,
      updatedAt: now,
    })
    await this.batchWithAudit([insert], { action: "document.insert", targetId: id })
    return id
  }

  /**
   * Insert `chunks` rows with `tenant_id` forced, in batches of `CHUNK_DB_BATCH_SIZE` (10).
   * Each row is its OWN insert statement (~15 bound params), so every statement stays well
   * under D1's per-statement 100-param cap; a batch is 10 inserts + 1 audit row. The
   * `chunks_fts` shadow is kept in step by the DB triggers — never written here. Embedding
   * columns are seeded to the locked model/dims; `embedded_at` stays NULL until
   * `updateChunkEmbedding`. Returns the inserted ids in order.
   */
  async insertChunks(rows: InsertChunkInput[]): Promise<string[]> {
    if (rows.length === 0) {
      return []
    }
    const now = new Date().toISOString()
    for (let i = 0; i < rows.length; i += CHUNK_DB_BATCH_SIZE) {
      const slice = rows.slice(i, i + CHUNK_DB_BATCH_SIZE)
      const statements = slice.map((row) =>
        this.db
          .insert(chunks)
          .values({
            id: row.id,
            tenantId: this.p.tenantId, // forced
            documentId: row.documentId,
            scope: row.scope ?? null,
            teamId: row.teamId ?? null,
            userId: row.userId ?? null,
            visibility: row.visibility ?? "world",
            chunkIndex: row.chunkIndex,
            content: row.content,
            headingPath: row.headingPath ?? null,
            tokenCount: row.tokenCount ?? null,
            chunkSource: row.chunkSource ?? null,
            embeddingModel: EMBEDDING_MODEL,
            embeddingDims: EMBEDDING_DIMS,
            updatedAt: now,
          })
          // Idempotent on PK conflict: a resume of a partially-processed doc re-inserts the
          // same chunk ids (chunkId = documentId:index, deterministic). The pre-existing rows
          // are already correct — skipping is safe; the embed step runs regardless (upsert).
          .onConflictDoNothing(),
      )
      await this.batchWithAudit(statements, {
        action: "chunk.insert",
        targetId: slice[0]?.documentId ?? null,
        diff: JSON.stringify({ count: slice.length }),
      })
    }
    return rows.map((row) => row.id)
  }

  /**
   * Mark a chunk embedded (or record an embed failure). The WHERE is `tenant_id`-scoped, so
   * the update can never touch another tenant's chunk. Audited in-batch.
   */
  async updateChunkEmbedding(chunkId: string, patch: UpdateChunkEmbeddingInput): Promise<void> {
    const update = this.db
      .update(chunks)
      .set({
        embeddingModel: patch.embeddingModel,
        embeddedAt: patch.embeddedAt,
        embedError: patch.embedError ?? null,
      })
      .where(and(eq(chunks.id, chunkId), eq(chunks.tenantId, this.p.tenantId)))
    await this.batchWithAudit([update], { action: "chunk.embed", targetId: chunkId })
  }

  /**
   * Drive a `documents` row through its ingestion lifecycle (§4.11). The WHERE is
   * `tenant_id`-scoped so the update can never touch another tenant's document. Audited
   * in-batch. Only the fields present in `patch` are written (no clobber of preview/count).
   */
  async updateDocumentStatus(documentId: string, patch: UpdateDocumentStatusInput): Promise<void> {
    const update = this.db
      .update(documents)
      .set({
        status: patch.status,
        ...(patch.markdownPreview !== undefined ? { markdownPreview: patch.markdownPreview } : {}),
        ...(patch.chunkCount !== undefined ? { chunkCount: patch.chunkCount } : {}),
        ...(patch.bodyR2Key !== undefined ? { bodyR2Key: patch.bodyR2Key } : {}),
        ...(patch.ingestedAt !== undefined ? { ingestedAt: patch.ingestedAt } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, this.p.tenantId)))
    await this.batchWithAudit([update], {
      action: "document.status",
      targetId: documentId,
      diff: JSON.stringify({ status: patch.status }),
    })
  }

  // ── DOCUMENT LIFECYCLE (Phase 2 — deletion + supersede) ───────────────────

  /**
   * Soft-delete a document and ALL its live chunks in ONE audited batch (Deliverable 1).
   * The document row is marked `deleted_at = now`; all live (`deleted_at IS NULL`) chunks
   * for that doc are likewise soft-deleted. Returns the chunk ids that were live at the time
   * of deletion so the caller can drop the corresponding Vectorize vectors off-batch.
   * Tenant isolation is FORCED on every WHERE; the operation is a no-op if the document is
   * already deleted (the UPDATE with `WHERE deleted_at IS NULL` touches zero rows).
   */
  async softDeleteDocument(documentId: string): Promise<{ chunkIds: string[] }> {
    // SELECT live chunk ids first (needed for Vectorize deletion off-batch).
    const liveRows = await this.db
      .select({ id: chunks.id })
      .from(chunks)
      .where(
        and(
          eq(chunks.tenantId, this.p.tenantId),
          eq(chunks.documentId, documentId),
          isNull(chunks.deletedAt),
        ),
      )
    const chunkIds = liveRows.map((r) => r.id)

    const now = new Date().toISOString()
    const deleteDoc = this.db
      .update(documents)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.tenantId, this.p.tenantId),
          isNull(documents.deletedAt), // idempotent: already-deleted doc → no-op
        ),
      )
    const deleteChunks = this.db
      .update(chunks)
      .set({ deletedAt: now })
      .where(
        and(
          eq(chunks.documentId, documentId),
          eq(chunks.tenantId, this.p.tenantId),
          isNull(chunks.deletedAt), // idempotent: already-deleted chunks → no-op
        ),
      )
    await this.batchWithAudit([deleteDoc, deleteChunks], {
      action: "document.softDelete",
      targetId: documentId,
    })
    return { chunkIds }
  }

  /**
   * Hard-delete ALL chunk rows for a document (Phase 2 — supersede path). Used instead of
   * soft-delete because chunk ids are deterministic (`${docId}:${chunkIndex}`): soft-deleted
   * rows still occupy the PK, so `insertChunks` (which uses `onConflictDoNothing`) would
   * silently skip re-inserting new content into the same ids. Hard-delete frees the PK space
   * so the re-ingest can write fresh chunks with the same ids. FTS5 DELETE triggers fire for
   * each removed row, keeping the FTS shadow in sync. Returns the deleted chunk ids for
   * Vectorize cleanup (called BEFORE this method to avoid orphan-vector leaks).
   */
  async hardDeleteDocumentChunks(documentId: string): Promise<{ chunkIds: string[] }> {
    // SELECT all chunk ids (live + soft-deleted) before deletion for Vectorize cleanup.
    const allRows = await this.db
      .select({ id: chunks.id })
      .from(chunks)
      .where(and(eq(chunks.tenantId, this.p.tenantId), eq(chunks.documentId, documentId)))
    const chunkIds = allRows.map((r) => r.id)

    if (chunkIds.length > 0) {
      const hardDelete = this.db
        .delete(chunks)
        .where(and(eq(chunks.documentId, documentId), eq(chunks.tenantId, this.p.tenantId)))
      await this.batchWithAudit([hardDelete], {
        action: "chunk.supersede",
        targetId: documentId,
        diff: JSON.stringify({ count: chunkIds.length }),
      })
    }
    return { chunkIds }
  }

  /**
   * Update a document row in-place for the supersede path (Phase 2 — D2). Sets the new
   * `fingerprint`, `body_r2_key`, clears `deleted_at` (for resurrection after deletion),
   * and resets `status = 'pending'` so the re-ingest pipeline runs from the start.
   * The `(tenant_id, scope, fingerprint)` UNIQUE index means if a different doc already holds
   * the new fingerprint the UPDATE throws — treat that as a genuine data-integrity conflict.
   * Audited in-batch.
   */
  async updateDocumentForSupersede(
    documentId: string,
    patch: { fingerprint: string; bodyR2Key: string; deletedAt: string | null },
  ): Promise<void> {
    const update = this.db
      .update(documents)
      .set({
        fingerprint: patch.fingerprint,
        bodyR2Key: patch.bodyR2Key,
        deletedAt: patch.deletedAt,
        status: "pending",
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, this.p.tenantId)))
    await this.batchWithAudit([update], {
      action: "document.supersede",
      targetId: documentId,
      diff: JSON.stringify({ fingerprint: patch.fingerprint }),
    })
  }

  /**
   * Write the `memory_use_policy` sidecar for a target (invariant 6 — the ONLY home of
   * `trust_grade`). There is no unique index on `(tenant_id, target_id)`, so the upsert is a
   * clean atomic replace: a `tenant_id`-scoped DELETE of any prior policy + the new INSERT,
   * both in ONE batch with the audit row. The DELETE carries `tenant_id` so it can never
   * clear another tenant's policy.
   */
  async upsertMemoryPolicy(targetId: string, policy: UpsertMemoryPolicyInput): Promise<void> {
    const remove = this.db
      .delete(memoryUsePolicy)
      .where(
        and(eq(memoryUsePolicy.tenantId, this.p.tenantId), eq(memoryUsePolicy.targetId, targetId)),
      )
    const insert = this.db.insert(memoryUsePolicy).values({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced
      targetId,
      trustGrade: policy.trustGrade,
      scopes: JSON.stringify(policy.scopes),
      expiresAt: policy.expiresAt ?? null,
    })
    await this.batchWithAudit([remove, insert], { action: "usePolicy.upsert", targetId })
  }

  /** Append-only single recall trace (invariant 10). See `appendRecallTraces`. */
  async appendRecallTrace(trace: RecallTraceInput): Promise<void> {
    await this.appendRecallTraces([trace])
  }

  /**
   * Append-only recall traces (invariant 10). Called OFF the synchronous read path by the
   * caller (via `ctx.waitUntil`); this method only does the append. `tenant_id` + the recall
   * author `user_id` are FORCED from the Principal; `at` is epoch-ms. NO audit row and NO
   * `readOnly` gate — the trace IS the audit-grade record, and a read-only principal's
   * `think` must still emit traces. Batched (≤10/statement-group) to respect the param cap.
   */
  async appendRecallTraces(traces: RecallTraceInput[]): Promise<void> {
    if (traces.length === 0) {
      return
    }
    for (let i = 0; i < traces.length; i += CHUNK_DB_BATCH_SIZE) {
      const slice = traces.slice(i, i + CHUNK_DB_BATCH_SIZE)
      const statements = slice.map((trace) =>
        this.db.insert(memoryRecallTraces).values({
          id: crypto.randomUUID(),
          tenantId: this.p.tenantId, // forced
          userId: this.p.userId, // recall author forced
          query: trace.query,
          targetId: trace.targetId,
          score: trace.score,
          clientId: trace.clientId,
          at: trace.at ?? Date.now(),
        }),
      )
      await this.commitBatch(statements)
    }
  }

  // ── COST CAP (invariant 16) ───────────────────────────────────────────────────
  // The enforcing per-tenant cap is the app-level `token_spend` 429 pre-check: a handler
  // reads the tenant's spend for the current window via `readWindowSpendNeurons` and 429s
  // BEFORE any `env.AI.run`. `recordSpend` is the attribution write (off the response path).
  // `tenant_id` is FORCED here too, so spend can never be read/written across tenants.

  /** Sum the tenant's `token_spend` neurons for a window (0 when no rows). Tenant-scoped. */
  async readWindowSpendNeurons(window: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${tokenSpend.neurons}), 0)` })
      .from(tokenSpend)
      .where(and(eq(tokenSpend.tenantId, this.p.tenantId), eq(tokenSpend.window, window)))
    return rows[0]?.total ?? 0
  }

  /**
   * Increment the per-tenant `token_spend` ledger for `(window, model)`. Append-on-conflict
   * (the `ux_token_spend_window` unique index): a fresh row inserts, a repeat increments the
   * running totals. NO audit row and NO `readOnly` gate — spend is an ops counter that must
   * be recorded regardless of who incurred it (a read-only principal's `think` still costs).
   */
  async recordSpend(input: RecordSpendInput): Promise<void> {
    const now = new Date().toISOString()
    const inputTokens = input.inputTokens ?? 0
    const outputTokens = input.outputTokens ?? 0
    const statement = this.db
      .insert(tokenSpend)
      .values({
        id: crypto.randomUUID(),
        tenantId: this.p.tenantId, // forced
        window: input.window,
        model: input.model,
        surface: input.surface ?? null,
        inputTokens,
        outputTokens,
        neurons: input.neurons,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // Matches the surface-scoped unique index (COALESCE null→'') so dream/think/ingest spend
        // on the same model increment SEPARATE rows instead of colliding.
        target: [
          tokenSpend.tenantId,
          tokenSpend.window,
          tokenSpend.model,
          sql`coalesce(${tokenSpend.surface}, '')`,
        ],
        set: {
          inputTokens: sql`${tokenSpend.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${tokenSpend.outputTokens} + ${outputTokens}`,
          neurons: sql`${tokenSpend.neurons} + ${input.neurons}`,
          updatedAt: now,
        },
      })
    await this.commitBatch([statement])
  }

  /**
   * Dream hygiene (D5) — the WHOLE LLM-free sweep (decay + soft-expire + notability boost) as ONE
   * atomic, audited `db.batch`. ID-FIRST: candidate ids are SELECTed up front, then every mutation
   * is driven by `id IN (chunked)` — so counts are exact (id-set sizes, not racy pre-counts), the
   * correlated subqueries run once (not per updated row), and a failure-resume re-selects and
   * re-applies exactly once (the batch is the last thing `processItem` does, so a `failure` means it
   * didn't commit). NOTE: decay is inherently non-idempotent (×factor^N); once-per-day rests on the
   * FSM's same-day-no-op, not this batch — the batch only prevents PARTIAL application.
   *
   * "active" is the SHARED lineage-aware definition everywhere (a future-valid fact counts as active:
   * it corroborates, and it can itself decay/boost). Decay candidate = active + `created_at` older
   * than the window + UNCORROBORATED (no active sibling with the same entity_slug+kind; a NULL slug
   * never corroborates) + UNRECALLED since `recallCutoffMs`. Boost = active, recalled ≥ thresholds in
   * the window, raise-only. The audit diff carries a CAPPED (`auditCap`) sample of ids + prior
   * confidence / notability (reversibility's real path is `revive_fact`'s explicit arg, not this).
   */
  async hygieneSweep(input: {
    now: string
    createdCutoff: string
    recallCutoffMs: number
    windowCutoffMs: number
    decayFactor: number
    floor: number
    toMedium: number
    toHigh: number
    auditCap: number
  }): Promise<{ decayed: number; softExpired: number; boosted: number }> {
    if (this.p.readOnly) throw new Error("dream hygiene denied: read-only principal")
    const t = this.p.tenantId
    const nowIso = input.now
    // The shared lineage-aware "active" gate (future-valid = active), as a reusable fragment.
    const active = (a: string): SQL =>
      sql`${sql.raw(a)}.expired_at IS NULL
        AND (${sql.raw(a)}.valid_until IS NULL OR ${sql.raw(a)}.valid_until > ${nowIso})
        AND ${sql.raw(a)}.superseded_by IS NULL AND ${sql.raw(a)}.consolidated_into IS NULL`

    // ── ID-FIRST selection ──────────────────────────────────────────────────────
    const decayRows = await this.db.all<{ id: number; confidence: number }>(sql`
      SELECT facts.id AS id, facts.confidence AS confidence FROM facts
      WHERE facts.tenant_id = ${t} AND ${active("facts")}
        AND facts.created_at < ${input.createdCutoff}
        AND NOT EXISTS (SELECT 1 FROM facts c WHERE c.tenant_id = ${t} AND c.id <> facts.id
          AND c.kind = facts.kind AND c.entity_slug = facts.entity_slug AND ${active("c")})
        AND NOT EXISTS (SELECT 1 FROM memory_recall_traces r WHERE r.tenant_id = ${t}
          AND r.target_id = CAST(facts.id AS TEXT) AND r.at >= ${input.recallCutoffMs})`)
    const round4 = (n: number): number => Math.round(n * 10000) / 10000
    const decayIds = decayRows.map((r) => r.id)
    const softExpireIds = decayRows
      .filter((r) => round4(r.confidence * input.decayFactor) < input.floor)
      .map((r) => r.id)

    const boostRows = await this.db.all<{ id: number; notability: string; cnt: number }>(sql`
      SELECT facts.id AS id, facts.notability AS notability,
        (SELECT COUNT(*) FROM memory_recall_traces r WHERE r.tenant_id = ${t}
          AND r.target_id = CAST(facts.id AS TEXT) AND r.at >= ${input.windowCutoffMs}) AS cnt
      FROM facts
      WHERE facts.tenant_id = ${t} AND ${active("facts")} AND facts.notability <> 'high'
        AND (SELECT COUNT(*) FROM memory_recall_traces r WHERE r.tenant_id = ${t}
          AND r.target_id = CAST(facts.id AS TEXT) AND r.at >= ${input.windowCutoffMs}) >= ${input.toMedium}`)
    const highIds = boostRows.filter((r) => r.cnt >= input.toHigh).map((r) => r.id)
    const medIds = boostRows
      .filter((r) => r.notability === "low" && r.cnt >= input.toMedium && r.cnt < input.toHigh)
      .map((r) => r.id)

    const decayed = decayIds.length
    const softExpired = softExpireIds.length
    const boosted = highIds.length + medIds.length
    if (decayed === 0 && boosted === 0) return { decayed: 0, softExpired: 0, boosted: 0 }

    // ── ONE atomic batch: decay → soft-expire → boost, all by id (chunked ≤90). ──
    const CHUNK = 90
    const chunks = <T>(xs: T[]): T[][] => {
      const out: T[][] = []
      for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK))
      return out
    }
    const statements: BatchStatement[] = []
    for (const c of chunks(decayIds)) {
      statements.push(
        this.db
          .update(facts)
          .set({ confidence: sql`round(facts.confidence * ${input.decayFactor}, 4)` })
          .where(and(eq(facts.tenantId, t), inArray(facts.id, c))),
      )
    }
    for (const c of chunks(softExpireIds)) {
      statements.push(
        this.db
          .update(facts)
          .set({ validUntil: nowIso })
          .where(and(eq(facts.tenantId, t), inArray(facts.id, c))),
      )
    }
    for (const c of chunks(highIds)) {
      statements.push(
        this.db
          .update(facts)
          .set({ notability: "high" })
          .where(and(eq(facts.tenantId, t), inArray(facts.id, c))),
      )
    }
    for (const c of chunks(medIds)) {
      statements.push(
        this.db
          .update(facts)
          .set({ notability: "medium" })
          .where(and(eq(facts.tenantId, t), inArray(facts.id, c))),
      )
    }
    const diff = {
      decayed,
      softExpired,
      boosted,
      // Capped reversibility sample (full lists can be unbounded on a large sweep).
      decaySample: decayRows.slice(0, input.auditCap).map((r) => ({
        id: r.id,
        priorConfidence: r.confidence,
      })),
      boostSample: boostRows.slice(0, input.auditCap).map((r) => ({
        id: r.id,
        priorNotability: r.notability,
      })),
      capped: decayRows.length > input.auditCap || boostRows.length > input.auditCap,
    }
    await batchWithAudit(this.db, this.p, statements, {
      action: "dream.hygiene",
      diff: JSON.stringify(diff),
    })
    return { decayed, softExpired, boosted }
  }
}

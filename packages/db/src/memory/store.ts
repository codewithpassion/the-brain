/**
 * `MemoryStore` — tenant-scoped reads/writes for OKF-compatible agent memory on the docgraph
 * `pages` layer (docs/okf-memory-plan.md). The versioned page-CRUD MECHANISM now lives in the
 * shared `PageStore` (v3/W1); `MemoryStore` is a THIN policy caller that keeps the `memory_*`
 * contract byte-identical:
 *   - PROVENANCE is `ingested_via='memory'` (its reads filter to it, so memory never picks up
 *     wiki/ingest pages);
 *   - AUTHORIZATION is ownership-gated (`assertOwns`) + scope-gated, and the exact deny messages
 *     / audit action names (`page.set` | `page.revert` | `page.forget`) are preserved;
 *   - every mutation is one audited, all-or-nothing batch (invariants 1, 8, 10, 11) — supplied by
 *     `PageStore`.
 *
 * A memory item is a `pages` row with `ingested_via='memory'`; its identity is the `slug`
 * (the OKF concept id, e.g. `agent/planner/prefs`). Each committed state is a `page_revisions`
 * row (the live `pages` row mirrors the latest) — the history behind `getMemoryHistory` +
 * the forward-only `revertMemory`.
 */
import type { Principal } from "@brain/shared"
import { and, desc, eq, isNull, or, sql } from "drizzle-orm"
import { type BatchStatement, contentHash, PageStore, parseFrontmatter } from "../pages/store"
import { pageRevisions, pages } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { scopePredicate, visibilityPredicate } from "../scoped/predicates"
import { sqlStartsWith } from "../sql-utils"

/** Memory pages are tagged with this `ingested_via` so memory reads never pick up ingest pages. */
export const MEMORY_INGESTED_VIA = "memory"

const pageVisibilityCols = {
  visibility: pages.visibility,
  teamId: pages.teamId,
  userId: pages.userId,
} as const

/** `upsertMemory` input. `frontmatter` is the COMPLETE OKF frontmatter (incl. `type`/`title`). */
export interface UpsertMemoryInput {
  /** OKF concept id, e.g. `agent/planner/prefs`. The stable key across versions. */
  slug: string
  /** Complete OKF frontmatter object — `type` is required + non-empty; unknown keys preserved. */
  frontmatter: Record<string, unknown>
  /** Markdown body (stored inline; the OKF concept body). */
  body: string
  visibility?: string
  scope?: string | null
  teamId?: string | null
}

export interface UpsertMemoryResult {
  slug: string
  pageId: string
  version: number
  /** False when `content_hash` matched (a no-op — no new revision written). */
  changed: boolean
}

/** A live memory item after the scoped + visibility-gated read. */
export interface MemoryRow {
  slug: string
  pageId: string
  type: string
  title: string
  visibility: string
  scope: string | null
  frontmatter: Record<string, unknown>
  body: string
  version: number
  createdAt: string
  updatedAt: string
}

/** One entry in a memory item's version history. */
export interface MemoryRevisionRow {
  /** Durable revision handle — the `to_revision_id` for rollback. */
  revisionId: number
  version: number
  type: string
  title: string
  visibility: string
  reason: string | null
  authorUserId: string | null
  frontmatter: Record<string, unknown>
  body: string
  createdAt: string
}

export class MemoryStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal
  private readonly pages: PageStore

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
    this.pages = new PageStore(db, principal)
  }

  // ── shared policy (mirrors SessionStore / ScopedDB) ────────────────────────────────

  /** Authorship: the author, or a teammate on a `team`-tier page, may mutate a memory item. */
  private assertOwns(row: { userId: string | null; teamId: string | null }): void {
    if (row.userId === this.p.userId) return
    if (row.teamId !== null && this.p.teamIds.includes(row.teamId)) return
    throw new Error("memory: not owned by this principal")
  }

  // ── writes ────────────────────────────────────────────────────────────────────────

  /**
   * Create or update a memory item by `slug`. On a content change it appends a `page_revisions`
   * row (the new committed state) and mirrors it onto the live `pages` row, reconciling tags +
   * in-body links, all in ONE audited batch (via `PageStore`). `content_hash` makes an unchanged
   * write a no-op. The volatile OKF `timestamp` is excluded from the hash so an otherwise-identical
   * re-set is a genuine no-op.
   */
  async upsertMemory(input: UpsertMemoryInput): Promise<UpsertMemoryResult> {
    if (this.p.readOnly) throw new Error("memory_set denied: read-only principal")
    const fm = input.frontmatter
    const type = typeof fm.type === "string" ? fm.type.trim() : ""
    if (type.length === 0) {
      throw new Error("memory_set: frontmatter.type is required and must be non-empty (OKF)")
    }
    const title = typeof fm.title === "string" ? fm.title : ""
    const visibility = input.visibility ?? "private"
    const fmJson = JSON.stringify(fm)
    // Skip-unchanged must ignore the volatile OKF `timestamp` (injected fresh on every set),
    // else two identical writes would always differ and bloat history with no-op revisions.
    const fmStable = { ...fm }
    delete fmStable.timestamp

    return this.pages.upsert({
      slug: input.slug,
      type,
      title,
      visibility, // memory ALWAYS supplies a concrete tier (default private) — no preserve/escalate
      frontmatter: fm,
      frontmatterJson: fmJson,
      body: input.body,
      hashFrontmatter: JSON.stringify(fmStable), // timestamp-excluded, so a re-set is a real no-op
      scope: input.scope ?? null,
      teamId: input.teamId ?? null,
      ingestedVia: MEMORY_INGESTED_VIA,
      sourceKind: MEMORY_INGESTED_VIA,
      linkSource: "okf",
      // The memory lane is resolved-only: unresolved links are dropped, never recorded as red links.
      recordPending: false,
      writeTeamIdOnUpdate: false, // team_id/scope immutable after create (pre-v3 memory contract)
      auditAction: "page.set",
      reason: "set",
      readOnlyDenyMessage: "memory_set denied: read-only principal",
      // The memory authorization gate: scope + team on every write; provenance + ownership when the
      // slug already exists. Pure (no side effects), so its position after the lookup is invariant.
      authorize: (existing) => {
        if (input.scope) this.pages.assertScopeAllowed(input.scope)
        if (input.teamId && !this.p.teamIds.includes(input.teamId)) {
          throw new Error(`team '${input.teamId}' not in this principal's teamIds`)
        }
        if (existing) {
          // The slug index spans ALL pages; never let a memory write clobber a wiki/ingest page.
          if (existing.ingestedVia !== MEMORY_INGESTED_VIA) {
            throw new Error(`memory_set: slug '${input.slug}' is in use by a non-memory page`)
          }
          this.assertOwns(existing)
        }
      },
    })
  }

  /**
   * Roll back a memory item to an earlier revision (forward-only): append a NEW revision whose
   * content equals the target revision's, mirror it onto the live page, re-reconcile tags/links,
   * audit. History is never mutated. The target must belong to this tenant + this slug.
   */
  async revertMemory(
    slug: string,
    toRevisionId: number,
  ): Promise<{ slug: string; pageId: string; version: number; revertedFrom: number }> {
    if (this.p.readOnly) throw new Error("memory_rollback denied: read-only principal")
    const live = await this.resolveLivePage(slug)
    if (live === null) throw new Error(`memory: no live item at slug '${slug}'`)
    this.assertOwns(live)

    const targetRows = await this.db
      .select({
        version: pageRevisions.version,
        type: pageRevisions.type,
        title: pageRevisions.title,
        compiledTruth: pageRevisions.compiledTruth,
        frontmatter: pageRevisions.frontmatter,
        visibility: pageRevisions.visibility,
      })
      .from(pageRevisions)
      .where(
        and(
          eq(pageRevisions.tenantId, this.p.tenantId),
          eq(pageRevisions.pageId, live.id),
          eq(pageRevisions.id, toRevisionId),
        ),
      )
      .limit(1)
    const target = targetRows[0]
    if (target === undefined) {
      throw new Error(`memory: revision ${toRevisionId} not found for slug '${slug}'`)
    }

    const now = new Date().toISOString()
    const version = (await this.pages.maxVersion(live.id)) + 1
    const hash = contentHash(
      target.type,
      target.title,
      target.visibility,
      target.frontmatter,
      target.compiledTruth,
    )
    const fm = parseFrontmatter(target.frontmatter)
    const statements: BatchStatement[] = [
      this.db.insert(pageRevisions).values({
        tenantId: this.p.tenantId,
        pageId: live.id,
        version,
        slug,
        type: target.type,
        title: target.title,
        compiledTruth: target.compiledTruth,
        frontmatter: target.frontmatter,
        visibility: target.visibility,
        authorUserId: this.p.userId,
        reason: `revert:${target.version}`,
        createdAt: now,
      }),
      this.db
        .update(pages)
        .set({
          type: target.type,
          title: target.title,
          visibility: target.visibility,
          compiledTruth: target.compiledTruth,
          frontmatter: target.frontmatter,
          contentHash: hash,
          updatedAt: now,
        })
        .where(and(eq(pages.id, live.id), eq(pages.tenantId, this.p.tenantId))),
      ...this.pages.tagStatements(live.id, fm),
      // Memory lane: resolved-only reconcile (recordPending=false), no retroactive materialization.
      ...(await this.pages.reconcileLinkStatements(
        live.id,
        slug,
        target.compiledTruth,
        "okf",
        false,
      )),
      this.pages.auditStatement(
        "page.revert",
        slug,
        JSON.stringify({ from: target.version, to: version }),
      ),
    ]
    await this.pages.commitBatch(statements)
    return { slug, pageId: live.id, version, revertedFrom: target.version }
  }

  /** Soft-delete a memory item (the revision history is retained). Ownership-gated, audited. */
  async forgetMemory(slug: string): Promise<{ slug: string; forgotten: boolean }> {
    if (this.p.readOnly) throw new Error("memory_forget denied: read-only principal")
    const live = await this.resolveLivePage(slug)
    if (live === null) return { slug, forgotten: false }
    this.assertOwns(live)
    const now = new Date().toISOString()
    const update = this.db
      .update(pages)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(eq(pages.id, live.id), eq(pages.tenantId, this.p.tenantId), isNull(pages.deletedAt)),
      )
    await this.pages.commitBatch([update, this.pages.auditStatement("page.forget", slug)])
    return { slug, forgotten: true }
  }

  // ── reads (every read ANDs the SHARED scope + visibility predicate) ─────────────────

  /** Resolve a live memory page by slug (tenant + scope + visibility gated). Null when absent. */
  private async resolveLivePage(
    slug: string,
  ): Promise<{ id: string; userId: string | null; teamId: string | null } | null> {
    const rows = await this.db
      .select({ id: pages.id, userId: pages.userId, teamId: pages.teamId })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.slug, slug),
          eq(pages.ingestedVia, MEMORY_INGESTED_VIA),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, pageVisibilityCols),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }

  private memorySelect() {
    return this.db
      .select({
        slug: pages.slug,
        pageId: pages.id,
        type: pages.type,
        title: pages.title,
        visibility: pages.visibility,
        scope: pages.scope,
        frontmatter: pages.frontmatter,
        body: pages.compiledTruth,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
  }

  private hydrate(row: {
    slug: string
    pageId: string
    type: string
    title: string
    visibility: string
    scope: string | null
    frontmatter: string
    body: string
    createdAt: string
    updatedAt: string
  }): Omit<MemoryRow, "version"> {
    return { ...row, frontmatter: parseFrontmatter(row.frontmatter) }
  }

  /** Load a single memory item in full by its exact slug. Null when absent / not visible. */
  async getMemory(slug: string): Promise<MemoryRow | null> {
    const rows = await this.memorySelect()
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.slug, slug),
          eq(pages.ingestedVia, MEMORY_INGESTED_VIA),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, pageVisibilityCols),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    return { ...this.hydrate(row), version: await this.pages.maxVersion(row.pageId) }
  }

  /**
   * Load every live memory item under a path. `prefix=false` (default) matches the namespace
   * exactly (`slug = path` OR a direct child); `prefix=true` matches the whole subtree.
   * With no `path`, lists all memory items for the principal. Bodies are returned in full.
   */
  async listMemory(
    opts: { path?: string; prefix?: boolean; limit?: number } = {},
  ): Promise<MemoryRow[]> {
    // No path → all items. prefix=true → the whole subtree; prefix=false → the path itself plus
    // its DIRECT children (`path/x`, not `path/x/y`) — the "named items under a path" model.
    // LIKE-free prefix tests (`sqlStartsWith` / `instr` on a substring): Cloudflare D1 caps LIKE
    // patterns at 50 bytes, so a `slug LIKE ${path}/%` form throws in prod once the path is long.
    const pathClause = opts.path
      ? opts.prefix
        ? or(eq(pages.slug, opts.path), sqlStartsWith(pages.slug, `${opts.path}/`))
        : or(
            eq(pages.slug, opts.path),
            // Direct child only: under `${path}/` AND no further `/` in the remainder.
            and(
              sqlStartsWith(pages.slug, `${opts.path}/`),
              sql`instr(substr(${pages.slug}, length(${opts.path}) + 2), '/') = 0`,
            ),
          )
      : undefined
    const rows = await this.memorySelect()
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.ingestedVia, MEMORY_INGESTED_VIA),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, pageVisibilityCols),
          pathClause,
        ),
      )
      .orderBy(pages.slug)
      .limit(opts.limit ?? 200)
    // version per row: one batched lookup keeps this O(1) round-trips for the common small list.
    const out: MemoryRow[] = []
    for (const row of rows) {
      out.push({ ...this.hydrate(row), version: await this.pages.maxVersion(row.pageId) })
    }
    return out
  }

  /**
   * List a memory item's full version history, newest-first (`id DESC`). Gated through the live
   * page (so the visibility tier is enforced). Returns `[]` when the slug is absent / not visible.
   */
  async getMemoryHistory(slug: string): Promise<MemoryRevisionRow[]> {
    const gate = await this.db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.slug, slug),
          eq(pages.ingestedVia, MEMORY_INGESTED_VIA),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, pageVisibilityCols),
        ),
      )
      .limit(1)
    const pageId = gate[0]?.id
    if (pageId === undefined) return []
    const rows = await this.db
      .select({
        revisionId: pageRevisions.id,
        version: pageRevisions.version,
        type: pageRevisions.type,
        title: pageRevisions.title,
        visibility: pageRevisions.visibility,
        reason: pageRevisions.reason,
        authorUserId: pageRevisions.authorUserId,
        frontmatter: pageRevisions.frontmatter,
        body: pageRevisions.compiledTruth,
        createdAt: pageRevisions.createdAt,
      })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.tenantId, this.p.tenantId), eq(pageRevisions.pageId, pageId)))
      .orderBy(desc(pageRevisions.id))
    return rows.map((row) => ({ ...row, frontmatter: parseFrontmatter(row.frontmatter) }))
  }
}

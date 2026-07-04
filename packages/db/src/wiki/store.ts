/**
 * `WikiStore` — the wiki write/read path on the shared `pages` layer (v3/W1). Wiki pages ARE
 * `pages` rows (`ingested_via='wiki'`), the SAME table memory uses (invariant W-i1); this store is
 * thin policy over the shared `PageStore` (versioned CRUD + red-link reconcile) plus `ScopedGraph`
 * (backlinks/tags/timeline reads).
 *
 * Provenance lanes stay clean (W1 item 4): every wiki WRITE refuses a non-wiki slug with a teaching
 * error (a memory slug says "edit via memory_set"), so wiki ops never mutate a memory page's
 * provenance and vice-versa. READS are open — a page is a page — so `getPage`/`listPages` surface
 * memory-provenance pages too. Authorization is NOT ownership-gated like memory (wiki pages are
 * collaboratively editable): a write is allowed when the principal can SEE the page under the
 * SHARED scope + visibility gate (invariant W-i5); the author on every revision is the principal
 * (W-i3), never the original creator.
 */
import { DOC_GRAPH, type Principal } from "@brain/shared"
import { and, eq, isNull, like, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import type { DocLinkRow, TimelineRow } from "../graph/scoped-graph"
import { ScopedGraph } from "../graph/scoped-graph"
import {
  contentHash,
  type ExistingPageRow,
  type PageRevisionFull,
  PageStore,
  parseFrontmatter,
} from "../pages/store"
import { docLinks, pageRevisions, pages, tags } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { scopePredicate, visibilityPredicate } from "../scoped/predicates"
import { EntityPageStore, type EntitySections } from "./entity-pages"

const WIKI_INGESTED_VIA = "wiki"

/** `wiki_save_page` input — OKF frontmatter is expressed as typed scalars (`type` required). */
export interface WikiSavePageInput {
  slug: string
  type: string
  body: string
  title?: string
  description?: string
  tags?: string[]
  visibility?: "private" | "team" | "world"
  /** Unpublished flag → frontmatter `draft`; surfaces the page in the sidebar's Drafts section. */
  draft?: boolean
}

export interface WikiSavePageResult {
  slug: string
  pageId: string
  version: number
  changed: boolean
}

/** One node in a `wiki_list_pages` tree-shaped listing (suitable for a sidebar). */
export interface WikiListEntry {
  slug: string
  title: string
  type: string
  visibility: string
  ingestedVia: string | null
  updatedAt: string
  /** How many pages live under `<slug>/…` (the subtree size, for tree expansion). */
  childCount: number
  /** True when the page carries a frontmatter `draft` flag (→ the sidebar's Drafts section). */
  draft: boolean
}

/** A page's full detail (the `wiki_get_page` payload). */
export interface WikiPageDetail {
  page: {
    id: string
    slug: string
    title: string
    type: string
    visibility: string
    ingestedVia: string | null
    entityId: string | null
    createdAt: string
    updatedAt: string
  }
  body: string
  frontmatter: Record<string, unknown>
  backlinks: DocLinkRow[]
  tags: string[]
  timeline: TimelineRow[]
  revisions: {
    revisionId: number
    version: number
    reason: string | null
    authorUserId: string | null
    createdAt: string
  }[]
  links: {
    /** Resolved outbound edges (to visible pages). */
    resolved: DocLinkRow[]
    /** Unresolved (red) outbound link target slugs — no page there yet. */
    pending: string[]
  }
  /** Live (unstored) entity sections when this page IS about an entity (mentions/relations). */
  entity?: EntitySections
  /** True for a synthesizable entity-page STUB — the entity exists but has no page yet (lazy mint). */
  stub?: boolean
}

export interface WikiMoveResult {
  fromSlug: string
  toSlug: string
  pageId: string
}

/** `wiki_page_history` payload: full revision snapshots (newest-first), or null when not visible. */
export interface WikiPageHistory {
  revisions: PageRevisionFull[] | null
}

export class WikiStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal
  private readonly pages: PageStore
  private readonly graph: ScopedGraph
  private readonly entityPages: EntityPageStore

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
    this.pages = new PageStore(db, principal)
    this.graph = new ScopedGraph(db, principal)
    this.entityPages = new EntityPageStore(db, principal)
  }

  // ── authorization ──────────────────────────────────────────────────────────────────

  /** The wiki lane guard: a wiki write must target a wiki page (memory slugs get a teaching error). */
  private assertWikiProvenance(existing: ExistingPageRow, op: string, slug: string): void {
    if (existing.ingestedVia === WIKI_INGESTED_VIA) return
    if (existing.ingestedVia === "memory") {
      throw new Error(`${op}: slug '${slug}' is agent memory; edit it via memory_set`)
    }
    throw new Error(`${op}: slug '${slug}' is in use by a non-wiki page`)
  }

  /** A wiki write is allowed when the principal can SEE the page (shared scope + visibility gate). */
  private assertCanEdit(existing: ExistingPageRow, slug: string): void {
    if (existing.scope) this.pages.assertScopeAllowed(existing.scope)
    const vis = existing.visibility
    if (vis === "world") return
    if (vis === "team" && existing.teamId !== null && this.p.teamIds.includes(existing.teamId)) {
      return
    }
    if (vis === "private" && existing.userId === this.p.userId) return
    throw new Error(`wiki: page '${slug}' is not visible to this principal`)
  }

  // ── writes ───────────────────────────────────────────────────────────────────────

  /**
   * Create or update a wiki page by slug (versioned; `ingested_via='wiki'`). Author = principal.
   * Refuses a slug already owned by a non-wiki (e.g. memory) page.
   */
  async savePage(input: WikiSavePageInput): Promise<WikiSavePageResult> {
    // Visibility is passed through UNDEFINED when the caller omits it — PageStore then PRESERVES the
    // existing tier (or defaults a NEW page to the safe `private`), so an edit never escalates. Only
    // an explicit 'team' resolves a teamId (from the principal's first team).
    let teamId: string | null = null
    if (input.visibility === "team") {
      const team = this.p.teamIds[0]
      if (team === undefined) {
        throw new Error("wiki_save_page: visibility 'team' requires team membership")
      }
      teamId = team
    }
    return this.upsertWikiPage({
      slug: input.slug,
      type: input.type,
      title: input.title ?? "",
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      teamId,
      body: input.body,
      frontmatter: {
        type: input.type,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      },
      auditAction: "wiki.save",
    })
  }

  /** The shared wiki upsert seam (public save + the move redirect stub both flow through it). */
  private upsertWikiPage(args: {
    slug: string
    type: string
    title: string
    /** Omit to preserve the existing tier / default a new page to `private` (never escalate). */
    visibility?: string
    teamId: string | null
    body: string
    frontmatter: Record<string, unknown>
    auditAction: string
  }): Promise<WikiSavePageResult> {
    if (typeof args.type !== "string" || args.type.trim().length === 0) {
      throw new Error("wiki_save_page: type is required and must be non-empty (OKF)")
    }
    const fmJson = JSON.stringify(args.frontmatter)
    return this.pages.upsert({
      slug: args.slug,
      type: args.type,
      title: args.title,
      ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
      frontmatter: args.frontmatter,
      frontmatterJson: fmJson,
      body: args.body,
      hashFrontmatter: fmJson,
      scope: null,
      teamId: args.teamId,
      ingestedVia: WIKI_INGESTED_VIA,
      sourceKind: WIKI_INGESTED_VIA,
      linkSource: WIKI_INGESTED_VIA,
      recordPending: true, // wiki is the red-link lane
      writeTeamIdOnUpdate: true, // a world→team edit must write team_id (else the page is hidden)
      auditAction: args.auditAction,
      reason: "set",
      readOnlyDenyMessage: "wiki_save_page denied: read-only principal",
      authorize: (existing) => {
        if (existing === undefined) return // create: author = principal, no ownership gate
        this.assertWikiProvenance(existing, "wiki_save_page", args.slug)
        this.assertCanEdit(existing, args.slug)
      },
    })
  }

  /**
   * Rename a wiki page (`fromSlug`→`toSlug`), keeping the page id so all id-based `doc_links` edges
   * follow automatically, and leaving a `type:'redirect'` stub at the old slug that links to the new
   * one. Wiki-provenance only; the destination slug must be free (the unique slug index spans
   * soft-deleted rows, so a collision — even with a soft-deleted page — is rejected).
   */
  async movePage(fromSlug: string, toSlug: string): Promise<WikiMoveResult> {
    if (this.p.readOnly) throw new Error("wiki_move_page denied: read-only principal")
    if (fromSlug === toSlug) throw new Error("wiki_move_page: fromSlug and toSlug are identical")
    const from = await this.pages.findBySlug(fromSlug)
    if (from === undefined || from.deletedAt !== null) {
      throw new Error(`wiki_move_page: no live page at slug '${fromSlug}'`)
    }
    this.assertWikiProvenance(from, "wiki_move_page", fromSlug)
    this.assertCanEdit(from, fromSlug)
    const dest = await this.pages.findBySlug(toSlug)
    if (dest !== undefined) {
      throw new Error(`wiki_move_page: target slug '${toSlug}' is already in use`)
    }

    const now = new Date().toISOString()
    const version = (await this.pages.maxVersion(from.id)) + 1
    // Red links pointing at the NEW slug resolve to the moved page (visibility-scoped by the moved
    // page's own tier). Computed up-front so the whole move is ONE atomic batch.
    const resolveNew = await this.pages.resolveInboundPendingStatements(
      from.id,
      toSlug,
      from.visibility,
      from.userId ?? this.p.userId,
      from.teamId,
    )

    const stubId = crypto.randomUUID()
    const stubBody = `Moved to [[${toSlug}]].`
    const stubFm = { type: "redirect", title: from.title, redirect_to: toSlug }
    const stubFmJson = JSON.stringify(stubFm)
    const stubHash = contentHash("redirect", from.title, from.visibility, stubFmJson, stubBody)

    // ONE atomic batch. Order matters: the rename UPDATE frees `fromSlug` BEFORE the stub INSERT
    // reuses it (SQLite checks the unique slug index per-statement, not deferred). The stub's
    // `[[toSlug]]` edge is written directly to the moved page's id (no select — the target hasn't
    // been renamed on disk yet at build time, so a slug lookup would miss it).
    await this.pages.commitBatch([
      // 1. moved page: new revision at the new slug + the rename itself.
      this.db.insert(pageRevisions).values({
        tenantId: this.p.tenantId,
        pageId: from.id,
        version,
        slug: toSlug,
        type: from.type,
        title: from.title,
        compiledTruth: from.body,
        frontmatter: from.frontmatter,
        visibility: from.visibility,
        authorUserId: this.p.userId,
        reason: `move:${fromSlug}`,
        createdAt: now,
      }),
      this.db
        .update(pages)
        .set({ slug: toSlug, updatedAt: now })
        .where(and(eq(pages.id, from.id), eq(pages.tenantId, this.p.tenantId))),
      ...resolveNew,
      // 2. the redirect stub at the (now-free) old slug + its `[[toSlug]]` edge to the moved page.
      this.db.insert(pages).values({
        id: stubId,
        tenantId: this.p.tenantId,
        userId: this.p.userId,
        teamId: from.teamId,
        scope: null,
        slug: fromSlug,
        type: "redirect",
        title: from.title,
        visibility: from.visibility,
        compiledTruth: stubBody,
        frontmatter: stubFmJson,
        contentHash: stubHash,
        sourceKind: WIKI_INGESTED_VIA,
        ingestedVia: WIKI_INGESTED_VIA,
        ingestedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      this.db.insert(pageRevisions).values({
        tenantId: this.p.tenantId,
        pageId: stubId,
        version: 1,
        slug: fromSlug,
        type: "redirect",
        title: from.title,
        compiledTruth: stubBody,
        frontmatter: stubFmJson,
        visibility: from.visibility,
        authorUserId: this.p.userId,
        reason: "set",
        createdAt: now,
      }),
      this.db.insert(docLinks).values({
        id: crypto.randomUUID(),
        tenantId: this.p.tenantId,
        fromId: stubId,
        toId: from.id,
        linkType: "",
        linkSource: WIKI_INGESTED_VIA,
        originId: stubId,
      }),
      this.pages.auditStatement(
        "wiki.move",
        toSlug,
        JSON.stringify({ from: fromSlug, to: toSlug }),
      ),
    ])

    return { fromSlug, toSlug, pageId: from.id }
  }

  /** Soft-delete a wiki page. Wiki-provenance only; idempotent (absent/already-deleted → false). */
  async deletePage(
    slug: string,
  ): Promise<{ slug: string; deleted: boolean; pageId: string | null }> {
    if (this.p.readOnly) throw new Error("wiki_delete_page denied: read-only principal")
    const live = await this.pages.findBySlug(slug)
    if (live === undefined || live.deletedAt !== null) return { slug, deleted: false, pageId: null }
    this.assertWikiProvenance(live, "wiki_delete_page", slug)
    this.assertCanEdit(live, slug)
    const now = new Date().toISOString()
    const update = this.db
      .update(pages)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(eq(pages.id, live.id), eq(pages.tenantId, this.p.tenantId), isNull(pages.deletedAt)),
      )
    await this.pages.commitBatch([update, this.pages.auditStatement("wiki.delete", slug)])
    return { slug, deleted: true, pageId: live.id }
  }

  // ── reads (a page is a page — memory-provenance pages surface here too, W-i1) ────────

  /** Load a page's full detail by slug-or-id (visibility-gated). Null when absent / not visible. */
  async getPage(slugOrId: string): Promise<WikiPageDetail | null> {
    const pageId = await this.graph.resolveNodeId(DOC_GRAPH, slugOrId)
    if (pageId === null) return this.entityStub(slugOrId) // maybe an un-minted entity page (lazy)
    const row = await this.pages.getPageRow(pageId)
    if (row === null) return null
    const [backlinks, pageTags, timeline, revisions, pending, resolved] = await Promise.all([
      this.graph.getBacklinks(pageId),
      this.graph.getTags(pageId),
      this.graph.getTimeline(pageId),
      this.pages.getRevisionsSummary(pageId),
      this.pages.getPendingOutbound(pageId),
      this.graph.getLinks(pageId),
    ])
    // Live entity sections when this page IS about an entity (computed, never stored).
    let entity: EntitySections | undefined
    if (row.entityId !== null) {
      const ent = await this.entityPages.getEntity(row.entityId)
      if (ent !== null) entity = await this.entityPages.sectionsFor(ent)
    }
    return {
      page: {
        id: row.id,
        slug: row.slug,
        title: row.title,
        type: row.type,
        visibility: row.visibility,
        ingestedVia: row.ingestedVia,
        entityId: row.entityId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      body: row.body,
      frontmatter: parseFrontmatter(row.frontmatter),
      backlinks,
      tags: pageTags,
      timeline,
      revisions,
      links: { resolved, pending },
      ...(entity !== undefined ? { entity } : {}),
    }
  }

  /**
   * A page's revision history WITH body snapshots (for the diff view), gated EXACTLY like `getPage`:
   * `resolveNodeId` applies the tenant + scope + visibility predicates, so a page the caller can't
   * see resolves to null → `{ revisions: null }` (no revision bodies leak cross-user). Serves any
   * visible page (wiki OR entity — entity pages' dream-authored history is the W2 payoff); memory
   * pages keep their own `memory_history` lane but are also visible here (a page is a page).
   *
   * PUBLISH SEMANTICS (deliberate, W4a fix round): gating is on the page's CURRENT tier, not per
   * revision — so once a page is world, its FULL history is readable, including bodies of revisions
   * made while it was private. This is intentional MediaWiki-style behavior and matches
   * `memory_history` (which likewise returns all versions once the item is visible). Publishing a
   * page publishes its history; keep a revision private by keeping the page private.
   */
  async pageHistory(slugOrId: string, limit?: number): Promise<WikiPageHistory> {
    const pageId = await this.graph.resolveNodeId(DOC_GRAPH, slugOrId)
    if (pageId === null) return { revisions: null }
    return { revisions: await this.pages.getRevisionsWithBodies(pageId, limit) }
  }

  /**
   * Lazy-mint stub (W2): an `entities/<kind>/<name>` slug with a live entity but NO page yet returns
   * a synthesizable stub — the entity's live sections + the would-be page fields, no body/revisions —
   * so the UI can offer "create this page". Read-only (never writes). Null for a non-entity miss.
   */
  private async entityStub(slug: string): Promise<WikiPageDetail | null> {
    const ent = await this.entityPages.findEntityBySlug(slug)
    if (ent === null) return null
    const sections = await this.entityPages.sectionsFor(ent)
    return {
      page: {
        id: "",
        slug,
        title: ent.canonicalName,
        type: "entity",
        visibility: ent.visibility,
        ingestedVia: "entity",
        entityId: ent.id,
        createdAt: "",
        updatedAt: "",
      },
      body: "",
      frontmatter: { type: "entity", title: ent.canonicalName, entity_kind: ent.kind },
      backlinks: [],
      tags: [],
      timeline: [],
      revisions: [],
      links: { resolved: [], pending: [] },
      entity: sections,
      stub: true,
    }
  }

  /**
   * List pages for a sidebar tree: filtered by namespace prefix / type / tag, INCLUDING
   * memory-provenance pages (the memory-only listing guard is relaxed here — a page is a page).
   * `childCount` is the subtree size under each slug so the sidebar can render expanders.
   */
  async listPages(
    opts: { namespacePrefix?: string; type?: string; tag?: string; limit?: number } = {},
  ): Promise<WikiListEntry[]> {
    // Alias the OUTER pages table (`wp`) so the correlated `childCount` subquery references the
    // outer slug UNAMBIGUOUSLY against its own inner `child` alias. NOTE: interpolating `wp.slug`
    // into a raw `sql` fragment renders it BARE (`"slug"`), which the inner subquery would bind to
    // `child.slug` — so the outer slug is referenced via `sql.raw("<alias>"."slug")` instead.
    const OUTER = "wp"
    const wp = alias(pages, OUTER)
    const outerSlug = sql.raw(`"${OUTER}"."slug"`)
    const wpVisibilityCols = {
      visibility: wp.visibility,
      teamId: wp.teamId,
      userId: wp.userId,
    } as const
    const prefixClause = opts.namespacePrefix
      ? or(eq(wp.slug, opts.namespacePrefix), like(wp.slug, `${opts.namespacePrefix}/%`))
      : undefined
    const tagClause = opts.tag
      ? sql`EXISTS (SELECT 1 FROM ${tags} t WHERE t.tenant_id = ${this.p.tenantId} AND t.page_id = ${wp.id} AND t.tag = ${opts.tag})`
      : undefined
    // `childCount` as a correlated subquery — ONE statement, no per-row round-trips. The inner
    // `child` alias carries the SAME 3-tier visibility gate as the outer read, so a hidden descendant
    // never inflates the count (no existence oracle via the number).
    const teamFrag =
      this.p.teamIds.length > 0
        ? sql` OR (child.visibility = 'team' AND child.team_id IN (${sql.join(
            [...this.p.teamIds].map((t) => sql`${t}`),
            sql`, `,
          )}))`
        : sql``
    const scopeFrag =
      this.p.allowedScopes === "*"
        ? sql``
        : sql` AND child.scope IN (${sql.join(
            [...this.p.allowedScopes].map((s) => sql`${s}`),
            sql`, `,
          )})`
    const childCount = sql<number>`(SELECT COUNT(*) FROM pages child WHERE child.tenant_id = ${this.p.tenantId} AND child.deleted_at IS NULL AND child.slug LIKE ${outerSlug} || '/%'${scopeFrag} AND (child.visibility = 'world'${teamFrag} OR (child.visibility = 'private' AND child.user_id = ${this.p.userId})))`

    const rows = await this.db
      .select({
        slug: wp.slug,
        title: wp.title,
        type: wp.type,
        visibility: wp.visibility,
        ingestedVia: wp.ingestedVia,
        updatedAt: wp.updatedAt,
        frontmatter: wp.frontmatter,
        childCount,
      })
      .from(wp)
      .where(
        and(
          eq(wp.tenantId, this.p.tenantId),
          isNull(wp.deletedAt),
          scopePredicate(this.p, wp.scope),
          visibilityPredicate(this.p, wpVisibilityCols),
          prefixClause,
          opts.type ? eq(wp.type, opts.type) : undefined,
          tagClause,
        ),
      )
      .orderBy(wp.slug)
      .limit(opts.limit ?? 200)

    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      type: row.type,
      visibility: row.visibility,
      ingestedVia: row.ingestedVia,
      updatedAt: row.updatedAt,
      childCount: Number(row.childCount ?? 0),
      draft: parseFrontmatter(row.frontmatter).draft === true,
    }))
  }
}

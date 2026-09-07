/**
 * `EntityPageStore` (v3/W2) — entity pages: a `pages` row whose subject IS a knowledge-graph
 * entity, keyed by `pages.entity_id`, slug `entities/<kind>/<slugified-name>` (D5). Entity pages
 * live OUTSIDE the wiki lane guard on purpose: they are `ingested_via='entity'` (so `wiki_save_page`
 * refuses them — W1's provenance gate), and their write path is here. The agent (dream) is a
 * first-class author (W-i3); a human editor-in-chief always wins (the don't-clobber gate below).
 *
 * VISIBILITY (W-i5): entities are `{world,team}` only (never private) and merge MONOTONICALLY
 * (team→world, never back), so visibility+teamId are RE-DERIVED from the current entity on EVERY
 * write (mint AND dream-update) — a frozen tier could only ever become too restrictive. We never
 * fall back to `PageStore`'s `private` default; the tier is passed explicitly every time.
 *
 * Live sections (mentions / relations) are computed at read time (NOT stored in the body) so the
 * page shows the graph live while the body stays human/agent prose.
 */
import { entityPageSlug, type Principal, slugify } from "@brain/shared"
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { PageStore } from "../pages/store"
import {
  chunks,
  entities,
  entityMentions,
  entityRelations,
  pageRevisions,
  pages,
  sessions,
} from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { liveEntityPredicate, scopePredicate, visibilityPredicate } from "../scoped/predicates"

/** Dream/system authorship marker (matches the cron `systemAdmin` principal's userId). */
export const SYSTEM_AUTHOR = "system"
export const ENTITY_INGESTED_VIA = "entity"

/** The canonical entity-page slug (D5) — re-exported from `@brain/shared` so client + store agree. */
export { entityPageSlug }

/** The minimal live entity a page is built from (scoped + {world,team}-gated by the caller). */
export interface EntityForPage {
  id: string
  kind: string
  canonicalName: string
  description: string
  scope: string | null
  visibility: string
  teamId: string | null
}

/** A live relation edge, resolved to the other entity's page slug. */
export interface EntityRelationSection {
  direction: "out" | "in"
  kind: string
  entityId: string
  name: string
  slug: string
}

/** The live (unstored) sections rendered for an entity page. */
export interface EntitySections {
  entityId: string
  kind: string
  canonicalName: string
  mentions: { sourceKind: string; sourceId: string }[]
  relations: EntityRelationSection[]
}

export interface MintOrUpdateResult {
  slug: string
  pageId: string | null
  version: number
  changed: boolean
  /** True when the write was SKIPPED because a human edited the page more recently (W-i3). */
  skippedHumanEdited: boolean
}

const MENTION_LIMIT = 50
const RELATION_LIMIT = 100

export class EntityPageStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal
  private readonly pages: PageStore

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
    this.pages = new PageStore(db, principal)
  }

  /** The 2-tier `{world,team}` visibility gate for entities (they carry no `user_id`/private). */
  private entityVisible(alias = entities) {
    const parts = [eq(alias.visibility, "world")]
    if (this.p.teamIds.length > 0) {
      const team = and(eq(alias.visibility, "team"), inArray(alias.teamId, [...this.p.teamIds]))
      if (team) parts.push(team)
    }
    return or(...parts)
  }

  /** Load a live (non-merged) entity by id, tenant-scoped, WITHOUT the visibility gate. */
  private async loadLiveEntity(entityId: string): Promise<EntityForPage | null> {
    const rows = await this.db
      .select({
        id: entities.id,
        kind: entities.kind,
        canonicalName: entities.canonicalName,
        description: entities.description,
        scope: entities.scope,
        visibility: entities.visibility,
        teamId: entities.teamId,
        mergedInto: entities.mergedInto,
        deletedAt: entities.deletedAt,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, entityId)))
      .limit(1)
    const row = rows[0]
    if (row === undefined || row.mergedInto !== null || row.deletedAt !== null) return null
    const { mergedInto: _drop, deletedAt: _drop2, ...entity } = row
    return entity
  }

  /**
   * READ path: a live entity the PRINCIPAL can see (world, or a team it is on). Used by the page
   * view (live sections) + the lazy stub — a user never sees sections for an entity they can't see.
   */
  async getEntity(entityId: string): Promise<EntityForPage | null> {
    const entity = await this.loadLiveEntity(entityId)
    if (entity === null) return null
    if (
      entity.visibility === "team" &&
      !(entity.teamId !== null && this.p.teamIds.includes(entity.teamId))
    ) {
      return null
    }
    return entity
  }

  /**
   * WRITE path (dream/system maintenance): a live entity, tenant-scoped, WITHOUT the team gate. The
   * maintainer is a tenant-level system principal (`teamIds: []`), so a `team`-visibility entity must
   * still be page-maintained — its tier is DERIVED onto the page correctly regardless. Without this,
   * every team entity would be silently skipped (the system principal is on no team). Internal —
   * exposing it would invite a gate-bypass; the only caller is `mintOrUpdate`.
   */
  private async getEntityForMaintenance(entityId: string): Promise<EntityForPage | null> {
    return this.loadLiveEntity(entityId)
  }

  /**
   * Reverse-lookup a live, visible entity from its page slug (`entities/<kind>/<name>`), for the
   * lazy-mint stub. `slugify` is not invertible, so we NARROW by the decoded kind segment (the
   * `idx_entities_kind` index) and match the name by recomputed slug — no arbitrary row cap, so it
   * is correct at any size. LIMITATION: a kind whose slugified form differs from its lowercased form
   * (spaces/punctuation — not the controlled `person|org|concept|project` vocab) won't reverse-resolve
   * via the stub; such entities still get pages via the dream backfill / reflection. Null on no match.
   */
  async findEntityBySlug(slug: string): Promise<EntityForPage | null> {
    // Filter empty segments so a stray leading/trailing/double slash (`/entities/x/y`, `entities/x/y/`)
    // still resolves to the 3-part entity slug rather than silently 404-ing to a non-entity miss.
    const parts = slug.split("/").filter((s) => s.length > 0)
    if (parts.length !== 3 || parts[0] !== "entities") return null
    const kindSeg = parts[1] ?? ""
    const nameSeg = parts[2] ?? ""
    const rows = await this.db
      .select({
        id: entities.id,
        kind: entities.kind,
        canonicalName: entities.canonicalName,
        description: entities.description,
        scope: entities.scope,
        visibility: entities.visibility,
        teamId: entities.teamId,
      })
      .from(entities)
      .where(
        and(
          eq(entities.tenantId, this.p.tenantId),
          sql`lower(${entities.kind}) = ${kindSeg}`, // narrows via idx_entities_kind (real kinds)
          liveEntityPredicate(entities),
          this.entityVisible(),
        ),
      )
    return rows.find((row) => slugify(row.canonicalName, "entity") === nameSeg) ?? null
  }

  /**
   * Keep only mentions whose SOURCE object is visible to the caller (ISOLATION). `entity_mentions`
   * has no visibility column, so gate per `sourceKind` against the source table: chunk/page carry
   * the 3-tier gate; a document is visible when the caller can see ANY of its chunks; a session is
   * gated by owner/team (episodic memory has no visibility tier). Drops un-gateable/invisible ones,
   * so a world entity page never leaks a private/other-team source id.
   */
  private async visibleMentions(
    rows: { sourceKind: string; sourceId: string }[],
  ): Promise<{ sourceKind: string; sourceId: string }[]> {
    const idsByKind = new Map<string, string[]>()
    for (const r of rows) {
      const list = idsByKind.get(r.sourceKind)
      if (list) list.push(r.sourceId)
      else idsByKind.set(r.sourceKind, [r.sourceId])
    }
    const visible = new Set<string>() // "kind:id"
    const t = this.p.tenantId

    const chunkIds = idsByKind.get("chunk") ?? []
    if (chunkIds.length > 0) {
      const rowsC = await this.db
        .select({ id: chunks.id })
        .from(chunks)
        .where(
          and(
            eq(chunks.tenantId, t),
            inArray(chunks.id, chunkIds),
            isNull(chunks.deletedAt),
            scopePredicate(this.p, chunks.scope),
            visibilityPredicate(this.p, {
              visibility: chunks.visibility,
              teamId: chunks.teamId,
              userId: chunks.userId,
            }),
          ),
        )
      for (const c of rowsC) visible.add(`chunk:${c.id}`)
    }

    const pageIds = idsByKind.get("page") ?? []
    if (pageIds.length > 0) {
      const rowsP = await this.db
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            eq(pages.tenantId, t),
            inArray(pages.id, pageIds),
            isNull(pages.deletedAt),
            scopePredicate(this.p, pages.scope),
            visibilityPredicate(this.p, {
              visibility: pages.visibility,
              teamId: pages.teamId,
              userId: pages.userId,
            }),
          ),
        )
      for (const p of rowsP) visible.add(`page:${p.id}`)
    }

    const docIds = idsByKind.get("document") ?? []
    if (docIds.length > 0) {
      // A document is visible when the caller can see at least one of its (visible) chunks.
      const rowsD = await this.db
        .selectDistinct({ documentId: chunks.documentId })
        .from(chunks)
        .where(
          and(
            eq(chunks.tenantId, t),
            inArray(chunks.documentId, docIds),
            isNull(chunks.deletedAt),
            scopePredicate(this.p, chunks.scope),
            visibilityPredicate(this.p, {
              visibility: chunks.visibility,
              teamId: chunks.teamId,
              userId: chunks.userId,
            }),
          ),
        )
      for (const d of rowsD) visible.add(`document:${d.documentId}`)
    }

    const sessionIds = idsByKind.get("session") ?? []
    if (sessionIds.length > 0) {
      // Sessions carry no visibility tier — gate by owner (or a team the caller is on) + scope.
      const ownerGate =
        this.p.teamIds.length > 0
          ? or(eq(sessions.userId, this.p.userId), inArray(sessions.teamId, [...this.p.teamIds]))
          : eq(sessions.userId, this.p.userId)
      const rowsS = await this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.tenantId, t),
            inArray(sessions.id, sessionIds),
            scopePredicate(this.p, sessions.scope),
            ownerGate,
          ),
        )
      for (const s of rowsS) visible.add(`session:${s.id}`)
    }

    return rows.filter((r) => visible.has(`${r.sourceKind}:${r.sourceId}`))
  }

  /** Compute the live sections (mentions + relations→entity-page slugs) for an entity. */
  async sectionsFor(entity: EntityForPage): Promise<EntitySections> {
    const rawMentions = await this.db
      .select({ sourceKind: entityMentions.sourceKind, sourceId: entityMentions.sourceId })
      .from(entityMentions)
      .where(
        and(eq(entityMentions.tenantId, this.p.tenantId), eq(entityMentions.entityId, entity.id)),
      )
      .orderBy(desc(entityMentions.createdAt))
      .limit(MENTION_LIMIT)
    const mentionRows = await this.visibleMentions(rawMentions)

    // Relations both directions, joined to the OTHER entity (visibility-gated), → its page slug.
    const relRows = await this.db
      .select({
        fromId: entityRelations.fromEntityId,
        toId: entityRelations.toEntityId,
        kind: entityRelations.kind,
        otherId: entities.id,
        otherKind: entities.kind,
        otherName: entities.canonicalName,
      })
      .from(entityRelations)
      .innerJoin(
        entities,
        and(
          eq(entities.tenantId, entityRelations.tenantId),
          sql`${entities.id} = CASE WHEN ${entityRelations.fromEntityId} = ${entity.id} THEN ${entityRelations.toEntityId} ELSE ${entityRelations.fromEntityId} END`,
          liveEntityPredicate(entities),
        ),
      )
      .where(
        and(
          eq(entityRelations.tenantId, this.p.tenantId),
          or(
            eq(entityRelations.fromEntityId, entity.id),
            eq(entityRelations.toEntityId, entity.id),
          ),
          this.entityVisible(),
        ),
      )
      .limit(RELATION_LIMIT)

    const relations: EntityRelationSection[] = relRows.map((r) => ({
      direction: r.fromId === entity.id ? "out" : "in",
      kind: r.kind,
      entityId: r.otherId,
      name: r.otherName,
      slug: entityPageSlug(r.otherKind, r.otherName),
    }))
    return {
      entityId: entity.id,
      kind: entity.kind,
      canonicalName: entity.canonicalName,
      mentions: mentionRows,
      relations,
    }
  }

  /** The most-recent revision author for a page (null when the page has no revisions / is absent). */
  private async latestAuthor(pageId: string): Promise<string | null | undefined> {
    const rows = await this.db
      .select({ authorUserId: pageRevisions.authorUserId })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.tenantId, this.p.tenantId), eq(pageRevisions.pageId, pageId)))
      .orderBy(desc(pageRevisions.id))
      .limit(1)
    return rows[0]?.authorUserId
  }

  /**
   * Mint (or update) an entity's page. Visibility+teamId+scope are re-derived from the live entity
   * every time. The DON'T-CLOBBER gate: when `systemAuthored` (the dream), SKIP the write if the
   * page's latest revision was authored by a human (W-i3: editor-in-chief) — unless `force`.
   */
  async mintOrUpdate(
    entityId: string,
    opts: { body: string; systemAuthored: boolean; force?: boolean; mintOnly?: boolean },
  ): Promise<MintOrUpdateResult | null> {
    // Maintenance sees ALL live tenant entities (the system principal is on no team); the entity's
    // own tier is derived onto the page below, so a team entity still gets a correctly-scoped page.
    const entity = await this.getEntityForMaintenance(entityId)
    if (entity === null) return null // merged / absent
    const slug = entityPageSlug(entity.kind, entity.canonicalName)

    const existing = await this.pages.findBySlug(slug)
    if (existing !== undefined) {
      // Reserved lane: an entity slug taken by a non-entity page is left untouched (teaching skip).
      if (existing.ingestedVia !== ENTITY_INGESTED_VIA) {
        return { slug, pageId: existing.id, version: 0, changed: false, skippedHumanEdited: false }
      }
      // Backfill (mintOnly): an entity page already exists → leave it untouched (never resurrect a
      // soft-deleted one, and never overwrite a reflection-enriched body). Only mints the missing.
      if (opts.mintOnly === true) {
        return { slug, pageId: existing.id, version: 0, changed: false, skippedHumanEdited: false }
      }
      // Don't-clobber: a system write never overwrites a human's more-recent edit.
      if (opts.systemAuthored && opts.force !== true) {
        const author = await this.latestAuthor(existing.id)
        if (author !== null && author !== undefined && author !== SYSTEM_AUTHOR) {
          return { slug, pageId: existing.id, version: 0, changed: false, skippedHumanEdited: true }
        }
      }
    }

    const frontmatter = {
      type: ENTITY_INGESTED_VIA,
      title: entity.canonicalName,
      entity_kind: entity.kind,
    }
    const result = await this.pages.upsert({
      slug,
      type: ENTITY_INGESTED_VIA,
      title: entity.canonicalName,
      visibility: entity.visibility, // re-derived from the entity every write (never private)
      teamId: entity.teamId,
      scope: entity.scope,
      frontmatter,
      frontmatterJson: JSON.stringify(frontmatter),
      body: opts.body,
      hashFrontmatter: JSON.stringify(frontmatter),
      entityId: entity.id,
      ingestedVia: ENTITY_INGESTED_VIA,
      sourceKind: ENTITY_INGESTED_VIA,
      linkSource: ENTITY_INGESTED_VIA,
      recordPending: true,
      writeTeamIdOnUpdate: true, // a team→world entity promotion must widen the page too
      auditAction: "entity.page.set",
      reason: "set",
      readOnlyDenyMessage: "entity page write denied: read-only principal",
      authorize: (row) => {
        if (row !== undefined && row.ingestedVia !== ENTITY_INGESTED_VIA) {
          throw new Error(`entity page: slug '${slug}' is in use by a non-entity page`)
        }
      },
    })
    return { ...result, skippedHumanEdited: false }
  }

  /**
   * D4 merge follow-on (deliverable 1): when the loser entity had a page, turn it into a redirect
   * stub pointing at the WINNER's entity page (`[[winner-slug]]` → a real `doc_links` edge when the
   * winner page exists, else a pending red link). A best-effort follow-on write AFTER `mergeEntities`
   * (NOT folded into its entity-graph batch); a no-op when the loser has no page or shares the slug.
   */
  /**
   * Soft-delete the minted page of an entity being deleted (`delete_entity`), so `wiki_list_pages`
   * stops listing it. Returns the page id (for the caller to reap the page's backing document) or
   * null when the entity never had a minted page (the lazy stub disappears with the entity).
   */
  async softDeleteEntityPage(
    entityId: string,
  ): Promise<{ pageId: string | null; slug: string | null; title: string | null }> {
    if (this.p.readOnly) throw new Error("entity page delete denied: read-only principal")
    const rows = await this.db
      .select({ id: pages.id, slug: pages.slug, title: pages.title })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.entityId, entityId),
          eq(pages.ingestedVia, ENTITY_INGESTED_VIA),
          sql`${pages.deletedAt} IS NULL`,
        ),
      )
      .limit(1)
    const page = rows[0]
    if (page === undefined) return { pageId: null, slug: null, title: null }
    const stamp = new Date().toISOString()
    await this.pages.commitBatch([
      this.db
        .update(pages)
        .set({ deletedAt: stamp, updatedAt: stamp })
        .where(and(eq(pages.id, page.id), eq(pages.tenantId, this.p.tenantId))),
      this.pages.auditStatement("entity.page.delete", page.slug),
    ])
    return { pageId: page.id, slug: page.slug, title: page.title }
  }

  async repointMergedPage(
    loserId: string,
    winnerId: string,
  ): Promise<{ repointed: boolean; winnerSlug?: string; loserPageId?: string }> {
    if (this.p.readOnly) throw new Error("entity page repoint denied: read-only principal")
    const loserRows = await this.db
      .select({
        id: pages.id,
        slug: pages.slug,
        title: pages.title,
        visibility: pages.visibility,
        teamId: pages.teamId,
      })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.entityId, loserId),
          eq(pages.ingestedVia, ENTITY_INGESTED_VIA),
          sql`${pages.deletedAt} IS NULL`,
        ),
      )
      .limit(1)
    const loserPage = loserRows[0]
    if (loserPage === undefined) return { repointed: false }

    const winnerRows = await this.db
      .select({
        kind: entities.kind,
        canonicalName: entities.canonicalName,
        visibility: entities.visibility,
        teamId: entities.teamId,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, winnerId)))
      .limit(1)
    const winner = winnerRows[0]
    if (winner === undefined) return { repointed: false }
    const winnerSlug = entityPageSlug(winner.kind, winner.canonicalName)
    if (winnerSlug === loserPage.slug) return { repointed: false } // same name → same slug, nothing

    // The redirect must never be MORE visible than the winner it points at (don't leak the winner's
    // existence), nor than the loser page was — so its tier = min(loser, winner). A world loser folded
    // into a TEAM winner leaves a TEAM redirect, not a world one.
    const bothWorld = loserPage.visibility === "world" && winner.visibility === "world"
    const redirectVisibility = bothWorld ? "world" : "team"
    const redirectTeamId =
      redirectVisibility === "team"
        ? winner.visibility === "team"
          ? winner.teamId
          : loserPage.teamId
        : null

    const now = new Date().toISOString()
    const body = `Merged into [[${winnerSlug}]].`
    const fm = { type: "redirect", title: loserPage.title, redirect_to: winnerSlug }
    const fmJson = JSON.stringify(fm)
    const version = (await this.pages.maxVersion(loserPage.id)) + 1
    await this.pages.commitBatch([
      this.db.insert(pageRevisions).values({
        tenantId: this.p.tenantId,
        pageId: loserPage.id,
        version,
        slug: loserPage.slug,
        type: "redirect",
        title: loserPage.title,
        compiledTruth: body,
        frontmatter: fmJson,
        visibility: redirectVisibility,
        authorUserId: this.p.userId,
        reason: "merge-redirect",
        createdAt: now,
      }),
      this.db
        .update(pages)
        .set({
          type: "redirect",
          compiledTruth: body,
          frontmatter: fmJson,
          visibility: redirectVisibility,
          teamId: redirectTeamId,
          updatedAt: now,
        })
        .where(and(eq(pages.id, loserPage.id), eq(pages.tenantId, this.p.tenantId))),
      ...(await this.pages.reconcileLinkStatements(
        loserPage.id,
        loserPage.slug,
        body,
        ENTITY_INGESTED_VIA,
        true,
      )),
      this.pages.auditStatement(
        "entity.page.merge-redirect",
        loserPage.slug,
        JSON.stringify({ loserId, winnerId, winnerSlug }),
      ),
    ])
    return { repointed: true, winnerSlug, loserPageId: loserPage.id }
  }
}

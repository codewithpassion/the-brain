/**
 * `ScopedGraph` — the graph-layer read/write chokepoint (PRD §6, invariants 1, 3, 8, 19).
 *
 * The frozen `ScopedDB` covers `chunks`/`documents`/`facts`; the graph node space
 * (`pages`/`entities`) + its edges (`doc_links`/`entity_relations`) + the KG bridge
 * (`entity_mentions`) are a SEPARATE access surface, so this is a NEW chokepoint built in
 * the SAME spirit — never a modification of the frozen one. Every method injects
 * `tenant_id = p.tenantId` (invariant 1) and ANDs the data-partition (`scopePredicate`) +
 * intra-tenant visibility gate (invariant 8) onto the node rows.
 *
 * THE TWO-GRAPH MODEL (invariant 19): `pages` is the ONLY doc-graph node space and carries
 * the full 3-tier visibility (`world|team|private`, with `user_id`); `entities` is a
 * separate graph whose node space is `{world, team}` only (no `user_id`, no `private`). The
 * generalized BFS is parameterized by an `EdgeSpec` so ONE engine walks both — and the node
 * gate is built generically from the spec (the private/`user_id` arm only when `userCol` is
 * set), so a cross-tenant or out-of-visibility node is UNREACHABLE: the BFS silently
 * dead-ends at it (drop-don't-error, no existence leak).
 */
import {
  CHUNK_DB_BATCH_SIZE,
  DOC_GRAPH,
  type EdgeSpec,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  type GraphPath,
  type Principal,
} from "@brain/shared"
import { and, desc, eq, inArray, isNotNull, isNull, like, or, type SQL, sql } from "drizzle-orm"
import { type AnySQLiteColumn, alias } from "drizzle-orm/sqlite-core"
import {
  chunks,
  docLinks,
  entities,
  entityMentions,
  entityRelations,
  pages,
  tags,
  timelineEntries,
} from "../schema"
import { type BatchStatement, batchWithAudit } from "../scoped/audit"
import type { BrainDrizzle } from "../scoped/db"
import {
  liveEntityPredicate,
  liveEntitySql,
  scopePredicate,
  visibilityPredicate,
} from "../scoped/predicates"

/** A typed page→page edge after the gated read. */
export interface DocLinkRow {
  fromId: string
  toId: string
  linkType: string
  context: string
}

/** A timeline entry after the gated read. */
export interface TimelineRow {
  id: string
  date: string
  summary: string
  detail: string
  source: string
}

/** An entity row after the scoped + `{world,team}` visibility-gated read. */
export interface EntityRow {
  id: string
  kind: string
  canonicalName: string
  description: string
  aliases: string[]
  scope: string | null
  visibility: string
  teamId: string | null
  mentionCount: number
}

/** A chunk loaded for KG extraction (the access tier travels onto the derived entities). */
export interface ExtractionChunk {
  id: string
  content: string
  scope: string | null
  visibility: string
  teamId: string | null
}

/** The `find_orphans` report shape (gbrain `findOrphans` generalized to both graphs). */
export interface OrphanReport {
  orphans: { id: string; label: string; type: string }[]
  totalOrphans: number
  totalLinkable: number
  totalNodes: number
  excluded: number
}

/** A derived access tier for an upserted entity (never model-supplied; from source chunks). */
export interface EntityTier {
  scope: string | null
  visibility: string
  teamId: string | null
}

/** `upsertEntity` input — the access tier is derived from the source chunks, not the LLM. */
export interface ExtractedEntityInput {
  name: string
  kind: string
  aliases: string[]
  description: string
  chunkIds: string[]
  scope: string | null
  visibility: string
  teamId: string | null
}

/** `relate` input — confidence + evidence union on conflict (openbrains `relateInternal`). */
export interface ExtractedRelationInput {
  kind: string
  confidence: number
  chunkIds: string[]
}

/** Traversal knobs (gbrain clamp: depth 1..10, direction in|out|both). */
export interface TraverseOptions {
  depth?: number
  direction?: "in" | "out" | "both"
}

/** The 2-value entity visibility gate (`{world, team}` only — entities carry no `user_id`). */
const entityVisibility = (
  p: Principal,
  cols: { visibility: AnySQLiteColumn; teamId: AnySQLiteColumn },
): SQL => {
  const parts: SQL[] = [eq(cols.visibility, "world")]
  if (p.teamIds.length > 0) {
    const team = and(eq(cols.visibility, "team"), inArray(cols.teamId, [...p.teamIds]))
    if (team) parts.push(team)
  }
  return or(...parts) ?? sql`1 = 0`
}

/** Quote each whitespace term so a hostile query cannot inject FTS5 operators. */
const sanitizeFts = (query: string): string =>
  query
    .split(/\s+/)
    .map((term) => term.replace(/["()*]/g, "").trim())
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" ")

const uniq = <T>(values: T[]): T[] => [...new Set(values)]

/** Alias set-union capped at `cap` (openbrains `dedupeCapped`). */
const dedupeCapped = (values: string[], cap: number): string[] => uniq(values).slice(0, cap)

const now = (): string => new Date().toISOString()

export class ScopedGraph {
  private readonly db: BrainDrizzle
  private readonly p: Principal

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
  }

  // ── NODE GATE (invariants 1, 3, 8) ────────────────────────────────────────────
  // Built generically from the EdgeSpec so the SAME engine gates both graphs. ANDs
  // tenant_id + scopePredicate + the visibility tier onto a node-row alias. The
  // private/user_id arm is included ONLY when spec.userCol is set (pages), so entities
  // (a {world,team}-only node space) never reference a non-existent `user_id` column.

  /** A boolean SQL expression gating node-row `alias` (tenant + scope + visibility). */
  private nodeGate(spec: EdgeSpec, alias: string): SQL {
    const parts: SQL[] = [sql`${sql.raw(`${alias}.tenant_id`)} = ${this.p.tenantId}`]
    if (spec.scopeCol && this.p.allowedScopes !== "*") {
      const scopes = [...this.p.allowedScopes]
      parts.push(
        sql`${sql.raw(`${alias}.${spec.scopeCol}`)} IN (${sql.join(
          scopes.map((scope) => sql`${scope}`),
          sql`, `,
        )})`,
      )
    }
    if (spec.visibilityCol) {
      const vcol = sql.raw(`${alias}.${spec.visibilityCol}`)
      const vis: SQL[] = [sql`${vcol} = 'world'`]
      if (spec.teamCol && this.p.teamIds.length > 0) {
        const teams = [...this.p.teamIds]
        vis.push(
          sql`(${vcol} = 'team' AND ${sql.raw(`${alias}.${spec.teamCol}`)} IN (${sql.join(
            teams.map((team) => sql`${team}`),
            sql`, `,
          )}))`,
        )
      }
      if (spec.userCol) {
        vis.push(
          sql`(${vcol} = 'private' AND ${sql.raw(`${alias}.${spec.userCol}`)} = ${this.p.userId})`,
        )
      }
      parts.push(sql`(${sql.join(vis, sql` OR `)})`)
    }
    return sql.join(parts, sql` AND `)
  }

  /**
   * Seed gate (iter-4 §6.0): resolve a node id through the scoped node lookup BEFORE the
   * walk. An out-of-grant / out-of-visibility / soft-deleted id returns `false`, so the
   * BFS never begins — an empty traversal, NOT a 403 (no existence leak).
   */
  async nodeVisible(spec: EdgeSpec, id: string): Promise<boolean> {
    const gate = this.nodeGate(spec, "n")
    const soft = spec.softDeleteCol
      ? sql` AND ${sql.raw(`n.${spec.softDeleteCol}`)} IS NULL`
      : sql``
    const stmt = sql`SELECT 1 AS ok FROM ${sql.raw(spec.nodeTable)} n WHERE n.id = ${id} AND ${gate}${soft} LIMIT 1`
    const rows = await this.db.all<{ ok: number }>(stmt)
    return rows.length > 0
  }

  /**
   * Resolve a slug-or-id to a VISIBLE node id (pages accept slug or id; entities accept id
   * only — the KG node space has no slug). Returns `null` when nothing visible matches.
   */
  async resolveNodeId(spec: EdgeSpec, slugOrId: string): Promise<string | null> {
    if (await this.nodeVisible(spec, slugOrId)) return slugOrId
    if (spec.nodeTable !== "pages") return null
    const rows = await this.db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          eq(pages.slug, slugOrId),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, {
            visibility: pages.visibility,
            teamId: pages.teamId,
            userId: pages.userId,
          }),
        ),
      )
      .limit(1)
    return rows[0]?.id ?? null
  }

  // ── GENERALIZED BFS (invariant 3/8/19) ────────────────────────────────────────

  /**
   * BFS over an `EdgeSpec` (both DOC_GRAPH and ENTITY_GRAPH). `tenant_id` is on EVERY hop
   * (the edge AND both JOINed endpoints), and the node gate is ANDed onto BOTH endpoints —
   * so a frontier id that NAMES an unreadable node yields no rows and the walk dead-ends
   * there. A cross-tenant or out-of-visibility hop is structurally impossible.
   */
  async traverse(spec: EdgeSpec, seedId: string, opts: TraverseOptions = {}): Promise<GraphPath[]> {
    const depth = Math.max(1, Math.min(opts.depth ?? 5, 10))
    const direction = opts.direction ?? "both"
    const paths: GraphPath[] = []
    if (!(await this.nodeVisible(spec, seedId))) return paths

    const visited = new Set<string>([seedId])
    let frontier = [seedId]
    const gateF = this.nodeGate(spec, "nf")
    const gateT = this.nodeGate(spec, "nt")
    const soft = spec.softDeleteCol
      ? sql` AND ${sql.raw(`nf.${spec.softDeleteCol}`)} IS NULL AND ${sql.raw(`nt.${spec.softDeleteCol}`)} IS NULL`
      : sql``
    // Edge metadata differs per edge table (NOT on the frozen EdgeSpec, which carries the
    // NODE type column): doc_links has link_type + context; entity_relations has kind +
    // confidence (no context). edgeTable is a closed union, so this branch is exhaustive.
    const edge =
      spec.edgeTable === "doc_links"
        ? {
            typeExpr: sql`e.link_type`,
            contextExpr: sql`COALESCE(e.context, '')`,
            confExpr: sql`NULL`,
          }
        : { typeExpr: sql`e.kind`, contextExpr: sql`''`, confExpr: sql`e.confidence` }
    const fromCol = sql.raw(`e.${spec.fromCol}`)
    const toCol = sql.raw(`e.${spec.toCol}`)

    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const dirClauses: SQL[] = []
      if (direction === "out" || direction === "both") {
        dirClauses.push(
          sql`${fromCol} IN (${sql.join(
            frontier.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
      }
      if (direction === "in" || direction === "both") {
        dirClauses.push(
          sql`${toCol} IN (${sql.join(
            frontier.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
      }
      const stmt = sql`
        SELECT ${fromCol} AS fid, ${toCol} AS tid, ${edge.typeExpr} AS link_type,
               ${edge.contextExpr} AS context, ${edge.confExpr} AS confidence
        FROM ${sql.raw(spec.edgeTable)} e
        JOIN ${sql.raw(spec.nodeTable)} nf ON nf.id = ${fromCol}
        JOIN ${sql.raw(spec.nodeTable)} nt ON nt.id = ${toCol}
        WHERE e.tenant_id = ${this.p.tenantId} AND (${sql.join(dirClauses, sql` OR `)})${soft}
          AND ${gateF} AND ${gateT}`
      const rows = await this.db.all<{
        fid: string
        tid: string
        link_type: string
        context: string
        confidence: number | null
      }>(stmt)

      const next: string[] = []
      for (const row of rows) {
        // gbrain CTE parity: only emit an edge that reaches an unvisited node, so a
        // bidirectional walk doesn't re-emit the edge it arrived on.
        if (visited.has(row.fid) && visited.has(row.tid)) continue
        const path: GraphPath = {
          from_id: row.fid,
          to_id: row.tid,
          link_type: row.link_type,
          context: row.context,
          depth: d,
        }
        if (row.confidence !== null) path.confidence = row.confidence
        paths.push(path)
        for (const candidate of [row.fid, row.tid]) {
          if (!visited.has(candidate)) {
            visited.add(candidate)
            next.push(candidate)
          }
        }
      }
      frontier = next
    }
    return paths
  }

  // ── TYPED LINKS / TAGS / TIMELINE (doc graph; gated like BFS, §6.5) ────────────

  /** Outgoing typed links from a page. Anchor + both endpoints carry the node gate. */
  async getLinks(pageId: string): Promise<DocLinkRow[]> {
    if (!(await this.nodeVisible(DOC_GRAPH, pageId))) return []
    return this.db
      .select({
        fromId: docLinks.fromId,
        toId: docLinks.toId,
        linkType: docLinks.linkType,
        context: docLinks.context,
      })
      .from(docLinks)
      .innerJoin(pages, and(eq(pages.id, docLinks.toId), eq(pages.tenantId, docLinks.tenantId)))
      .where(
        and(
          eq(docLinks.tenantId, this.p.tenantId),
          eq(docLinks.fromId, pageId),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, {
            visibility: pages.visibility,
            teamId: pages.teamId,
            userId: pages.userId,
          }),
        ),
      )
  }

  /** Backlinks (`idx_doc_links_to`): incoming typed links to a page, gated on the source. */
  async getBacklinks(pageId: string): Promise<DocLinkRow[]> {
    if (!(await this.nodeVisible(DOC_GRAPH, pageId))) return []
    return this.db
      .select({
        fromId: docLinks.fromId,
        toId: docLinks.toId,
        linkType: docLinks.linkType,
        context: docLinks.context,
      })
      .from(docLinks)
      .innerJoin(pages, and(eq(pages.id, docLinks.fromId), eq(pages.tenantId, docLinks.tenantId)))
      .where(
        and(
          eq(docLinks.tenantId, this.p.tenantId),
          eq(docLinks.toId, pageId),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, {
            visibility: pages.visibility,
            teamId: pages.teamId,
            userId: pages.userId,
          }),
        ),
      )
  }

  /** Tags for a page (gated through the page anchor). */
  async getTags(pageId: string): Promise<string[]> {
    if (!(await this.nodeVisible(DOC_GRAPH, pageId))) return []
    const rows = await this.db
      .select({ tag: tags.tag })
      .from(tags)
      .where(and(eq(tags.tenantId, this.p.tenantId), eq(tags.pageId, pageId)))
    return rows.map((row) => row.tag)
  }

  /** Timeline entries for a page, ordered `date DESC, id DESC` (gbrain `getTimeline`). */
  async getTimeline(pageId: string): Promise<TimelineRow[]> {
    if (!(await this.nodeVisible(DOC_GRAPH, pageId))) return []
    return this.db
      .select({
        id: timelineEntries.id,
        date: timelineEntries.date,
        summary: timelineEntries.summary,
        detail: timelineEntries.detail,
        source: timelineEntries.source,
      })
      .from(timelineEntries)
      .where(and(eq(timelineEntries.tenantId, this.p.tenantId), eq(timelineEntries.pageId, pageId)))
      .orderBy(desc(timelineEntries.date), desc(timelineEntries.id))
  }

  // ── DOC-GRAPH WRITES (W4.4; manual curation — every mutation audited in-batch) ─────

  /**
   * Add a typed link between two doc-graph pages, each resolved by slug-or-id through the SAME
   * visibility gate as the reads (you can only link pages you can see). Idempotent on the edge
   * unique index. Throws when an endpoint is not found/visible or the principal is read-only
   * (the shared `batchWithAudit` seam forces tenant/actor + rejects read-only).
   */
  async addLink(input: {
    from: string
    to: string
    linkType?: string
    context?: string
  }): Promise<DocLinkRow> {
    const fromId = await this.resolveNodeId(DOC_GRAPH, input.from)
    const toId = await this.resolveNodeId(DOC_GRAPH, input.to)
    if (fromId === null || toId === null) {
      throw new Error("add_link: link endpoint page not found or not visible")
    }
    const linkType = input.linkType ?? ""
    const context = input.context ?? ""
    const insert = this.db
      .insert(docLinks)
      .values({
        id: crypto.randomUUID(),
        tenantId: this.p.tenantId, // forced
        fromId,
        toId,
        linkType,
        linkSource: "manual",
        context,
      })
      .onConflictDoNothing()
    await batchWithAudit(this.db, this.p, [insert], {
      action: "graph.link.add",
      targetId: fromId,
      diff: JSON.stringify({ fromId, toId, linkType }),
    })
    // Return the PERSISTED edge's context: on the idempotent conflict path the STORED value wins
    // (the caller's context does NOT overwrite an existing manual link), so the result is honest.
    const rows = await this.db
      .select({ context: docLinks.context })
      .from(docLinks)
      .where(
        and(
          eq(docLinks.tenantId, this.p.tenantId),
          eq(docLinks.fromId, fromId),
          eq(docLinks.toId, toId),
          eq(docLinks.linkType, linkType),
          isNull(docLinks.originId), // manual links carry no origin_id (the edge-dedup key)
        ),
      )
      .limit(1)
    return { fromId, toId, linkType, context: rows[0]?.context ?? context }
  }

  /**
   * Attach a tag to a visible page (resolved by slug-or-id). Idempotent on the
   * `(tenant, page, tag)` unique key. Audited in-batch; read-only principals are rejected.
   */
  async addTag(input: { target: string; tag: string }): Promise<{ pageId: string; tag: string }> {
    const pageId = await this.resolveNodeId(DOC_GRAPH, input.target)
    if (pageId === null) throw new Error("add_tag: page not found or not visible")
    const insert = this.db
      .insert(tags)
      .values({ tenantId: this.p.tenantId, pageId, tag: input.tag })
      .onConflictDoNothing()
    await batchWithAudit(this.db, this.p, [insert], {
      action: "graph.tag.add",
      targetId: pageId,
      diff: JSON.stringify({ tag: input.tag }),
    })
    return { pageId, tag: input.tag }
  }

  /**
   * Append a timeline entry to a visible page (resolved by slug-or-id). Idempotent on the
   * `(tenant, page, date, summary)` unique key. Audited in-batch; read-only principals rejected.
   */
  async addTimelineEntry(input: {
    target: string
    date: string
    summary: string
    detail?: string
  }): Promise<{ id: string; pageId: string; date: string; summary: string }> {
    const pageId = await this.resolveNodeId(DOC_GRAPH, input.target)
    if (pageId === null) throw new Error("add_timeline_entry: page not found or not visible")
    const id = crypto.randomUUID()
    const insert = this.db
      .insert(timelineEntries)
      .values({
        id,
        tenantId: this.p.tenantId, // forced
        pageId,
        date: input.date,
        source: "manual",
        summary: input.summary,
        detail: input.detail ?? "",
      })
      .onConflictDoNothing()
    await batchWithAudit(this.db, this.p, [insert], {
      action: "graph.timeline.add",
      targetId: pageId,
      diff: JSON.stringify({ date: input.date, summary: input.summary }),
    })
    // Resolve the CANONICAL id: a fresh insert → `id`; the idempotent conflict path → the
    // PRE-EXISTING row's id (never the minted-but-unwritten one, which would reference no row).
    const rows = await this.db
      .select({ id: timelineEntries.id })
      .from(timelineEntries)
      .where(
        and(
          eq(timelineEntries.tenantId, this.p.tenantId),
          eq(timelineEntries.pageId, pageId),
          eq(timelineEntries.date, input.date),
          eq(timelineEntries.summary, input.summary),
        ),
      )
      .limit(1)
    return { id: rows[0]?.id ?? id, pageId, date: input.date, summary: input.summary }
  }

  // ── ENTITY READS (KG graph; scoped + {world,team} visibility) ──────────────────

  /** List entities, optionally by `kind`, ordered by recency. Scoped + visibility-gated. */
  async listEntities(opts?: { kind?: string; limit?: number }): Promise<EntityRow[]> {
    const rows = await this.db
      .select({
        id: entities.id,
        kind: entities.kind,
        canonicalName: entities.canonicalName,
        description: entities.description,
        aliases: entities.aliases,
        scope: entities.scope,
        visibility: entities.visibility,
        teamId: entities.teamId,
        mentionCount: entities.mentionCount,
      })
      .from(entities)
      .where(
        and(
          eq(entities.tenantId, this.p.tenantId),
          liveEntityPredicate(entities.mergedInto), // hide Dream-dedup losers (D4)
          scopePredicate(this.p, entities.scope),
          entityVisibility(this.p, { visibility: entities.visibility, teamId: entities.teamId }),
          opts?.kind ? eq(entities.kind, opts.kind) : undefined,
        ),
      )
      .orderBy(desc(entities.updatedAt))
      .limit(opts?.limit ?? 50)
    return rows.map((row) => ({ ...row, aliases: parseStringArray(row.aliases) }))
  }

  /**
   * List entity-to-entity edges, gated so BOTH endpoints satisfy the same scope +
   * `{world,team}` visibility rules as `listEntities`. Returns at most `limit` edges.
   * Uses Drizzle `alias()` to reuse the exact same helper predicates as `listEntities`,
   * preventing any gate-drift between nodes and edges.
   */
  async listEntityEdges(limit = 1000): Promise<
    {
      fromId: string
      fromName: string
      fromKind: string
      toId: string
      toName: string
      toKind: string
      kind: string
    }[]
  > {
    const ef = alias(entities, "ef")
    const et = alias(entities, "et")
    return this.db
      .select({
        fromId: entityRelations.fromEntityId,
        fromName: ef.canonicalName,
        fromKind: ef.kind,
        toId: entityRelations.toEntityId,
        toName: et.canonicalName,
        toKind: et.kind,
        kind: entityRelations.kind,
      })
      .from(entityRelations)
      .innerJoin(
        ef,
        and(eq(ef.id, entityRelations.fromEntityId), eq(ef.tenantId, entityRelations.tenantId)),
      )
      .innerJoin(
        et,
        and(eq(et.id, entityRelations.toEntityId), eq(et.tenantId, entityRelations.tenantId)),
      )
      .where(
        and(
          eq(entityRelations.tenantId, this.p.tenantId),
          liveEntityPredicate(ef.mergedInto), // both endpoints must be live (D4 dedup losers)
          liveEntityPredicate(et.mergedInto),
          scopePredicate(this.p, ef.scope),
          entityVisibility(this.p, { visibility: ef.visibility, teamId: ef.teamId }),
          scopePredicate(this.p, et.scope),
          entityVisibility(this.p, { visibility: et.visibility, teamId: et.teamId }),
        ),
      )
      .limit(limit)
  }

  /**
   * The mandatory D1 re-check for the entity vector/FTS arms (invariant 3). JOIN candidate
   * ids back to the live `entities` base table (tenant + scope + `{world,team}` visibility);
   * any cross-tenant / out-of-scope / hidden id is silently DROPPED. Chunked to respect the
   * 100 bound-param cap.
   */
  async recheckEntities(ids: string[]): Promise<(EntityRow & { createdAt: string })[]> {
    if (ids.length === 0) return []
    const out: (EntityRow & { createdAt: string })[] = []
    for (let i = 0; i < ids.length; i += CHUNK_DB_BATCH_SIZE) {
      const batch = ids.slice(i, i + CHUNK_DB_BATCH_SIZE)
      const rows = await this.db
        .select({
          id: entities.id,
          kind: entities.kind,
          canonicalName: entities.canonicalName,
          description: entities.description,
          aliases: entities.aliases,
          scope: entities.scope,
          visibility: entities.visibility,
          teamId: entities.teamId,
          mentionCount: entities.mentionCount,
          createdAt: entities.createdAt, // D4: lets the dedup sweep pickWinner without a re-read
        })
        .from(entities)
        .where(
          and(
            eq(entities.tenantId, this.p.tenantId),
            inArray(entities.id, batch),
            liveEntityPredicate(entities.mergedInto), // hide Dream-dedup losers (D4)
            scopePredicate(this.p, entities.scope),
            entityVisibility(this.p, { visibility: entities.visibility, teamId: entities.teamId }),
          ),
        )
      for (const row of rows) out.push({ ...row, aliases: parseStringArray(row.aliases) })
    }
    return out
  }

  /**
   * Entity keyword arm (invariant 4). MATCH stays PURE TEXT against `entity_fts`
   * (content_rowid='rowid'); the JOIN-back to `entities` re-checks tenant + scope +
   * `{world,team}` visibility BEFORE any id leaves. Returns ids only — the caller still
   * hydrates through `recheckEntities`.
   */
  async entityFtsIds(query: string, topK: number): Promise<string[]> {
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
      FROM entity_fts f
      JOIN entities x ON x.rowid = f.rowid
      WHERE entity_fts MATCH ${match}
        AND x.tenant_id = ${this.p.tenantId}
        AND ${liveEntitySql("x")}${scopeFragment}
        AND (x.visibility = 'world'${teamFragment})
      ORDER BY bm25(entity_fts)
      LIMIT ${topK}`
    try {
      const rows = await this.db.all<{ id: string }>(statement)
      return rows.map((row) => row.id)
    } catch {
      return []
    }
  }

  // ── ORPHAN REPORT (§6.6; a node read surface — carries the same gate) ──────────

  /** Disconnected nodes for human review (gbrain `findOrphans`, generalized to both graphs). */
  async findOrphans(graph: "doc" | "entity" = "doc"): Promise<OrphanReport> {
    if (graph === "entity") return this.findEntityOrphans()
    return this.findPageOrphans()
  }

  private async findPageOrphans(): Promise<OrphanReport> {
    const gate = and(
      eq(pages.tenantId, this.p.tenantId),
      isNull(pages.deletedAt),
      scopePredicate(this.p, pages.scope),
      visibilityPredicate(this.p, {
        visibility: pages.visibility,
        teamId: pages.teamId,
        userId: pages.userId,
      }),
    )
    const notLinked = sql`NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.tenant_id = ${this.p.tenantId} AND (l.from_id = ${pages.id} OR l.to_id = ${pages.id}))`
    // `_`-prefixed (or `/_`-containing) slugs are pseudo-pages, excluded from orphan reports.
    // substr/instr (not LIKE) sidesteps the `_` wildcard + escape-cooking pitfalls entirely.
    const notPseudo = sql`(substr(${pages.slug}, 1, 1) <> '_' AND instr(${pages.slug}, '/_') = 0)`

    const orphanRows = await this.db
      .select({ id: pages.id, label: pages.title, type: pages.type })
      .from(pages)
      .where(and(gate, notPseudo, notLinked))
    const totalNodes = await this.countWhere(pages, gate)
    const totalLinkable = await this.countWhere(pages, and(gate, notPseudo))
    return {
      orphans: orphanRows,
      totalOrphans: orphanRows.length,
      totalLinkable,
      totalNodes,
      excluded: totalNodes - totalLinkable,
    }
  }

  private async findEntityOrphans(): Promise<OrphanReport> {
    const gate = and(
      eq(entities.tenantId, this.p.tenantId),
      liveEntityPredicate(entities.mergedInto), // a merged loser is hidden, not an orphan (D4)
      scopePredicate(this.p, entities.scope),
      entityVisibility(this.p, { visibility: entities.visibility, teamId: entities.teamId }),
    )
    const notRelated = sql`NOT EXISTS (SELECT 1 FROM entity_relations r WHERE r.tenant_id = ${this.p.tenantId} AND (r.from_entity_id = ${entities.id} OR r.to_entity_id = ${entities.id}))`
    const orphanRows = await this.db
      .select({ id: entities.id, label: entities.canonicalName, type: entities.kind })
      .from(entities)
      .where(and(gate, notRelated))
    const totalNodes = await this.countWhere(entities, gate)
    return {
      orphans: orphanRows,
      totalOrphans: orphanRows.length,
      totalLinkable: totalNodes,
      totalNodes,
      excluded: 0,
    }
  }

  private async countWhere(
    table: typeof pages | typeof entities,
    where: SQL | undefined,
  ): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`COUNT(*)` }).from(table).where(where)
    return rows[0]?.n ?? 0
  }

  // ── KG WRITE PATH (extraction; tenant_id FORCED, tier from source chunks) ──────
  // These are pipeline-internal, idempotent, system-derived writes (NOT user mutations).
  // tenant_id is ALWAYS forced from the Principal; the LLM emits no access tier — the
  // caller derives scope/visibility/team_id from the source chunks and passes them here.

  /** Chunks for KG extraction: `visibility <> 'private'` (§6.2 — private never goes tenant-wide). */
  async loadChunksForExtraction(documentId: string): Promise<ExtractionChunk[]> {
    return this.db
      .select({
        id: chunks.id,
        content: chunks.content,
        scope: chunks.scope,
        visibility: chunks.visibility,
        teamId: chunks.teamId,
      })
      .from(chunks)
      .where(
        and(
          eq(chunks.tenantId, this.p.tenantId),
          eq(chunks.documentId, documentId),
          isNull(chunks.deletedAt),
          sql`${chunks.visibility} <> 'private'`,
        ),
      )
  }

  /**
   * Re-extract cleanup (`clear-prior-extraction`, openbrains `clearForThoughtInternal`):
   * deletes this source's `entity_mentions`, then prunes its chunk ids out of every
   * `entity_relations.evidence_chunk_ids` — a relation with no remaining evidence is deleted
   * outright. tenant-scoped throughout; idempotent under retry.
   *
   * When `sourceKind === "document"`, also clears chunk-scoped mentions (sourceKind='chunk')
   * for every chunk that belongs to the document — the extractor writes mentions via
   * `mention(entityId, "chunk", chunkId)`, so document-level cleanup must sweep both.
   *
   * `opts.gcOrphanedEntities` (default false): after clearing mentions, delete any entity
   * whose total mention count drops to zero across the entire tenant. This closes the entity-arm
   * queryability leak (`entityFtsIds`/`recheckEntities` query the `entities` table directly, not
   * `entity_mentions`). Also cleans up any dangling `entity_relations` rows (no FK CASCADE in
   * the schema). Do NOT set this for re-extract cleanup (the extractor is about to re-populate);
   * only set it on explicit document deletes.
   *
   * Note: `entities` rows are NOT deleted merely because their `source_chunk_ids` column is
   * stale — only zero-mention rows are GC'd, so entities shared across documents survive correctly.
   */
  /**
   * Clear KG extraction for a whole oversized-split document family (§4.3, W4.5): the root plus
   * every child part id. Each is cleared with entity GC, so a deleted/superseded split doc leaves
   * no orphaned mentions (a privacy leak — deleted content stays queryable via search_entities/
   * traverse_graph) and no zero-mention entities. A single-part doc → one clear (unchanged).
   */
  async clearExtractionForFamily(documentIds: readonly string[]): Promise<void> {
    for (const id of documentIds) {
      await this.clearPriorExtraction(
        { sourceKind: "document", sourceId: id },
        { gcOrphanedEntities: true },
      )
    }
  }

  async clearPriorExtraction(
    source: { sourceKind: string; sourceId: string },
    opts?: { gcOrphanedEntities?: boolean },
  ): Promise<void> {
    await this.db
      .delete(entityMentions)
      .where(
        and(
          eq(entityMentions.tenantId, this.p.tenantId),
          eq(entityMentions.sourceKind, source.sourceKind),
          eq(entityMentions.sourceId, source.sourceId),
        ),
      )
    if (source.sourceKind !== "document") return
    const chunkRows = await this.db
      .select({ id: chunks.id })
      .from(chunks)
      .where(and(eq(chunks.tenantId, this.p.tenantId), eq(chunks.documentId, source.sourceId)))
    const sourceChunkIds = new Set(chunkRows.map((row) => row.id))
    // NOTE: do NOT early-return when `sourceChunkIds` is empty. On the supersede path (and when a
    // whole child part is deleted, §4.3/W4.5) the chunk ROWS are hard-deleted BEFORE this runs, so
    // the doc has zero live chunks — yet its chunk-scoped mention rows (`${sourceId}:idx`) linger
    // and MUST be swept by the LIKE query below, or deleted content stays queryable (privacy leak).

    // Collect entity IDs from chunk-scoped mentions BEFORE clearing them, so we can GC after.
    // Use LIKE '${documentId}:%' instead of inArray(currentChunkIds): a supersede that shrinks
    // the chunk count hard-deletes old chunk rows first, so their mention rows are orphaned and
    // never in currentChunkIds — the prefix query catches them too. documentId is a UUID, so it
    // contains no LIKE wildcard characters (% or _) and is safe to interpolate directly.
    const potentialOrphans: string[] = []
    if (opts?.gcOrphanedEntities) {
      const rows = await this.db
        .selectDistinct({ entityId: entityMentions.entityId })
        .from(entityMentions)
        .where(
          and(
            eq(entityMentions.tenantId, this.p.tenantId),
            eq(entityMentions.sourceKind, "chunk"),
            like(entityMentions.sourceId, `${source.sourceId}:%`),
          ),
        )
      for (const row of rows) potentialOrphans.push(row.entityId)
    }

    // Clear ALL chunk-scoped mentions for this document by prefix — catches orphaned mention rows
    // from chunks that were hard-deleted before clearPriorExtraction ran (supersede shrink path).
    await this.db
      .delete(entityMentions)
      .where(
        and(
          eq(entityMentions.tenantId, this.p.tenantId),
          eq(entityMentions.sourceKind, "chunk"),
          like(entityMentions.sourceId, `${source.sourceId}:%`),
        ),
      )

    const rels = await this.db
      .select({ id: entityRelations.id, evidence: entityRelations.evidenceChunkIds })
      .from(entityRelations)
      .where(eq(entityRelations.tenantId, this.p.tenantId))
    for (const rel of rels) {
      const evidence = parseStringArray(rel.evidence)
      const pruned = evidence.filter((id) => !sourceChunkIds.has(id))
      if (pruned.length === evidence.length) continue
      if (pruned.length === 0) {
        await this.db
          .delete(entityRelations)
          .where(and(eq(entityRelations.tenantId, this.p.tenantId), eq(entityRelations.id, rel.id)))
      } else {
        await this.db
          .update(entityRelations)
          .set({ evidenceChunkIds: JSON.stringify(pruned), updatedAt: now() })
          .where(and(eq(entityRelations.tenantId, this.p.tenantId), eq(entityRelations.id, rel.id)))
      }
    }

    // GC: delete entities that now have zero remaining mentions tenant-wide, plus their dangling
    // relations (no FK CASCADE). Entities shared across documents survive — only truly orphaned
    // ones are removed.
    if (opts?.gcOrphanedEntities && potentialOrphans.length > 0) {
      const uniqueOrphans = [...new Set(potentialOrphans)]
      for (let i = 0; i < uniqueOrphans.length; i += CHUNK_DB_BATCH_SIZE) {
        const batch = uniqueOrphans.slice(i, i + CHUNK_DB_BATCH_SIZE)
        // Find which entities in this batch still have ANY mention after the clear.
        const stillMentioned = await this.db
          .selectDistinct({ entityId: entityMentions.entityId })
          .from(entityMentions)
          .where(
            and(
              eq(entityMentions.tenantId, this.p.tenantId),
              inArray(entityMentions.entityId, batch),
            ),
          )
        const stillMentionedIds = new Set(stillMentioned.map((row) => row.entityId))
        const orphanedIds = batch.filter((id) => !stillMentionedIds.has(id))
        if (orphanedIds.length === 0) continue
        // Delete dangling relations first (no FK CASCADE in schema).
        await this.db
          .delete(entityRelations)
          .where(
            and(
              eq(entityRelations.tenantId, this.p.tenantId),
              or(
                inArray(entityRelations.fromEntityId, orphanedIds),
                inArray(entityRelations.toEntityId, orphanedIds),
              ),
            ),
          )
        // Delete the orphaned entity rows (entity_fts update via trigger if present).
        await this.db
          .delete(entities)
          .where(and(eq(entities.tenantId, this.p.tenantId), inArray(entities.id, orphanedIds)))
      }
    }
  }

  /**
   * Upsert an entity by the deterministic key `(tenant_id, COALESCE(scope,''), kind,
   * lower(canonical_name))`. Aliases + source chunk ids are set-union'd; `visibility`/
   * `team_id` merge MAX-PERMISSIVE (an entity can only become more visible). Returns the id.
   */
  async upsertEntity(input: ExtractedEntityInput): Promise<string> {
    const existing = await this.db
      .select({
        id: entities.id,
        aliases: entities.aliases,
        sourceChunkIds: entities.sourceChunkIds,
        visibility: entities.visibility,
        teamId: entities.teamId,
      })
      .from(entities)
      .where(
        and(
          eq(entities.tenantId, this.p.tenantId),
          sql`COALESCE(${entities.scope}, '') = COALESCE(${input.scope ?? null}, '')`,
          eq(entities.kind, input.kind),
          sql`lower(${entities.canonicalName}) = lower(${input.name})`,
        ),
      )
      .limit(1)
    const head = existing[0]
    const stamp = now()
    if (!head) {
      const id = crypto.randomUUID()
      await this.db.insert(entities).values({
        id,
        tenantId: this.p.tenantId,
        scope: input.scope,
        kind: input.kind,
        canonicalName: input.name,
        aliases: JSON.stringify(dedupeCapped(input.aliases, 50)),
        description: input.description,
        sourceChunkIds: JSON.stringify(uniq(input.chunkIds)),
        mentionCount: input.chunkIds.length,
        visibility: input.visibility,
        teamId: input.teamId,
        createdAt: stamp,
        updatedAt: stamp,
      })
      return id
    }
    const aliases = dedupeCapped([...parseStringArray(head.aliases), ...input.aliases], 50)
    const merged = uniq([...parseStringArray(head.sourceChunkIds), ...input.chunkIds])
    const tier = mergeVisibility(
      { visibility: head.visibility, teamId: head.teamId },
      { visibility: input.visibility, teamId: input.teamId },
    )
    await this.db
      .update(entities)
      .set({
        aliases: JSON.stringify(aliases),
        sourceChunkIds: JSON.stringify(merged),
        mentionCount: sql`${entities.mentionCount} + ${input.chunkIds.length}`,
        visibility: tier.visibility,
        teamId: tier.teamId,
        updatedAt: stamp,
      })
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, head.id)))
    return head.id
  }

  // ── Phase 3.5 dedup helpers (called by upsertEntityWithVectorDedup in dedup.ts) ──

  /**
   * Deterministic key lookup (read-only): returns the existing entity row (id + merge
   * payload) if `(tenant, COALESCE(scope,''), kind, lower(name))` matches, null on miss.
   * Called FIRST in the Phase 3.5 pipeline before vector-nearest fallback.
   */
  /**
   * Follow the `merged_into` chain from `id` to the LIVE winner (D4 redirect). A Dream-dedup loser
   * keeps its row (D-i5 reversible) and its slot on the UNIQUE `idx_entities_key`, so callers that
   * key/vector-match onto it must land on the winner, not the tombstone. Bounded to `maxHops` (a
   * merge chain A→B→C is possible if C is later merged); returns the live id, or `null` if the id
   * is unknown/cross-tenant or the chain is broken/too deep (caller falls back to create). Tenant-
   * forced on every hop, so a cross-tenant id resolves to `null` — never a leak.
   */
  async resolveWinnerId(id: string, maxHops = 5): Promise<string | null> {
    let current = id
    for (let hop = 0; hop < maxHops; hop++) {
      const rows = await this.db
        .select({ mergedInto: entities.mergedInto })
        .from(entities)
        .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, current)))
        .limit(1)
      const row = rows[0]
      if (!row) return null // unknown / cross-tenant
      if (row.mergedInto === null) return current // live winner
      current = row.mergedInto
    }
    return null // chain too deep (or a cycle) → give up; caller creates
  }

  async findEntityByKey(
    name: string,
    kind: string,
    scope: string | null,
  ): Promise<{
    id: string
    aliases: string
    sourceChunkIds: string
    visibility: string
    teamId: string | null
  } | null> {
    // NOTE: no `merged_into IS NULL` filter here — a merged loser STILL holds the UNIQUE
    // `idx_entities_key` slot, so it must match (otherwise `createEntity` collides on the index).
    // We match the key, then REDIRECT a merged hit to its live winner (D4 anti-resurrection).
    const rows = await this.db
      .select({
        id: entities.id,
        mergedInto: entities.mergedInto,
        aliases: entities.aliases,
        sourceChunkIds: entities.sourceChunkIds,
        visibility: entities.visibility,
        teamId: entities.teamId,
      })
      .from(entities)
      .where(
        and(
          eq(entities.tenantId, this.p.tenantId),
          sql`COALESCE(${entities.scope}, '') = COALESCE(${scope ?? null}, '')`,
          eq(entities.kind, kind),
          sql`lower(${entities.canonicalName}) = lower(${name})`,
        ),
      )
      .limit(1)
    const hit = rows[0]
    if (!hit) return null
    if (hit.mergedInto === null) {
      const { mergedInto: _drop, ...live } = hit
      return live
    }
    // The keyed row is a Dream-dedup loser → resolve to the live winner and return ITS fields.
    const winnerId = await this.resolveWinnerId(hit.mergedInto)
    if (winnerId === null) return null // broken chain → caller creates (data-repair path)
    const wrows = await this.db
      .select({
        id: entities.id,
        aliases: entities.aliases,
        sourceChunkIds: entities.sourceChunkIds,
        visibility: entities.visibility,
        teamId: entities.teamId,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, winnerId)))
      .limit(1)
    return wrows[0] ?? null
  }

  /**
   * Merge an `ExtractedEntityInput` into an existing entity (by id): union `input.aliases`
   * with existing aliases, union chunk ids, increment mention_count, max-permissive
   * visibility. Does NOT add `input.name` as an alias — the caller adds the surface name
   * before calling when needed (vector-dedup path in `upsertEntityWithVectorDedup`).
   */
  async mergeEntityInto(targetId: string, input: ExtractedEntityInput): Promise<void> {
    const rows = await this.db
      .select({
        aliases: entities.aliases,
        sourceChunkIds: entities.sourceChunkIds,
        visibility: entities.visibility,
        teamId: entities.teamId,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, targetId)))
      .limit(1)
    const existing = rows[0]
    if (!existing) return
    const aliases = dedupeCapped([...parseStringArray(existing.aliases), ...input.aliases], 50)
    const chunks = uniq([...parseStringArray(existing.sourceChunkIds), ...input.chunkIds])
    const tier = mergeVisibility(
      { visibility: existing.visibility, teamId: existing.teamId },
      { visibility: input.visibility, teamId: input.teamId },
    )
    await this.db
      .update(entities)
      .set({
        aliases: JSON.stringify(aliases),
        sourceChunkIds: JSON.stringify(chunks),
        mentionCount: sql`${entities.mentionCount} + ${input.chunkIds.length}`,
        visibility: tier.visibility,
        teamId: tier.teamId,
        updatedAt: now(),
      })
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, targetId)))
  }

  /**
   * Insert a new entity row after BOTH deterministic-key AND vector-nearest checks miss.
   * Returns the new id. Does NOT query for existing rows — only call once both checks fail.
   */
  async createEntity(input: ExtractedEntityInput): Promise<string> {
    const id = crypto.randomUUID()
    const stamp = now()
    await this.db.insert(entities).values({
      id,
      tenantId: this.p.tenantId,
      scope: input.scope,
      kind: input.kind,
      canonicalName: input.name,
      aliases: JSON.stringify(dedupeCapped(input.aliases, 50)),
      description: input.description,
      sourceChunkIds: JSON.stringify(uniq(input.chunkIds)),
      mentionCount: input.chunkIds.length,
      visibility: input.visibility,
      teamId: input.teamId,
      createdAt: stamp,
      updatedAt: stamp,
    })
    return id
  }

  /** Relate two entities; on conflict union evidence + take MAX confidence (openbrains). */
  async relate(input: ExtractedRelationInput, fromId: string, toId: string): Promise<void> {
    const existing = await this.db
      .select({
        id: entityRelations.id,
        confidence: entityRelations.confidence,
        evidence: entityRelations.evidenceChunkIds,
      })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, this.p.tenantId),
          eq(entityRelations.fromEntityId, fromId),
          eq(entityRelations.toEntityId, toId),
          eq(entityRelations.kind, input.kind),
        ),
      )
      .limit(1)
    const head = existing[0]
    const stamp = now()
    if (!head) {
      await this.db.insert(entityRelations).values({
        id: crypto.randomUUID(),
        tenantId: this.p.tenantId,
        fromEntityId: fromId,
        toEntityId: toId,
        kind: input.kind,
        confidence: input.confidence,
        evidenceChunkIds: JSON.stringify(uniq(input.chunkIds)),
        createdAt: stamp,
        updatedAt: stamp,
      })
      return
    }
    const evidence = uniq([...parseStringArray(head.evidence), ...input.chunkIds])
    await this.db
      .update(entityRelations)
      .set({
        confidence: Math.max(head.confidence, input.confidence),
        evidenceChunkIds: JSON.stringify(evidence),
        updatedAt: stamp,
      })
      .where(and(eq(entityRelations.tenantId, this.p.tenantId), eq(entityRelations.id, head.id)))
  }

  /** Idempotent mention (no-op on the `idx_entity_mentions_uniq` conflict). */
  async mention(entityId: string, sourceKind: string, sourceId: string): Promise<void> {
    await this.db
      .insert(entityMentions)
      .values({
        id: crypto.randomUUID(),
        tenantId: this.p.tenantId,
        entityId,
        sourceKind,
        sourceId,
        createdAt: now(),
      })
      .onConflictDoNothing({
        target: [
          entityMentions.tenantId,
          entityMentions.entityId,
          entityMentions.sourceKind,
          entityMentions.sourceId,
        ],
      })
  }

  /** Stamp an entity's vector staleness columns after a `brain-entities` upsert. */
  async markEntityEmbedded(entityId: string, embeddedAt: string): Promise<void> {
    await this.db
      .update(entities)
      .set({ embeddedAt, embeddingModel: EMBEDDING_MODEL, embeddingDims: EMBEDDING_DIMS })
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, entityId)))
  }

  // ── DREAM DEDUP (v2 W1/D4) ────────────────────────────────────────────────────

  /**
   * ONE page of the active (non-merged) entity set for the dedup sweep, in deterministic id order
   * (the FSM's cursor unit). `cursor` pages by `id > cursor` so a resume never re-reads the head and
   * a big tenant is never truncated at a fixed tail (the FSM loops pages until one returns < limit).
   * Tenant + scope + `{world,team}` visibility gated; merged losers excluded. `embeddedAt`/`updatedAt`
   * let the sweep skip re-embedding entities whose stored vector is still current.
   */
  async listActiveEntitiesForDedup(cursor: string | null, limit = 500): Promise<DedupEntity[]> {
    return this.db
      .select({
        id: entities.id,
        name: entities.canonicalName,
        description: entities.description,
        kind: entities.kind,
        scope: entities.scope,
        mentionCount: entities.mentionCount,
        createdAt: entities.createdAt,
        embeddedAt: entities.embeddedAt,
        updatedAt: entities.updatedAt,
      })
      .from(entities)
      .where(
        and(
          eq(entities.tenantId, this.p.tenantId),
          liveEntityPredicate(entities.mergedInto),
          cursor === null ? undefined : sql`${entities.id} > ${cursor}`,
          scopePredicate(this.p, entities.scope),
          entityVisibility(this.p, { visibility: entities.visibility, teamId: entities.teamId }),
        ),
      )
      .orderBy(entities.id)
      .limit(limit)
  }

  /**
   * Ids of Dream-dedup losers (soft-deleted, `merged_into` set) — for the sweep-start vector
   * reconciliation (D4 item 6): their stale vectors are batch-deleted so a failed best-effort
   * per-merge delete self-heals. Bounded; tenant-forced.
   */
  async listMergedLoserIds(limit = 1000): Promise<string[]> {
    const rows = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.tenantId, this.p.tenantId), isNotNull(entities.mergedInto)))
      .limit(limit)
    return rows.map((r) => r.id)
  }

  /** One entity's dedup-relevant fields (winner selection + the staleness/merged guard). */
  async getEntityForMerge(
    id: string,
  ): Promise<(DedupEntity & { mergedInto: string | null }) | null> {
    const rows = await this.db
      .select({
        id: entities.id,
        name: entities.canonicalName,
        description: entities.description,
        kind: entities.kind,
        scope: entities.scope,
        mentionCount: entities.mentionCount,
        createdAt: entities.createdAt,
        embeddedAt: entities.embeddedAt,
        updatedAt: entities.updatedAt,
        mergedInto: entities.mergedInto,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, this.p.tenantId), eq(entities.id, id)))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Merge `loserId` INTO `winnerId` (v2 W1/D4) in ONE audited `db.batch` (D-i4). Order matters:
   *   1. DELETE loser relations that would COLLIDE after re-pointing — a self-loop (both endpoints
   *      become the winner) or a duplicate of an existing `(from,to,kind)` winner relation. A bulk
   *      `UPDATE ... SET from=winner` would otherwise throw on the `(tenant,from,to,kind)` unique
   *      index; deleting the colliders first lets the survivors re-point cleanly.
   *   2-3. Re-point surviving relations (from/to loser → winner).
   *   4. DELETE loser mentions that duplicate a winner mention `(source_kind,source_id)`.
   *   5. Re-point surviving mentions loser → winner.
   *   6. Soft-delete the loser (`merged_into = winner`) — the row survives (D-i5, reversible).
   *   7. Fold the loser's canonical_name + aliases + source_chunk_ids into the winner AND recompute
   *      `winner.mention_count = COUNT(*)` of its mentions (post-repoint; the subquery sees step-5's
   *      writes since batch statements run in order) — dropped dups never inflate it. Folding keeps
   *      the loser's surface form queryable on the winner (FTS/name), stopping re-extract churn.
   *   8. `memory_audit` row (same batch — D-i4) whose diff is RICH enough to reverse the merge (D-i5):
   *      deleted collider rows in full, re-pointed mention/relation ids, prior winner counters/aliases.
   * Tenant-forced on every statement. Never hard-deletes an entity.
   */
  async mergeEntities(winnerId: string, loserId: string): Promise<void> {
    if (this.p.readOnly) throw new Error("dedup merge denied: read-only principal")
    const t = this.p.tenantId
    const stamp = now()

    // Re-pointed endpoint of the aliased row `r` (loser → winner), parameterized (no injection).
    const repointExpr = (col: "from_entity_id" | "to_entity_id"): SQL =>
      sql`(CASE WHEN r.${sql.raw(col)} = ${loserId} THEN ${winnerId} ELSE r.${sql.raw(col)} END)`

    // ── PRE-READS (item 2 alias folding + item 3 reversible audit diff) ──────────
    // Read BEFORE the batch so the audit captures pre-merge state and we can fold the loser's
    // name/aliases/chunks into the winner (keeps FTS/name search alive for the folded surface
    // form, stopping the "merge → re-extract → duplicate" churn loop).
    const [winnerRow] = await this.db
      .select({
        aliases: entities.aliases,
        sourceChunkIds: entities.sourceChunkIds,
        mentionCount: entities.mentionCount,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, t), eq(entities.id, winnerId)))
      .limit(1)
    const [loserRow] = await this.db
      .select({
        canonicalName: entities.canonicalName,
        aliases: entities.aliases,
        sourceChunkIds: entities.sourceChunkIds,
      })
      .from(entities)
      .where(and(eq(entities.tenantId, t), eq(entities.id, loserId)))
      .limit(1)
    if (!(winnerRow && loserRow)) {
      throw new Error(`mergeEntities: winner ${winnerId} or loser ${loserId} not found`)
    }
    const foldedAliases = dedupeCapped(
      [
        ...parseStringArray(winnerRow.aliases),
        loserRow.canonicalName,
        ...parseStringArray(loserRow.aliases),
      ],
      50,
    )
    const foldedChunks = uniq([
      ...parseStringArray(winnerRow.sourceChunkIds),
      ...parseStringArray(loserRow.sourceChunkIds),
    ])

    // The colliders the batch will DELETE (full rows for the audit) — mirrors the delete predicates.
    const collidingRelations = await this.db.all<{
      id: string
      fromEntityId: string
      toEntityId: string
      kind: string
      confidence: number
      evidenceChunkIds: string
    }>(sql`
      SELECT r.id AS id, r.from_entity_id AS fromEntityId, r.to_entity_id AS toEntityId,
             r.kind AS kind, r.confidence AS confidence, r.evidence_chunk_ids AS evidenceChunkIds
      FROM entity_relations r
      WHERE r.tenant_id = ${t}
        AND (r.from_entity_id = ${loserId} OR r.to_entity_id = ${loserId})
        AND (
          ${repointExpr("from_entity_id")} = ${repointExpr("to_entity_id")}
          OR EXISTS (
            SELECT 1 FROM entity_relations w
            WHERE w.tenant_id = ${t} AND w.id <> r.id AND w.kind = r.kind
              AND w.from_entity_id = ${repointExpr("from_entity_id")}
              AND w.to_entity_id = ${repointExpr("to_entity_id")}
          )
        )`)
    const collidingMentions = await this.db.all<{
      id: string
      sourceKind: string
      sourceId: string
    }>(sql`
      SELECT m.id AS id, m.source_kind AS sourceKind, m.source_id AS sourceId
      FROM entity_mentions m
      WHERE m.tenant_id = ${t} AND m.entity_id = ${loserId}
        AND EXISTS (
          SELECT 1 FROM entity_mentions w
          WHERE w.tenant_id = ${t} AND w.entity_id = ${winnerId}
            AND w.source_kind = m.source_kind AND w.source_id = m.source_id
        )`)
    // The surviving loser rows the batch will RE-POINT = loser-touching rows minus the colliders.
    const collidingRelIds = new Set(collidingRelations.map((r) => r.id))
    const collidingMentionIds = new Set(collidingMentions.map((m) => m.id))
    const loserRelRows = await this.db.all<{ id: string }>(sql`
      SELECT id FROM entity_relations
      WHERE tenant_id = ${t} AND (from_entity_id = ${loserId} OR to_entity_id = ${loserId})`)
    const loserMentionRows = await this.db.all<{ id: string }>(sql`
      SELECT id FROM entity_mentions WHERE tenant_id = ${t} AND entity_id = ${loserId}`)
    const repointedRelationIds = loserRelRows
      .map((r) => r.id)
      .filter((id) => !collidingRelIds.has(id))
    const repointedMentionIds = loserMentionRows
      .map((m) => m.id)
      .filter((id) => !collidingMentionIds.has(id))

    const deleteCollidingRelations = this.db.delete(entityRelations).where(sql`
      ${entityRelations.tenantId} = ${t} AND ${entityRelations.id} IN (
        SELECT r.id FROM entity_relations r
        WHERE r.tenant_id = ${t}
          AND (r.from_entity_id = ${loserId} OR r.to_entity_id = ${loserId})
          AND (
            ${repointExpr("from_entity_id")} = ${repointExpr("to_entity_id")}
            OR EXISTS (
              SELECT 1 FROM entity_relations w
              WHERE w.tenant_id = ${t} AND w.id <> r.id AND w.kind = r.kind
                AND w.from_entity_id = ${repointExpr("from_entity_id")}
                AND w.to_entity_id = ${repointExpr("to_entity_id")}
            )
          )
      )`)

    const repointRelFrom = this.db
      .update(entityRelations)
      .set({ fromEntityId: winnerId, updatedAt: stamp })
      .where(and(eq(entityRelations.tenantId, t), eq(entityRelations.fromEntityId, loserId)))
    const repointRelTo = this.db
      .update(entityRelations)
      .set({ toEntityId: winnerId, updatedAt: stamp })
      .where(and(eq(entityRelations.tenantId, t), eq(entityRelations.toEntityId, loserId)))

    const deleteCollidingMentions = this.db.delete(entityMentions).where(sql`
      ${entityMentions.tenantId} = ${t} AND ${entityMentions.entityId} = ${loserId}
      AND EXISTS (
        SELECT 1 FROM entity_mentions w
        WHERE w.tenant_id = ${t} AND w.entity_id = ${winnerId}
          AND w.source_kind = ${entityMentions.sourceKind} AND w.source_id = ${entityMentions.sourceId}
      )`)
    const repointMentions = this.db
      .update(entityMentions)
      .set({ entityId: winnerId })
      .where(and(eq(entityMentions.tenantId, t), eq(entityMentions.entityId, loserId)))

    const softDeleteLoser = this.db
      .update(entities)
      .set({ mergedInto: winnerId, updatedAt: stamp })
      .where(and(eq(entities.tenantId, t), eq(entities.id, loserId)))
    // Fold the loser's name+aliases+chunks into the winner AND recompute mention_count in one
    // update (the COUNT subquery sees the re-point above, since batch statements run in order).
    const recountWinner = this.db
      .update(entities)
      .set({
        aliases: JSON.stringify(foldedAliases),
        sourceChunkIds: JSON.stringify(foldedChunks),
        mentionCount: sql`(SELECT COUNT(*) FROM entity_mentions m WHERE m.tenant_id = ${t} AND m.entity_id = ${winnerId})`,
        updatedAt: stamp,
      })
      .where(and(eq(entities.tenantId, t), eq(entities.id, winnerId)))

    // D-i5 reversible: the diff records EVERYTHING the merge destroyed or moved — the deleted
    // collider rows in full, the ids re-pointed, and the winner's prior mention_count + aliases.
    // Committed atomically with a FORCED audit row through the shared seam (invariants 10, 11).
    const statements: BatchStatement[] = [
      deleteCollidingRelations,
      repointRelFrom,
      repointRelTo,
      deleteCollidingMentions,
      repointMentions,
      softDeleteLoser,
      recountWinner,
    ]
    await batchWithAudit(this.db, this.p, statements, {
      action: "dream.dedup.merge",
      targetId: winnerId,
      diff: JSON.stringify({
        winnerId,
        loserId,
        loserCanonicalName: loserRow.canonicalName,
        priorWinnerMentionCount: winnerRow.mentionCount,
        priorWinnerAliases: parseStringArray(winnerRow.aliases),
        deletedRelations: collidingRelations,
        deletedMentions: collidingMentions,
        repointedRelationIds,
        repointedMentionIds,
      }),
    })
  }
}

/** One entity's fields for the Dream dedup sweep (v2 W1/D4). */
export interface DedupEntity {
  id: string
  name: string
  description: string
  kind: string
  scope: string | null
  mentionCount: number
  createdAt: string
  /** Vector-staleness inputs: re-embed only when `embeddedAt` is null or `updatedAt > embeddedAt`. */
  embeddedAt: string | null
  updatedAt: string
}

/** Parse a JSON `string[]` column, tolerating malformed/empty values. */
const parseStringArray = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : []
  } catch {
    return []
  }
}

/**
 * Max-permissive visibility merge for the KG node space (`{world, team}` only, §6.0). `world`
 * always wins; same team keeps `team`; cross-team promotes to `world` (no single owning team).
 */
export const mergeVisibility = (
  a: { visibility: string; teamId: string | null },
  b: { visibility: string; teamId: string | null },
): { visibility: string; teamId: string | null } => {
  if (a.visibility === "world" || b.visibility === "world")
    return { visibility: "world", teamId: null }
  return a.teamId === b.teamId
    ? { visibility: "team", teamId: a.teamId }
    : { visibility: "world", teamId: null }
}

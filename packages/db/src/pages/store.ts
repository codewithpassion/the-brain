/**
 * `PageStore` — the shared page-CRUD core on the docgraph `pages` layer (v3/W1). The mechanical
 * heart that BOTH agent memory (`MemoryStore`) and the wiki (`WikiStore`) drive: the versioned
 * upsert (insert/update `pages` + append `page_revisions`), the `[[slug]]`/markdown link
 * reconcile (→ `doc_links`, with red-link `pending_links` for unresolved targets + retroactive
 * resolution), the frontmatter-`tags` reconcile, the content-hash skip-unchanged gate, and the
 * soft-delete — all under the SAME isolation + in-batch audit discipline as the frozen chokepoints:
 *   - `tenant_id = p.tenantId` is FORCED on every write, NEVER read from the caller (invariant 1);
 *   - visibility-bearing reads AND the SHARED `scopePredicate` + `visibilityPredicate` (invariant 8);
 *   - every mutation batches its `memory_audit` row in the SAME `db.batch` (invariants 10, 11).
 *
 * `PageStore` is pure MECHANISM: PROVENANCE (`ingested_via`), the audit action name, the read-only
 * deny message, and AUTHORIZATION are all parameters. Memory keeps its exact contract by supplying
 * `ingested_via='memory'`, `page.*` audit actions, and an ownership-gated `authorize`; wiki supplies
 * `ingested_via='wiki'`, `wiki.*` actions, and a visibility/scope-gated `authorize`.
 */
import type { Principal } from "@brain/shared"
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import { type BatchStatement, commitBatch } from "../batch"
import { docLinks, memoryAudit, pageRevisions, pages, pendingLinks, tags } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { scopePredicate, visibilityPredicate } from "../scoped/predicates"

export type { BatchStatement } from "../batch"

/** The safe default tier for a NEW page whose caller does not specify visibility (matches memory). */
const DEFAULT_VISIBILITY = "private"

const pageVisibilityCols = {
  visibility: pages.visibility,
  teamId: pages.teamId,
  userId: pages.userId,
} as const

/** Cheap, deterministic, synchronous content hash for the skip-unchanged gate (djb2). */
export const contentHash = (...parts: string[]): string => {
  const s = parts.join(" ")
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

const uniq = <T>(values: T[]): T[] => [...new Set(values)]

/** Parse a JSON frontmatter column, tolerating malformed/empty values. */
export const parseFrontmatter = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Normalize an OKF link target to a candidate concept slug, or null when it is external.
 * OKF links look like `[customers](/tables/customers.md)`; wikilinks like `[[tables/customers]]`.
 */
export const normalizeLinkTarget = (raw: string): string | null => {
  const target = raw.trim().split("|")[0]?.split("#")[0]?.trim() ?? ""
  if (target.length === 0) return null
  if (/^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) return null // external
  return target
    .replace(/^\.?\//, "") // leading ./ or /
    .replace(/\.md$/i, "")
    .trim()
}

/**
 * Blank out fenced code blocks (``` / ~~~) and inline code (`…`) so a `[[x]]` or `[t](x)` that a
 * page author wrote INSIDE code is not turned into a real `doc_links` edge (W4a fix round). Replaces
 * with spaces to preserve offsets and avoid accidentally joining adjacent text into a false match.
 */
const stripCode = (body: string): string =>
  body
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))

/**
 * Extract candidate concept slugs from a markdown body (`[[slug]]` + `[txt](target)`). Links inside
 * code are ignored (`stripCode`), and IMAGE targets (`![alt](x.png)`) are excluded via the `(?<!!)`
 * guard — neither should become a graph edge.
 */
const extractLinkSlugs = (body: string): string[] => {
  const text = stripCode(body)
  const slugs: string[] = []
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const s = normalizeLinkTarget(m[1] ?? "")
    if (s) slugs.push(s)
  }
  for (const m of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const s = normalizeLinkTarget(m[1] ?? "")
    if (s) slugs.push(s)
  }
  return uniq(slugs)
}

/** A page row as found by slug (no deleted filter — the unique slug index spans soft-deleted rows). */
export interface ExistingPageRow {
  id: string
  userId: string | null
  teamId: string | null
  scope: string | null
  visibility: string
  ingestedVia: string | null
  contentHash: string | null
  deletedAt: string | null
  type: string
  title: string
  body: string
  frontmatter: string
}

/** A page's full live row (the wiki read surface). */
export interface PageRow {
  id: string
  slug: string
  type: string
  title: string
  visibility: string
  scope: string | null
  ingestedVia: string | null
  entityId: string | null
  frontmatter: string
  body: string
  createdAt: string
  updatedAt: string
}

/** One entry in a page's revision-history summary. */
export interface PageRevisionSummary {
  revisionId: number
  version: number
  reason: string | null
  authorUserId: string | null
  createdAt: string
}

/** A revision summary PLUS its full body snapshot (for the history/diff view). */
export interface PageRevisionFull extends PageRevisionSummary {
  body: string
}

/** `PageStore.upsert` input — provenance, audit, and authorization are all supplied by the caller. */
export interface PageUpsertInput {
  slug: string
  type: string
  title: string
  /**
   * Desired visibility, or `undefined` to PRESERVE the existing row's tier on update (and default to
   * the SAFE `private` tier on insert). Omitting it must never silently escalate a page's visibility.
   */
  visibility?: string
  /** COMPLETE OKF frontmatter object (for tag reconcile). */
  frontmatter: Record<string, unknown>
  /** Serialized frontmatter (what lands in the column — caller controls its exact bytes). */
  frontmatterJson: string
  body: string
  /**
   * The frontmatter bytes to fold into the content hash (callers differ — memory drops the volatile
   * `timestamp`; wiki hashes the whole thing). The store hashes `(type,title,effectiveVisibility,
   * hashFrontmatter,body)` so the hash always reflects the visibility actually written.
   */
  hashFrontmatter: string
  scope?: string | null
  teamId?: string | null
  /**
   * When true (wiki), unresolved links are recorded as `pending_links` (red links) and inbound
   * pending rows resolve retroactively. When false (memory), unresolved links are dropped and no
   * retroactive materialization happens — preserving the memory lane's exact resolved-only contract.
   */
  recordPending: boolean
  /**
   * When true (wiki), a team-tier change on UPDATE writes `team_id` (else the page would be an
   * invisible team page). When false (memory), `team_id` is IMMUTABLE after create — the update omits
   * it, preserving memory's exact pre-v3 behavior. `scope` is ALWAYS immutable on update (both lanes).
   */
  writeTeamIdOnUpdate: boolean
  /** The entity this page IS about (W2 entity pages) — written on INSERT only; immutable after. */
  entityId?: string | null
  /** Provenance: `'memory'` | `'wiki'` | … — forced onto `ingested_via` + `source_kind`. */
  ingestedVia: string
  sourceKind: string
  /** `doc_links.link_source` for this page's in-body edges (`'okf'` for memory, `'wiki'` for wiki). */
  linkSource: string
  /** `memory_audit.action`, e.g. `'page.set'` | `'wiki.save'`. */
  auditAction: string
  /** `page_revisions.reason`, e.g. `'set'`. */
  reason: string
  /** Thrown message when the principal is read-only. */
  readOnlyDenyMessage: string
  /**
   * Authorization hook run AFTER the existing-row lookup, BEFORE any write (pure — no side effects
   * between the read and the throw, so its position relative to the lookup is behavior-invariant).
   * Memory passes ownership + provenance checks; wiki passes visibility/scope + provenance checks.
   */
  authorize: (existing: ExistingPageRow | undefined) => void
}

export interface PageUpsertResult {
  slug: string
  pageId: string
  version: number
  /** False when `content_hash` matched (a no-op — no new revision written). */
  changed: boolean
}

export class PageStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
  }

  // ── shared seams (mirror the frozen chokepoints) ───────────────────────────────────

  async commitBatch(statements: BatchStatement[]): Promise<void> {
    await commitBatch(this.db, statements)
  }

  /** Scope-grant gate (shared by memory + wiki): a write must target a scope the principal holds. */
  assertScopeAllowed(scope: string): void {
    if (this.p.allowedScopes === "*") return
    if (!this.p.allowedScopes.includes(scope)) {
      throw new Error(`scope '${scope}' not in this principal's allowedScopes`)
    }
  }

  auditStatement(action: string, targetId: string | null, diff?: string): BatchStatement {
    return this.db.insert(memoryAudit).values({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced
      userId: this.p.userId, // forced actor
      action,
      targetId,
      at: Date.now(),
      ...(diff !== undefined ? { diff } : {}),
    })
  }

  async maxVersion(pageId: string): Promise<number> {
    const rows = await this.db
      .select({ m: sql<number>`COALESCE(MAX(${pageRevisions.version}), 0)` })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.tenantId, this.p.tenantId), eq(pageRevisions.pageId, pageId)))
    return rows[0]?.m ?? 0
  }

  /** Look up a page by (tenant, slug) WITHOUT the deleted filter (the slug index spans soft-deletes). */
  async findBySlug(slug: string): Promise<ExistingPageRow | undefined> {
    const rows = await this.db
      .select({
        id: pages.id,
        userId: pages.userId,
        teamId: pages.teamId,
        scope: pages.scope,
        visibility: pages.visibility,
        ingestedVia: pages.ingestedVia,
        contentHash: pages.contentHash,
        deletedAt: pages.deletedAt,
        type: pages.type,
        title: pages.title,
        body: pages.compiledTruth,
        frontmatter: pages.frontmatter,
      })
      .from(pages)
      .where(and(eq(pages.tenantId, this.p.tenantId), eq(pages.slug, slug)))
      .limit(1)
    return rows[0]
  }

  // ── tag / link reconcile (the shared §6.5 surface) ─────────────────────────────────

  /** Reconcile frontmatter `tags` → the `tags` table (delete-all then re-insert the de-duped set). */
  tagStatements(pageId: string, fm: Record<string, unknown>): BatchStatement[] {
    const stmts: BatchStatement[] = [
      this.db.delete(tags).where(and(eq(tags.tenantId, this.p.tenantId), eq(tags.pageId, pageId))),
    ]
    const raw = Array.isArray(fm.tags) ? fm.tags : []
    const list = uniq(raw.filter((t): t is string => typeof t === "string" && t.length > 0))
    for (const tag of list) {
      stmts.push(this.db.insert(tags).values({ tenantId: this.p.tenantId, pageId, tag }))
    }
    return stmts
  }

  /**
   * Reconcile a page's in-body concept links. Deletes this page's prior `doc_links` (for the given
   * `linkSource`) + its `pending_links`, then for each extracted slug: resolve to an EXISTING visible
   * page → a real `doc_links` edge; otherwise record a `pending_links` (red) row so it resolves when
   * the target is later created. A self-link is dropped from both arms (no self-edge, no self-pending).
   */
  async reconcileLinkStatements(
    pageId: string,
    ownSlug: string,
    body: string,
    linkSource: string,
    recordPending: boolean,
  ): Promise<BatchStatement[]> {
    const stmts: BatchStatement[] = [
      this.db
        .delete(docLinks)
        .where(
          and(
            eq(docLinks.tenantId, this.p.tenantId),
            eq(docLinks.fromId, pageId),
            eq(docLinks.linkSource, linkSource),
          ),
        ),
    ]
    // Only the pending-lane (wiki) touches pending_links; the memory lane never creates them.
    if (recordPending) {
      stmts.push(
        this.db
          .delete(pendingLinks)
          .where(
            and(eq(pendingLinks.tenantId, this.p.tenantId), eq(pendingLinks.fromPageId, pageId)),
          ),
      )
    }
    const slugs = extractLinkSlugs(body)
    if (slugs.length === 0) return stmts
    const targets = await this.db
      .select({ id: pages.id, slug: pages.slug })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          inArray(pages.slug, slugs),
          isNull(pages.deletedAt),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, pageVisibilityCols),
        ),
      )
    const resolved = new Set<string>()
    for (const target of targets) {
      resolved.add(target.slug)
      if (target.id === pageId) continue // no self-loops
      stmts.push(
        this.db.insert(docLinks).values({
          id: crypto.randomUUID(),
          tenantId: this.p.tenantId,
          fromId: pageId,
          toId: target.id,
          linkType: "",
          linkSource,
          originId: pageId,
        }),
      )
    }
    if (recordPending) {
      for (const slug of slugs) {
        if (resolved.has(slug) || slug === ownSlug) continue // resolved above / self
        stmts.push(
          this.db
            .insert(pendingLinks)
            .values({
              id: crypto.randomUUID(),
              tenantId: this.p.tenantId,
              fromPageId: pageId,
              targetSlug: slug,
              linkSource,
            })
            .onConflictDoNothing(),
        )
      }
    }
    return stmts
  }

  /**
   * Retroactive red-link resolution, VISIBILITY-SCOPED. A `pending_links` row whose `target_slug`
   * equals this page's slug becomes a real `doc_links` edge into this page — but ONLY when the new
   * target is visible to the source page's author (world → any source; team → sources on the same
   * team; private → only the author's own source pages). This prevents an existence oracle: creating
   * a private/team page must not silently consume another user's pending link. `tenant_id` is forced
   * on the join, lookup, inserts, AND delete, so a cross-tenant pending row can never form an edge.
   * Only the pending rows actually resolved are deleted; the rest stay red.
   */
  async resolveInboundPendingStatements(
    pageId: string,
    slug: string,
    visibility: string,
    ownerUserId: string,
    teamId: string | null,
  ): Promise<BatchStatement[]> {
    // "This target is visible to the source page F" — the same 3-tier gate the reads use, expressed
    // against the JOINed source page. Wiki targets carry no scope, so scope is not gated here.
    const sourceMaySee: SQL | undefined =
      visibility === "world"
        ? undefined
        : visibility === "team"
          ? teamId !== null
            ? eq(pages.teamId, teamId)
            : sql`1 = 0`
          : eq(pages.userId, ownerUserId) // private
    const pend = await this.db
      .select({ fromPageId: pendingLinks.fromPageId, linkSource: pendingLinks.linkSource })
      .from(pendingLinks)
      .innerJoin(
        pages,
        and(eq(pages.id, pendingLinks.fromPageId), eq(pages.tenantId, pendingLinks.tenantId)),
      )
      .where(
        and(
          eq(pendingLinks.tenantId, this.p.tenantId),
          eq(pendingLinks.targetSlug, slug),
          sourceMaySee,
        ),
      )
    if (pend.length === 0) return []
    const stmts: BatchStatement[] = []
    const resolvedFroms: string[] = []
    for (const row of pend) {
      if (row.fromPageId === pageId) continue // no self-loop
      resolvedFroms.push(row.fromPageId)
      stmts.push(
        this.db
          .insert(docLinks)
          .values({
            id: crypto.randomUUID(),
            tenantId: this.p.tenantId,
            fromId: row.fromPageId,
            toId: pageId,
            linkType: "",
            linkSource: row.linkSource,
            originId: row.fromPageId,
          })
          .onConflictDoNothing(),
      )
    }
    if (resolvedFroms.length > 0) {
      stmts.push(
        this.db
          .delete(pendingLinks)
          .where(
            and(
              eq(pendingLinks.tenantId, this.p.tenantId),
              eq(pendingLinks.targetSlug, slug),
              inArray(pendingLinks.fromPageId, resolvedFroms),
            ),
          ),
      )
    }
    return stmts
  }

  // ── the versioned upsert (create/update in one audited batch) ──────────────────────

  async upsert(input: PageUpsertInput): Promise<PageUpsertResult> {
    if (this.p.readOnly) throw new Error(input.readOnlyDenyMessage)
    const now = new Date().toISOString()
    const existing = await this.findBySlug(input.slug)
    input.authorize(existing)

    // Effective tier: an OMITTED visibility PRESERVES the existing row (or the safe `private` default
    // on a fresh page) — it must never silently escalate. scope/teamId likewise preserve on update.
    const effVisibility = input.visibility ?? existing?.visibility ?? DEFAULT_VISIBILITY
    const effScope = input.scope ?? existing?.scope ?? null
    const effTeamId = input.teamId ?? existing?.teamId ?? null
    // Hash includes the visibility ACTUALLY written, so skip-unchanged stays honest under preserve.
    const hash = contentHash(
      input.type,
      input.title,
      effVisibility,
      input.hashFrontmatter,
      input.body,
    )

    if (existing) {
      const current = await this.maxVersion(existing.id)
      // Skip-unchanged only for a LIVE page; a soft-deleted match must be resurrected.
      if (existing.deletedAt === null && existing.contentHash === hash) {
        return { slug: input.slug, pageId: existing.id, version: current, changed: false }
      }
      const version = current + 1
      const statements: BatchStatement[] = [
        this.db.insert(pageRevisions).values({
          tenantId: this.p.tenantId,
          pageId: existing.id,
          version,
          slug: input.slug,
          type: input.type,
          title: input.title,
          compiledTruth: input.body,
          frontmatter: input.frontmatterJson,
          visibility: effVisibility,
          authorUserId: this.p.userId,
          reason: input.reason,
          createdAt: now,
        }),
        this.db
          .update(pages)
          .set({
            type: input.type,
            title: input.title,
            visibility: effVisibility,
            // `scope` is OMITTED → immutable after create (both lanes; preserves memory byte-identity).
            // `team_id` is written only for the pending-lane (wiki) so a team-tier change is visible;
            // the memory lane omits it (team_id immutable after create, as before v3).
            ...(input.writeTeamIdOnUpdate ? { teamId: effTeamId } : {}),
            compiledTruth: input.body,
            frontmatter: input.frontmatterJson,
            contentHash: hash,
            deletedAt: null, // resurrect if this slug was previously forgotten
            updatedAt: now,
          })
          .where(and(eq(pages.id, existing.id), eq(pages.tenantId, this.p.tenantId))),
        ...this.tagStatements(existing.id, input.frontmatter),
        ...(await this.reconcileLinkStatements(
          existing.id,
          input.slug,
          input.body,
          input.linkSource,
          input.recordPending,
        )),
        ...(input.recordPending
          ? await this.resolveInboundPendingStatements(
              existing.id,
              input.slug,
              effVisibility,
              this.p.userId,
              effTeamId,
            )
          : []),
        this.auditStatement(input.auditAction, input.slug, JSON.stringify({ version })),
      ]
      await this.commitBatch(statements)
      return { slug: input.slug, pageId: existing.id, version, changed: true }
    }

    const pageId = crypto.randomUUID()
    const statements: BatchStatement[] = [
      this.db.insert(pages).values({
        id: pageId,
        tenantId: this.p.tenantId, // forced
        userId: this.p.userId, // authorship forced
        teamId: effTeamId,
        scope: effScope,
        slug: input.slug,
        type: input.type,
        title: input.title,
        visibility: effVisibility,
        compiledTruth: input.body,
        frontmatter: input.frontmatterJson,
        contentHash: hash,
        sourceKind: input.sourceKind,
        ingestedVia: input.ingestedVia,
        entityId: input.entityId ?? null,
        ingestedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      this.db.insert(pageRevisions).values({
        tenantId: this.p.tenantId,
        pageId,
        version: 1,
        slug: input.slug,
        type: input.type,
        title: input.title,
        compiledTruth: input.body,
        frontmatter: input.frontmatterJson,
        visibility: effVisibility,
        authorUserId: this.p.userId,
        reason: input.reason,
        createdAt: now,
      }),
      ...this.tagStatements(pageId, input.frontmatter),
      ...(await this.reconcileLinkStatements(
        pageId,
        input.slug,
        input.body,
        input.linkSource,
        input.recordPending,
      )),
      ...(input.recordPending
        ? await this.resolveInboundPendingStatements(
            pageId,
            input.slug,
            effVisibility,
            this.p.userId,
            effTeamId,
          )
        : []),
      this.auditStatement(input.auditAction, input.slug, JSON.stringify({ version: 1 })),
    ]
    await this.commitBatch(statements)
    return { slug: input.slug, pageId, version: 1, changed: true }
  }

  // ── reads used by the wiki surface (each visibility-gated by the caller's resolution) ──

  /** Load a page's full row by id (no gate — the caller resolves through the visibility gate first). */
  async getPageRow(pageId: string): Promise<PageRow | null> {
    const rows = await this.db
      .select({
        id: pages.id,
        slug: pages.slug,
        type: pages.type,
        title: pages.title,
        visibility: pages.visibility,
        scope: pages.scope,
        ingestedVia: pages.ingestedVia,
        entityId: pages.entityId,
        frontmatter: pages.frontmatter,
        body: pages.compiledTruth,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .where(and(eq(pages.tenantId, this.p.tenantId), eq(pages.id, pageId)))
      .limit(1)
    return rows[0] ?? null
  }

  /** A page's revision-history summary, newest-first (`id DESC`). */
  async getRevisionsSummary(pageId: string): Promise<PageRevisionSummary[]> {
    return this.db
      .select({
        revisionId: pageRevisions.id,
        version: pageRevisions.version,
        reason: pageRevisions.reason,
        authorUserId: pageRevisions.authorUserId,
        createdAt: pageRevisions.createdAt,
      })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.tenantId, this.p.tenantId), eq(pageRevisions.pageId, pageId)))
      .orderBy(desc(pageRevisions.id))
  }

  /** A page's revision history WITH body snapshots, newest-first (`id DESC`), for the diff view. */
  async getRevisionsWithBodies(pageId: string, limit = 50): Promise<PageRevisionFull[]> {
    return this.db
      .select({
        revisionId: pageRevisions.id,
        version: pageRevisions.version,
        reason: pageRevisions.reason,
        authorUserId: pageRevisions.authorUserId,
        createdAt: pageRevisions.createdAt,
        body: pageRevisions.compiledTruth,
      })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.tenantId, this.p.tenantId), eq(pageRevisions.pageId, pageId)))
      .orderBy(desc(pageRevisions.id))
      .limit(limit)
  }

  /** The still-unresolved (red) outbound link target slugs for a page. */
  async getPendingOutbound(pageId: string): Promise<string[]> {
    const rows = await this.db
      .select({ targetSlug: pendingLinks.targetSlug })
      .from(pendingLinks)
      .where(and(eq(pendingLinks.tenantId, this.p.tenantId), eq(pendingLinks.fromPageId, pageId)))
    return rows.map((r) => r.targetSlug)
  }
}

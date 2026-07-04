/**
 * `IndexPageStore` (v3/W5) — auto-maintained OKF INDEX pages: a `pages` row per namespace
 * (`<ns>/index`) plus a root `index`, `type='index'`, `ingested_via='index'`, written by the DREAM as
 * the SYSTEM principal at `visibility='world'`. Navigation, NOT knowledge: index pages get NO backing
 * document (the caller simply never runs `syncBackingDoc`), and they are excluded from reflection
 * (`AGENT_PAGE_PROVENANCE` includes `'index'`).
 *
 * LEAK MODEL (critical, leak-safe BY CONSTRUCTION): the child set is read through the SAME
 * `visibilityPredicate` every gated read uses. The system principal has `userId='system'` and no
 * teams, so that predicate yields the WORLD set only (no code creates a `private`+`system` page) —
 * a world index therefore lists ONLY world children, reusing exactly the predicate the backlinks
 * no-leak canary already proves. No bespoke tier-filtering.
 *
 * DEFERRAL (v1): stored indexes cover WORLD pages only. Team/private children and a per-owner
 * complete index are deferred — an owner still navigates their private pages via the live per-viewer
 * sidebar + `wiki_list_pages`. The deterministic, slug-sorted body (LLM-free) is byte-identical on
 * regen, so an unchanged namespace no-ops in `PageStore` (no version churn → cheap idempotency).
 */
import type { Principal } from "@brain/shared"
import { and, asc, eq, isNull, ne, or } from "drizzle-orm"
import { PageStore } from "../pages/store"
import { pages } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { scopePredicate, visibilityPredicate } from "../scoped/predicates"

export const INDEX_INGESTED_VIA = "index"
const ROOT_SLUG = "index"
const SUMMARY_MAX = 140

/** One world page as the index builder sees it. */
export interface IndexChild {
  slug: string
  title: string
  body: string
}

/** The first prose paragraph of a body (skips headings/blank), whitespace-collapsed + truncated. */
export const firstParagraph = (body: string): string => {
  for (const block of body.split(/\n{2,}/)) {
    const t = block.trim()
    if (t.length === 0 || t.startsWith("#") || t.startsWith("|")) continue
    const line = t.replace(/\s+/g, " ")
    return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
  }
  return ""
}

/** The top-level namespace of a slug (`ideas/x/y` → `ideas`), or null for a namespace-less slug. */
export const topNamespace = (slug: string): string | null => {
  const i = slug.indexOf("/")
  return i > 0 ? slug.slice(0, i) : null
}

/** Deterministic body for a namespace index — one slug-sorted entry per world child. */
export const renderNamespaceBody = (ns: string, children: IndexChild[]): string => {
  const lines = children.map((c) => {
    const summary = firstParagraph(c.body)
    const title = c.title || c.slug
    return `- [[${c.slug}]] — **${title}**${summary ? ` — ${summary}` : ""}`
  })
  const heading = `# ${ns} index`
  const count = `_${children.length} page${children.length === 1 ? "" : "s"}._`
  return `${heading}\n\n${count}\n\n${lines.join("\n")}\n`
}

/** Deterministic body for the root index — namespaces (each → its index) + namespace-less pages. */
export const renderRootBody = (namespaces: string[], topLevel: IndexChild[]): string => {
  const nsLines = namespaces.map((ns) => `- [[${ns}/index]] — **${ns}**`)
  const pageLines = topLevel.map((c) => {
    const summary = firstParagraph(c.body)
    const title = c.title || c.slug
    return `- [[${c.slug}]] — **${title}**${summary ? ` — ${summary}` : ""}`
  })
  const parts = ["# Index"]
  if (nsLines.length > 0) parts.push(`## Namespaces\n\n${nsLines.join("\n")}`)
  if (pageLines.length > 0) parts.push(`## Pages\n\n${pageLines.join("\n")}`)
  return `${parts.join("\n\n")}\n`
}

export interface IndexRegenResult {
  slug: string
  changed: boolean
}

export class IndexPageStore {
  private readonly pages: PageStore
  constructor(
    private readonly db: BrainDrizzle,
    private readonly p: Principal,
  ) {
    this.pages = new PageStore(db, p)
  }

  /**
   * Every world page the SYSTEM principal can see (its `visibilityPredicate` = world only), EXCLUDING
   * index pages themselves (anti-loop: don't index the indexes), slug-ascending.
   */
  async worldPages(): Promise<IndexChild[]> {
    return this.db
      .select({ slug: pages.slug, title: pages.title, body: pages.compiledTruth })
      .from(pages)
      .where(
        and(
          eq(pages.tenantId, this.p.tenantId),
          isNull(pages.deletedAt),
          // NULL-safe: a page with ingested_via IS NULL is still real content — keep it (only index
          // pages are excluded). `col <> 'index'` alone would drop NULL rows (SQL 3-valued logic).
          or(isNull(pages.ingestedVia), ne(pages.ingestedVia, INDEX_INGESTED_VIA)),
          scopePredicate(this.p, pages.scope),
          visibilityPredicate(this.p, {
            visibility: pages.visibility,
            teamId: pages.teamId,
            userId: pages.userId,
          }),
        ),
      )
      .orderBy(asc(pages.slug))
  }

  /** Distinct top-level namespaces (slug-sorted) that have world content. */
  namespacesOf(worldPages: IndexChild[]): string[] {
    const set = new Set<string>()
    for (const p of worldPages) {
      const ns = topNamespace(p.slug)
      if (ns !== null) set.add(ns)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }

  /**
   * (Re)generate `<ns>/index` from the world children UNDER `<ns>/`. Reserved-lane safe + idempotent.
   * A bare page at slug exactly `<ns>` is namespace-LESS (it lists on the root index), so it is NOT
   * pulled in here — otherwise it would double-list (root `## Pages` AND `<ns>/index`).
   */
  async regenerateNamespace(ns: string, worldPages: IndexChild[]): Promise<IndexRegenResult> {
    const slug = `${ns}/index`
    const children = worldPages
      .filter((p) => p.slug !== slug && p.slug.startsWith(`${ns}/`))
      .sort((a, b) => a.slug.localeCompare(b.slug))
    return this.upsertIndex(slug, `${ns} index`, renderNamespaceBody(ns, children))
  }

  /** (Re)generate the root `index` from the namespaces + namespace-less world pages. */
  async regenerateRoot(worldPages: IndexChild[], namespaces: string[]): Promise<IndexRegenResult> {
    const topLevel = worldPages
      .filter((p) => topNamespace(p.slug) === null && p.slug !== ROOT_SLUG)
      .sort((a, b) => a.slug.localeCompare(b.slug))
    return this.upsertIndex(ROOT_SLUG, "Index", renderRootBody(namespaces, topLevel))
  }

  /** Write an index page through `PageStore` (system author, world tier, no pending, no backing doc). */
  private async upsertIndex(slug: string, title: string, body: string): Promise<IndexRegenResult> {
    // Reserved lane: never clobber a non-index page that happens to sit at an index slug.
    const existing = await this.pages.findBySlug(slug)
    if (existing !== undefined && existing.ingestedVia !== INDEX_INGESTED_VIA) {
      return { slug, changed: false }
    }
    const frontmatter = { type: INDEX_INGESTED_VIA, title }
    const res = await this.pages.upsert({
      slug,
      type: INDEX_INGESTED_VIA,
      title,
      visibility: "world",
      teamId: null,
      scope: null,
      frontmatter,
      frontmatterJson: JSON.stringify(frontmatter),
      body,
      hashFrontmatter: JSON.stringify(frontmatter),
      entityId: null,
      ingestedVia: INDEX_INGESTED_VIA,
      sourceKind: INDEX_INGESTED_VIA,
      linkSource: INDEX_INGESTED_VIA,
      recordPending: false, // indexes list existing children only — no red links
      writeTeamIdOnUpdate: false,
      auditAction: "index.page.set",
      reason: "index",
      readOnlyDenyMessage: "index page write denied: read-only principal",
      authorize: () => {},
    })
    return { slug, changed: res.changed }
  }
}

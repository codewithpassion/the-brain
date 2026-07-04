/**
 * Insight pages (v3/W2) — promote a dream `/brain/insights/*` document into a first-class page in
 * the doc graph (`ingested_via='insight'`). The body is the insight markdown; its `## Sources`
 * `[[slug]]` links become REAL `doc_links` (via `PageStore`'s reconcile) instead of cosmetic text,
 * so an insight is linkable + backlinked. Author = the (system) principal; slug is stable per
 * target (`insights/<slugKey>`) so re-reflection VERSIONS the page rather than spawning duplicates.
 *
 * Provenance `'insight'` is AGENT-authored → the W2 anti-loop gate (`notAgentAuthoredPage`) excludes
 * any mention sourced from an insight page, exactly as `origin='dream'` documents are excluded.
 */
import type { Principal } from "@brain/shared"
import { PageStore, type PageUpsertResult } from "../pages/store"
import type { BrainDrizzle } from "../scoped/db"

export const INSIGHT_INGESTED_VIA = "insight"

/** The stable insight-page slug for a reflection target's slug key. */
export const insightPageSlug = (slugKey: string): string => `insights/${slugKey}`

/**
 * Mint (or version) the insight page for a reflection target. `visibility='world'` mirrors the
 * insight document's existing tenant-wide, draft-trust exposure (v2) — an insight is tenant
 * knowledge, never instruction-grade. Idempotent per slug; refuses a non-insight squatter.
 */
export const mintInsightPage = async (
  db: BrainDrizzle,
  principal: Principal,
  args: { slugKey: string; title: string; body: string },
): Promise<PageUpsertResult> => {
  const store = new PageStore(db, principal)
  const slug = insightPageSlug(args.slugKey)
  const frontmatter = { type: INSIGHT_INGESTED_VIA, title: args.title }
  return store.upsert({
    slug,
    type: INSIGHT_INGESTED_VIA,
    title: args.title,
    visibility: "world",
    frontmatter,
    frontmatterJson: JSON.stringify(frontmatter),
    body: args.body,
    hashFrontmatter: JSON.stringify(frontmatter),
    ingestedVia: INSIGHT_INGESTED_VIA,
    sourceKind: INSIGHT_INGESTED_VIA,
    linkSource: INSIGHT_INGESTED_VIA,
    recordPending: true, // Sources [[slug]] resolve to real doc_links (red until the target exists)
    writeTeamIdOnUpdate: false,
    auditAction: "insight.page.set",
    reason: "set",
    readOnlyDenyMessage: "insight page write denied: read-only principal",
    authorize: (row) => {
      if (row !== undefined && row.ingestedVia !== INSIGHT_INGESTED_VIA) {
        throw new Error(`insight page: slug '${slug}' is in use by a non-insight page`)
      }
    },
  })
}

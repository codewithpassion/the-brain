/**
 * Backing-document write-through (v3/W3) — makes wiki + entity pages searchable by projecting each
 * page into a lightweight `documents` row (namespace `/wiki/<slug>`, `sourceKind='page'`,
 * `sourceId=pageId`, `pages.documentId` linked) that rides the EXISTING ingest spine → chunks, FTS,
 * vectors, citations, and (human pages only) KG extraction. The backing doc's `slug` = the page slug,
 * so a citation resolves to the page via the existing `COALESCE(parent.slug, doc.slug)` resolver.
 *
 * ANTI-LOOP (W-i4): an AGENT-authored page (entity) gets `origin='wiki-agent'` AND `skipEntityExtraction`
 * — searchable, but its chunks never become `sourceKind='chunk'` mentions, so dream-synthesis can't
 * feed the graph. Human wiki pages carry no agent origin and ARE extracted (that's the point — human
 * wiki knowledge enriches entities). EXCLUSIONS: memory pages (v1 "invisible to search" contract),
 * `type='redirect'` stubs (not worth indexing), and insight pages (already searchable via their
 * `origin='dream'` document — pending team-lead: link vs duplicate).
 *
 * The heavy ingest is INJECTED (`runIngest`): the dream/agent path runs `runBatchIngestCore` (no KG
 * needed — agent pages skip it); the surface/human path dispatches the durable `BATCH_INGEST` workflow
 * (core + KG). SELF-HOST NOTE: the surface INLINE fallback (no `BATCH_INGEST` binding — local/test) is
 * KG-less, exactly like `ingest_document`, so a human wiki page feeds the entity graph only on the
 * deployed workflow path. `skip-unchanged` rests on a TIER-SALTED content fingerprint (any
 * visibility/scope/team change forces a re-ingest so a narrowed page can't keep wider-tier chunks).
 */
import { fingerprint } from "@brain/ingest"
import type { BatchIngestParams } from "../ingest"
import { normalizePath } from "../scoped/db"
import { DOC_ORIGIN_WIKI_AGENT } from "../scoped/predicates"
import type { ScopedServices } from "../services"

const WIKI_VIA = "wiki"
const ENTITY_VIA = "entity"
const REDIRECT_TYPE = "redirect"

/** The backing-document namespace for a page slug (`/wiki/<slug>`). */
const backingDocPath = (slug: string): string => normalizePath(`/wiki/${slug}`) ?? "/wiki"

export interface SyncBackingDocResult {
  documentId: string
  /** False when the page's content was unchanged (no re-ingest) or the page is excluded. */
  changed: boolean
  /** True when the page type/provenance is deliberately not backed (memory/redirect/insight). */
  excluded: boolean
}

/** True for a page type/provenance that gets a searchable backing document (wiki + entity). */
const isBackable = (ingestedVia: string | null, type: string): boolean => {
  if (type === REDIRECT_TYPE) return false
  return ingestedVia === WIKI_VIA || ingestedVia === ENTITY_VIA
}

/**
 * Create/update a page's backing document, then run the ingest spine (via `runIngest`). Idempotent:
 * unchanged content (same page-salted fingerprint) is a no-op. Returns the linked document id.
 */
export const syncBackingDoc = async (
  services: ScopedServices,
  pageId: string,
  runIngest: (params: BatchIngestParams) => Promise<void>,
): Promise<SyncBackingDocResult | null> => {
  const page = await services.graph.getPageForBackingDoc(pageId)
  if (page === null || page.deletedAt !== null) return null
  if (!isBackable(page.ingestedVia, page.type)) {
    // A page that LOST its backable status but still carries a backing doc — e.g. a merged entity page
    // (D4) turned into a `type='redirect'` — REAPS that doc, so a stale pre-transition copy can't stay
    // searchable (and can't cite the redirect stub via the reverse-map). Idempotent + self-healing.
    if (page.documentId !== null) {
      await deleteBackingDoc(services, pageId)
      await services.graph.linkPageBackingDoc(pageId, null)
      return { documentId: page.documentId, changed: true, excluded: true }
    }
    return { documentId: "", changed: false, excluded: true }
  }

  const isAgent = page.ingestedVia === ENTITY_VIA // (insight excluded for now)
  const origin = isAgent ? DOC_ORIGIN_WIKI_AGENT : null
  const skipEntityExtraction = isAgent
  // Salt the fingerprint with the ACCESS TIER (visibility/scope/team), not just slug+body: a
  // world→private edit with an unchanged body MUST force a re-ingest — otherwise the skip-unchanged
  // gate keeps the old wider-tier chunks/vectors and the now-private body stays search-discoverable.
  const tier = `${page.visibility}|${page.scope ?? ""}|${page.teamId ?? ""}`
  const fp = await fingerprint(`${page.slug}\n${tier}\n${page.body}`)
  const path = backingDocPath(page.slug)

  // Find the backing doc by its linked id INCLUDING soft-deleted rows — so a delete→recreate at the
  // same slug RESURRECTS the doc (supersede path) instead of a fresh INSERT that would collide on the
  // unique slug/fingerprint indexes (they span soft-deletes) and leave the page unsearchable forever.
  const existing =
    page.documentId !== null ? await services.db.getBackingDocById(page.documentId) : null

  // Skip-unchanged: a LIVE indexed backing doc at the same tier-salted fingerprint needs no re-ingest.
  if (
    existing !== null &&
    existing.deletedAt === null &&
    existing.fingerprint === fp &&
    existing.status === "indexed"
  ) {
    return { documentId: existing.id, changed: false, excluded: false }
  }

  const ingestParams = (documentId: string, r2Key: string): BatchIngestParams => ({
    documentId,
    r2Key,
    contentType: "text/markdown",
    scope: page.scope,
    teamId: page.teamId,
    userId: page.userId, // a private page's chunks carry its author so the author can search it
    visibility: page.visibility,
    path,
    skipEntityExtraction,
  })

  /** Supersede/RESURRECT an existing (possibly soft-deleted) backing doc: replace chunks+vectors+KG. */
  const supersede = async (documentId: string, bodyR2Key: string | null): Promise<void> => {
    const r2Key = bodyR2Key ?? `documents/${documentId}`
    const { chunkIds, partDocumentIds } = await services.db.hardDeleteDocumentChunks(documentId)
    if (chunkIds.length > 0) await services.vectors.deleteVectors(chunkIds)
    await services.graph.clearExtractionForFamily([documentId, ...partDocumentIds])
    await services.blobs.put(r2Key, page.body)
    await services.db.updateDocumentForSupersede(documentId, {
      fingerprint: fp,
      bodyR2Key: r2Key,
      deletedAt: null, // resurrect if the page was deleted then recreated at this slug
      contentType: "text/markdown",
      slug: page.slug,
      path,
    })
    await services.graph.linkPageBackingDoc(pageId, documentId) // (re)link, idempotent
    await runIngest(ingestParams(documentId, r2Key))
  }

  if (existing !== null) {
    await supersede(existing.id, existing.bodyR2Key)
    return { documentId: existing.id, changed: true, excluded: false }
  }

  // Fresh page → INSERT. A unique-index collision means a prior sync created the doc but failed to
  // link it (crash between insert and link) — adopt + supersede that orphan rather than throw forever.
  const documentId = crypto.randomUUID()
  const r2Key = `documents/${documentId}`
  try {
    await services.db.insertDocument({
      id: documentId,
      slug: page.slug,
      fingerprint: fp,
      title: page.title,
      contentType: "text/markdown",
      bodyR2Key: r2Key,
      status: "pending",
      sourceKind: "page",
      sourceId: pageId,
      path,
      origin,
      scope: page.scope,
      teamId: page.teamId,
    })
  } catch {
    const orphan = await services.db.getDocumentBySlug(page.slug)
    if (orphan === null)
      throw new Error(`syncBackingDoc: insert failed for '${page.slug}' (non-dedup)`)
    await supersede(orphan.id, `documents/${orphan.id}`)
    return { documentId: orphan.id, changed: true, excluded: false }
  }
  await services.blobs.put(r2Key, page.body)
  await services.graph.linkPageBackingDoc(pageId, documentId)
  await runIngest(ingestParams(documentId, r2Key))
  return { documentId, changed: true, excluded: false }
}

/**
 * Cascade a page soft-delete to its backing document: soft-delete the doc (+ live child parts),
 * drop the chunks' vectors, and clear the KG mentions extracted from it. Idempotent no-op when the
 * page has no backing doc. The `pages.documentId` link is kept so a resurrected page re-syncs.
 */
export const deleteBackingDoc = async (
  services: ScopedServices,
  pageId: string,
): Promise<{ deleted: boolean }> => {
  const page = await services.graph.getPageForBackingDoc(pageId)
  if (page === null || page.documentId === null) return { deleted: false }
  const { chunkIds, partDocumentIds } = await services.db.softDeleteDocument(page.documentId)
  if (chunkIds.length > 0) await services.vectors.deleteVectors(chunkIds)
  await services.graph.clearExtractionForFamily([page.documentId, ...partDocumentIds])
  return { deleted: true }
}

/**
 * The uniform op catalog — the SINGLE source the three surface generators (MCP tools, tRPC
 * procedures, CLI command specs) project from, so a capability can never appear on one surface
 * and silently vanish from another. Each `SurfaceOp` pairs a frozen `OpDef` (the contract that
 * defines the MCP `inputSchema`, the tRPC input validator, and the CLI flags) with a uniform
 * `invoke(ctx, input)` that builds its OWN tenant-scoped deps from `@brain/db` and dispatches to
 * the already-tested handler/coordination fn.
 *
 * The handlers are deliberately heterogeneous (search/graph `BoundOp`s vs session/governance
 * coordination fns vs admin handlers) — rather than force one grand deps type, each family has a
 * thin adapter that knows how to build its slice. The surface layer never touches a raw binding:
 * every `createScopedServices` / `createSessionServices` / `drizzle(env.DB)` call lives inside
 * `@brain/db`.
 */
import {
  ADD_THOUGHT_OP,
  ADMIN_OPS,
  type AdminBoundOp,
  APPLY_CORRECTIONS_OP,
  AUDIT_EXPORT_OP,
  auditExport,
  type BatchIngestParams,
  type BoundOp,
  BREAK_GLASS_READ_OP,
  breakGlassRead,
  CAPTURE_TURN_OP,
  type CaptureTurnRequest,
  CREATE_SNAPSHOT_OP,
  captureTurn,
  createBreakGlassAuditSink,
  createScopedServices,
  createSessionServices,
  createSnapshot,
  DELETE_DOCUMENT_OP,
  DELETE_ENTITY_OP,
  DREAM_NOW_OP,
  deleteBackingDoc,
  deleteWikiPage,
  dispatchDreamRun,
  exportOkfBundle,
  exportWikiBundle,
  FINALIZE_SESSION_OP,
  FORGET_FACT_OP,
  forgetFact,
  forgetMemory,
  GET_CONTEXT_SNAPSHOT_OP,
  GET_DOCUMENT_OP,
  GET_SESSION_CONTEXT_OP,
  GRAPH_OPS,
  type GraphOpDeps,
  getContextSnapshot,
  getMemory,
  getSessionContext,
  getWikiPage,
  getWikiPageHistory,
  INGEST_DOCUMENT_OP,
  importOkfBundle,
  importWikiBundle,
  LIST_PENDING_REVIEWS_OP,
  LIST_SNAPSHOTS_OP,
  listDreamRunsOp,
  listMemory,
  listPendingReviews,
  listSnapshots,
  listWikiPages,
  MEMORY_FORGET_OP,
  MEMORY_GET_OP,
  MEMORY_HISTORY_OP,
  MEMORY_LIST_OP,
  MEMORY_REVIEW_OP,
  MEMORY_ROLLBACK_OP,
  MEMORY_SET_OP,
  MERGE_ENTITIES_OP,
  type MemorySetRequest,
  makeBudgetPort,
  makeRecallSink,
  memoryHistory,
  moveWikiPage,
  NOTION_OPS,
  normalizePath,
  OKF_EXPORT_OP,
  OKF_IMPORT_OP,
  PROPOSE_CORRECTIONS_OP,
  prepareWikiImage,
  queryOp,
  RECALL_OP,
  REPLACE_IN_DOCUMENT_OP,
  REPROCESS_DOCUMENT_OP,
  RESOLVE_CONTRADICTION_OP,
  REVIVE_FACT_OP,
  type RecallRequest,
  type RetrievalInput,
  recall,
  recordThinkSpend,
  resolveContradiction,
  reviveFact,
  rollbackMemory,
  runBatchIngestCore,
  runSessionPromote,
  type ScopedServices,
  SET_SPEAKER_MAP_OP,
  type SearchDeps,
  saveWikiPage,
  searchOp,
  setMemory,
  submitMemoryReview,
  syncBackingDoc,
  type ThinkResult,
  thinkOp,
  UPDATE_DOCUMENT_OP,
  VAULT_OPS,
  VAULT_WRITEBACK_OP,
  WIKI_DELETE_PAGE_OP,
  WIKI_EXPORT_BUNDLE_OP,
  WIKI_GET_PAGE_OP,
  WIKI_IMPORT_BUNDLE_OP,
  WIKI_LIST_PAGES_OP,
  WIKI_MOVE_PAGE_OP,
  WIKI_PAGE_HISTORY_OP,
  WIKI_SAVE_PAGE_OP,
  WIKI_UPLOAD_IMAGE_OP,
  type WikiSavePageInput,
} from "@brain/db"
import { fingerprint, toMarkdown, workflowInstanceId } from "@brain/ingest"
import type { AnyOpDef, Principal } from "@brain/shared"
import { type BrainDeepLinks, brainDeepLinks } from "@brain/shared"
import type { SurfaceContext } from "./context"
import {
  applyAnchoredChanges,
  buildProposePrompt,
  emptyProposalNote,
  PROPOSE_CORRECTIONS_SYSTEM,
  parseProposedChanges,
  validateProposedChanges,
} from "./corrections"
import { planReplacements } from "./replace"
import {
  applySpeakerMap,
  meetingSlugIn,
  type SpeakerMap,
  speakerMapKey,
  speakerMapSlug,
} from "./speakers"

/** One op exposed to the surface layer: its frozen contract + a surface-agnostic invoker. */
export interface SurfaceOp {
  def: AnyOpDef
  invoke: (ctx: SurfaceContext, input: unknown) => Promise<unknown>
}

/** Drop absent optionals so the value satisfies `exactOptionalPropertyTypes` (no forced `undefined`). */
const retrievalInput = (raw: {
  query: string
  topK: number
  scope?: string
  path?: string
  tag?: string
  expandQuery?: boolean
}): RetrievalInput => ({
  query: raw.query,
  topK: raw.topK,
  ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
  ...(raw.path !== undefined ? { path: raw.path } : {}),
  ...(raw.tag !== undefined ? { tag: raw.tag } : {}),
  ...(raw.expandQuery !== undefined ? { expandQuery: raw.expandQuery } : {}),
})

/** Compose the concrete `SearchDeps` (budget 429 pre-check + waitUntil recall sink) from services. */
const buildSearchDeps = (ctx: SurfaceContext, services: ScopedServices): SearchDeps => ({
  db: services.db,
  vectors: services.vectors,
  ai: services.ai,
  budget: makeBudgetPort(services),
  recall: makeRecallSink(services, ctx.waitUntil, ctx.surface),
})

// ── Search family (search | query | think) ───────────────────────────────────
const searchSurfaceOp = (op: BoundOp<RetrievalInput, unknown>): SurfaceOp => ({
  def: op.def,
  invoke: async (ctx, input) => {
    const services = createScopedServices(ctx.env, ctx.principal)
    const parsed = op.def.input.parse(input) as {
      query: string
      topK: number
      scope?: string
      path?: string
      tag?: string
      expandQuery?: boolean
    }
    const out = await op.handler(
      { deps: buildSearchDeps(ctx, services), principal: ctx.principal },
      retrievalInput(parsed),
    )
    // think's two side-effects (invariants 16/10): the budget pre-check runs INSIDE the handler;
    // the coarse spend attribution is dispatched here, off the read path.
    if (op.def.name === "think") ctx.waitUntil(recordThinkSpend(services, out as ThinkResult))
    return out
  },
})

// ── Graph family (traverse / links / tags / entities / …) ─────────────────────
interface ErasedGraphOp {
  def: AnyOpDef
  handler: (ctx: { deps: GraphOpDeps; principal: Principal }, input: unknown) => Promise<unknown>
}

const buildGraphDeps = (services: ScopedServices): GraphOpDeps => ({
  graph: services.graph,
  entityVectors: services.entityVectors,
  ai: { embed: services.ai.embed },
})

const graphSurfaceOp = (op: ErasedGraphOp): SurfaceOp => ({
  def: op.def,
  invoke: (ctx, input) => {
    const services = createScopedServices(ctx.env, ctx.principal)
    return op.handler(
      { deps: buildGraphDeps(services), principal: ctx.principal },
      op.def.input.parse(input),
    )
  },
})

// ── Entity curation (delete_entity / merge_entities) ──────────────────────────

/** A live, tenant-scoped entity or a teaching error naming the op. */
const requireLiveEntity = async (
  services: ScopedServices,
  op: string,
  entityId: string,
): Promise<{ id: string; name: string; kind: string }> => {
  const entity = await findLiveEntity(services, op, entityId)
  if (entity === null) throw new Error(`${op}: entity ${entityId} not found`)
  return entity
}

/** Null when the id is unknown (a merged or already-deleted entity still throws a teaching error). */
const findLiveEntity = async (
  services: ScopedServices,
  op: string,
  entityId: string,
): Promise<{ id: string; name: string; kind: string } | null> => {
  const row = await services.graph.getEntityForMerge(entityId)
  if (row === null) return null
  if (row.mergedInto !== null) {
    throw new Error(`${op}: entity ${entityId} was already merged into ${row.mergedInto}`)
  }
  if (row.deletedAt !== null) throw new Error(`${op}: entity ${entityId} is already deleted`)
  return { id: row.id, name: row.name, kind: row.kind }
}

/**
 * `delete_entity` — soft (default) or hard. Order: drop the projected page (+ reap its backing doc
 * off the read path, like `wiki_delete_page`), delete the graph rows, then the entity vector
 * (best-effort — the D1 row is the gate and the Dream sweep reconciles stale vectors).
 *
 * DANGLING PAGE: the orphan GC in `clearPriorExtraction` hard-deletes entity rows but leaves their
 * minted pages behind, so `entities/person/speaker-0` can outlive its entity. When the id is
 * unknown but a page still points at it, the page (and its backing doc) is removed and that is
 * reported as the deletion; only an id with neither entity nor page is "not found".
 */
const deleteEntitySurfaceOp: SurfaceOp = {
  def: DELETE_ENTITY_OP,
  invoke: async (ctx, input) => {
    const { entityId, hard } = DELETE_ENTITY_OP.input.parse(input)
    const services = createScopedServices(ctx.env, ctx.principal)
    const entity = await findLiveEntity(services, "delete_entity", entityId)
    const page = await services.wiki.deleteEntityPage(entityId)
    if (page.pageId !== null) {
      const pageId = page.pageId
      ctx.waitUntil(
        deleteBackingDoc(services, pageId).catch((err) => {
          console.error("entity page backing-doc delete failed", pageId, err)
        }),
      )
    }
    if (entity === null) {
      if (page.pageId === null) throw new Error(`delete_entity: entity ${entityId} not found`)
      return {
        entityId,
        canonicalName: page.title,
        deleted: true,
        hard,
        relationsDropped: 0,
        mentionsDropped: 0,
        pageSlug: page.slug,
      }
    }
    const counts = hard
      ? await services.graph.hardDeleteEntity(entityId)
      : { ...(await services.graph.softDeleteEntity(entityId)), mentionsDropped: 0 }
    try {
      await services.entityVectors.deleteVectors([entityId])
    } catch (err) {
      console.error("entity vector delete failed", entityId, err)
    }
    return {
      entityId,
      canonicalName: entity.name,
      deleted: true,
      hard,
      relationsDropped: counts.relationsDropped,
      mentionsDropped: counts.mentionsDropped,
      pageSlug: page.slug,
    }
  },
}

/**
 * `merge_entities` — the audited Dream-dedup merge (`ScopedGraph.mergeEntities`) plus its three
 * follow-ons, mirrored from `dream/dedup.ts`: redirect the loser's page to the winner's, reap the
 * redirect stub's backing doc, and drop the loser's vector.
 */
const mergeEntitiesSurfaceOp: SurfaceOp = {
  def: MERGE_ENTITIES_OP,
  invoke: async (ctx, input) => {
    const { fromEntityId, intoEntityId } = MERGE_ENTITIES_OP.input.parse(input)
    if (fromEntityId === intoEntityId) {
      throw new Error("merge_entities: fromEntityId and intoEntityId are the same entity")
    }
    const services = createScopedServices(ctx.env, ctx.principal)
    const loser = await requireLiveEntity(services, "merge_entities", fromEntityId)
    const winner = await requireLiveEntity(services, "merge_entities", intoEntityId)
    if (loser.kind !== winner.kind) {
      throw new Error(
        `merge_entities: kinds differ (${loser.kind} → ${winner.kind}); refusing to merge across kinds`,
      )
    }
    await services.graph.mergeEntities(intoEntityId, fromEntityId)
    let redirectedTo: string | null = null
    try {
      const rp = await services.wiki.repointEntityPage(fromEntityId, intoEntityId)
      redirectedTo = rp.winnerSlug ?? null
      if (rp.loserPageId !== undefined) {
        const loserPageId = rp.loserPageId
        ctx.waitUntil(
          syncBackingDoc(services, loserPageId, runPageIngest(ctx, services)).catch((err) => {
            console.error("merge_entities: loser page backing-doc sync failed", loserPageId, err)
          }),
        )
      }
    } catch (err) {
      console.error("merge_entities: entity-page repoint failed", fromEntityId, intoEntityId, err)
    }
    try {
      await services.entityVectors.deleteVectors([fromEntityId])
    } catch (err) {
      console.error("merge_entities: loser vector delete failed", fromEntityId, err)
    }
    return {
      fromEntityId,
      intoEntityId,
      merged: true,
      intoCanonicalName: winner.name,
      redirectedTo,
    }
  },
}

// ── Session family (capture_turn / finalize / context / recall / forget) ──────
const sessionServices = (ctx: SurfaceContext) => createSessionServices(ctx.env, ctx.principal)

const captureTurnSurfaceOp: SurfaceOp = {
  def: CAPTURE_TURN_OP,
  invoke: (ctx, input) =>
    captureTurn(sessionServices(ctx), CAPTURE_TURN_OP.input.parse(input) as CaptureTurnRequest),
}

const getSessionContextSurfaceOp: SurfaceOp = {
  def: GET_SESSION_CONTEXT_OP,
  invoke: (ctx, input) => {
    const parsed = GET_SESSION_CONTEXT_OP.input.parse(input)
    return getSessionContext(sessionServices(ctx), parsed.brainSessionId, parsed.snapshotId, {
      prefix: parsed.memoryPrefix,
      ...(parsed.memoryPath !== undefined ? { path: parsed.memoryPath } : {}),
    })
  },
}

const recallSurfaceOp: SurfaceOp = {
  def: RECALL_OP,
  invoke: async (ctx, input) => {
    const services = sessionServices(ctx)
    const parsed = RECALL_OP.input.parse(input)
    const facts = await recall(services, parsed as RecallRequest)
    // Invariant 10: one recall trace per kept hit, OFF the read path; zero hits → zero traces.
    if (facts.length > 0) {
      const query = parsed.query ?? parsed.grep ?? parsed.entitySlug ?? "recall"
      const traces = facts.map((fact, i) => ({
        query,
        targetId: String(fact.id),
        score: 1 - i / facts.length,
        clientId: ctx.surface,
      }))
      ctx.waitUntil(services.db.appendRecallTraces(traces))
    }
    return {
      facts: facts.map((fact) => ({
        id: fact.id,
        fact: fact.fact,
        kind: fact.kind,
        supersededBy: fact.supersededBy,
        consolidatedInto: fact.consolidatedInto,
        validUntil: fact.validUntil,
      })),
    }
  },
}

// ── Dream family (dream_now / list_dream_runs) ────────────────────────────────

/**
 * `dream_now` — trigger a consolidation dream for the caller's tenant via the SHARED
 * `dispatchDreamRun` helper (workflow-or-inline; the same path the nightly cron uses). A genuine
 * dispatch error propagates (only a duplicate same-day instance is swallowed, inside the helper).
 */
const dreamNowSurfaceOp: SurfaceOp = {
  def: DREAM_NOW_OP,
  invoke: (ctx, input) => {
    const { kind } = DREAM_NOW_OP.input.parse(input)
    return dispatchDreamRun(ctx.env, ctx.principal, kind)
  },
}

const forgetFactSurfaceOp: SurfaceOp = {
  def: FORGET_FACT_OP,
  invoke: async (ctx, input) => {
    const { factId } = FORGET_FACT_OP.input.parse(input)
    await forgetFact(sessionServices(ctx), factId)
    return { factId, forgotten: true }
  },
}

const reviveFactSurfaceOp: SurfaceOp = {
  def: REVIVE_FACT_OP,
  invoke: async (ctx, input) => {
    const { factId, confidence } = REVIVE_FACT_OP.input.parse(input)
    await reviveFact(sessionServices(ctx), factId, confidence)
    return { factId, revived: true }
  },
}

const createSnapshotSurfaceOp: SurfaceOp = {
  def: CREATE_SNAPSHOT_OP,
  invoke: async (ctx, input) => {
    const { label, scope, kind } = CREATE_SNAPSHOT_OP.input.parse(input)
    const snapshotId = await createSnapshot(
      sessionServices(ctx),
      label,
      scope !== undefined ? scope : null,
      kind,
    )
    return { snapshotId }
  },
}

const getContextSnapshotSurfaceOp: SurfaceOp = {
  def: GET_CONTEXT_SNAPSHOT_OP,
  invoke: async (ctx) => getContextSnapshot(sessionServices(ctx)),
}

const listSnapshotsSurfaceOp: SurfaceOp = {
  def: LIST_SNAPSHOTS_OP,
  invoke: async (ctx, input) => {
    const { limit } = LIST_SNAPSHOTS_OP.input.parse(input)
    const snapshots = await listSnapshots(sessionServices(ctx), limit)
    return { snapshots }
  },
}

/**
 * `finalize_session` — mark `finalizing`, then dispatch `SessionPromoteWorkflow`
 * (`promote-${tenantId}-${sessionId}`, idempotent) when the binding is present, else run the
 * promote inline (local/test). Mirrors apps/api's canonical REST `handleFinalizeSession` — the
 * surface-binding glue for this op; the promote logic itself lives in `@brain/db`.
 */
const finalizeSessionSurfaceOp: SurfaceOp = {
  def: FINALIZE_SESSION_OP,
  invoke: async (ctx, input) => {
    const services = sessionServices(ctx)
    const { brainSessionId } = FINALIZE_SESSION_OP.input.parse(input)
    const session = await services.sessions.getSession(brainSessionId)
    if (session === null) throw new Error("finalize: session not found in tenant")
    await services.sessions.finalizeSession(brainSessionId)
    const promote = {
      sessionId: brainSessionId,
      userId: session.userId,
      scope: session.scope,
      teamId: session.teamId,
    }
    const workflow = ctx.env.SESSION_PROMOTE
    if (workflow) {
      await workflow.create({
        id: await workflowInstanceId(`promote-${ctx.principal.tenantId}-${brainSessionId}`),
        params: { principal: ctx.principal, promote },
      })
    } else {
      await runSessionPromote(services, promote)
    }
    return { brainSessionId, status: "finalizing" }
  },
}

// ── Memory family (memory_set / get / list / history / rollback / forget) ─────
// OKF-compatible agent memory on the pages layer; the store enforces tenant/scope/visibility
// isolation + audits every mutation in-batch (docs/okf-memory-plan.md).
const memoryStore = (ctx: SurfaceContext) => sessionServices(ctx).memory

const memorySetSurfaceOp: SurfaceOp = {
  def: MEMORY_SET_OP,
  invoke: (ctx, input) =>
    setMemory(
      memoryStore(ctx),
      MEMORY_SET_OP.input.parse(input) as MemorySetRequest,
      new Date().toISOString(),
    ),
}

const memoryGetSurfaceOp: SurfaceOp = {
  def: MEMORY_GET_OP,
  invoke: async (ctx, input) => {
    const { slug } = MEMORY_GET_OP.input.parse(input)
    return { memory: await getMemory(memoryStore(ctx), slug) }
  },
}

const memoryListSurfaceOp: SurfaceOp = {
  def: MEMORY_LIST_OP,
  invoke: async (ctx, input) => {
    const parsed = MEMORY_LIST_OP.input.parse(input)
    const memories = await listMemory(memoryStore(ctx), {
      prefix: parsed.prefix,
      limit: parsed.limit,
      ...(parsed.path !== undefined ? { path: parsed.path } : {}),
    })
    return { memories }
  },
}

const memoryHistorySurfaceOp: SurfaceOp = {
  def: MEMORY_HISTORY_OP,
  invoke: async (ctx, input) => {
    const { slug } = MEMORY_HISTORY_OP.input.parse(input)
    return { versions: await memoryHistory(memoryStore(ctx), slug) }
  },
}

const memoryRollbackSurfaceOp: SurfaceOp = {
  def: MEMORY_ROLLBACK_OP,
  invoke: (ctx, input) => {
    const { slug, toRevisionId } = MEMORY_ROLLBACK_OP.input.parse(input)
    return rollbackMemory(memoryStore(ctx), slug, toRevisionId)
  },
}

const memoryForgetSurfaceOp: SurfaceOp = {
  def: MEMORY_FORGET_OP,
  invoke: (ctx, input) => {
    const { slug } = MEMORY_FORGET_OP.input.parse(input)
    return forgetMemory(memoryStore(ctx), slug)
  },
}

const okfExportSurfaceOp: SurfaceOp = {
  def: OKF_EXPORT_OP,
  invoke: (ctx, input) => {
    const parsed = OKF_EXPORT_OP.input.parse(input)
    return exportOkfBundle(memoryStore(ctx), {
      prefix: parsed.prefix,
      ...(parsed.path !== undefined ? { path: parsed.path } : {}),
    })
  },
}

const okfImportSurfaceOp: SurfaceOp = {
  def: OKF_IMPORT_OP,
  invoke: (ctx, input) => {
    const { files } = OKF_IMPORT_OP.input.parse(input)
    return importOkfBundle(memoryStore(ctx), files)
  },
}

// ── Wiki family (wiki_save_page / get / list / move / delete) ─────────────────
// First-class wiki pages on the shared `pages` layer; the WikiStore enforces the same
// tenant/scope/visibility isolation + in-batch audit as memory (docs/v3-implementation-plan.md W1).
// W3: a page write also syncs a searchable backing document (off the write path via waitUntil).
const wikiStore = (ctx: SurfaceContext) => createScopedServices(ctx.env, ctx.principal).wiki

/**
 * The ingest runner for a backing document: dispatch the durable `BATCH_INGEST` workflow when bound
 * (it runs the full spine incl. KG for human wiki pages, honouring `skipEntityExtraction`), else run
 * the KG-less core inline (local/test — matches `ingest_document`'s inline fallback).
 */
const runPageIngest =
  (ctx: SurfaceContext, services: ScopedServices) =>
  async (params: BatchIngestParams): Promise<void> => {
    const workflow = ctx.env.BATCH_INGEST
    if (workflow) {
      await workflow.create({
        id: await workflowInstanceId(`wiki-bd-${ctx.principal.tenantId}-${params.documentId}`),
        params: { principal: ctx.principal, ingest: params },
      })
    } else {
      await runBatchIngestCore(services, params)
    }
  }

/**
 * Fire the backing-doc sync OFF the write path (waitUntil), errors LOGGED not swallowed. Always
 * called on save (even an unchanged one) so a missing/stale backing doc SELF-HEALS on the next write;
 * `syncBackingDoc`'s tier-salted skip-unchanged makes the common (current) case a cheap no-op.
 */
const backgroundSync = (ctx: SurfaceContext, services: ScopedServices, pageId: string): void => {
  ctx.waitUntil(
    syncBackingDoc(services, pageId, runPageIngest(ctx, services)).catch((err) => {
      console.error("wiki backing-doc sync failed", pageId, err)
    }),
  )
}

const wikiSavePageSurfaceOp: SurfaceOp = {
  def: WIKI_SAVE_PAGE_OP,
  invoke: async (ctx, input) => {
    const services = createScopedServices(ctx.env, ctx.principal)
    const result = await saveWikiPage(
      services.wiki,
      WIKI_SAVE_PAGE_OP.input.parse(input) as WikiSavePageInput,
    )
    backgroundSync(ctx, services, result.pageId) // heals even an unchanged save (skip-unchanged no-op)
    return result
  },
}

const wikiGetPageSurfaceOp: SurfaceOp = {
  def: WIKI_GET_PAGE_OP,
  invoke: async (ctx, input) => {
    const services = createScopedServices(ctx.env, ctx.principal)
    const { target } = WIKI_GET_PAGE_OP.input.parse(input)
    const page = await getWikiPage(services.wiki, target)
    // Self-heal on read: a page viewed with a missing/stale backing doc is re-synced in the background
    // (a no-op when current). This is the safety net for a transient write-path sync failure that is
    // never followed by another save. Skipped for a synthesizable stub (no page yet).
    if (page !== null && page.stub !== true && page.page.id !== "") {
      backgroundSync(ctx, services, page.page.id)
    }
    return { page }
  },
}

const wikiPageHistorySurfaceOp: SurfaceOp = {
  def: WIKI_PAGE_HISTORY_OP,
  invoke: async (ctx, input) => {
    const { target, limit } = WIKI_PAGE_HISTORY_OP.input.parse(input)
    return getWikiPageHistory(wikiStore(ctx), target, limit)
  },
}

const wikiExportBundleSurfaceOp: SurfaceOp = {
  def: WIKI_EXPORT_BUNDLE_OP,
  invoke: async (ctx, input) => {
    const { namespace, prefix } = WIKI_EXPORT_BUNDLE_OP.input.parse(input)
    return exportWikiBundle(wikiStore(ctx), {
      prefix,
      ...(namespace !== undefined ? { namespace } : {}),
    })
  },
}

const wikiImportBundleSurfaceOp: SurfaceOp = {
  def: WIKI_IMPORT_BUNDLE_OP,
  invoke: async (ctx, input) => {
    const { files, namespace } = WIKI_IMPORT_BUNDLE_OP.input.parse(input)
    return importWikiBundle(wikiStore(ctx), files, namespace)
  },
}

const wikiListPagesSurfaceOp: SurfaceOp = {
  def: WIKI_LIST_PAGES_OP,
  invoke: async (ctx, input) => {
    const parsed = WIKI_LIST_PAGES_OP.input.parse(input)
    const pages = await listWikiPages(wikiStore(ctx), {
      limit: parsed.limit,
      ...(parsed.namespacePrefix !== undefined ? { namespacePrefix: parsed.namespacePrefix } : {}),
      ...(parsed.type !== undefined ? { type: parsed.type } : {}),
      ...(parsed.tag !== undefined ? { tag: parsed.tag } : {}),
    })
    return { pages }
  },
}

const wikiMovePageSurfaceOp: SurfaceOp = {
  def: WIKI_MOVE_PAGE_OP,
  invoke: async (ctx, input) => {
    const services = createScopedServices(ctx.env, ctx.principal)
    const { fromSlug, toSlug } = WIKI_MOVE_PAGE_OP.input.parse(input)
    const result = await moveWikiPage(services.wiki, fromSlug, toSlug)
    // The moved page's backing doc follows its new slug/path; the redirect stub is excluded (redirect).
    backgroundSync(ctx, services, result.pageId)
    return result
  },
}

const wikiDeletePageSurfaceOp: SurfaceOp = {
  def: WIKI_DELETE_PAGE_OP,
  invoke: async (ctx, input) => {
    const services = createScopedServices(ctx.env, ctx.principal)
    const { slug } = WIKI_DELETE_PAGE_OP.input.parse(input)
    const result = await deleteWikiPage(services.wiki, slug)
    if (result.deleted && result.pageId !== null) {
      ctx.waitUntil(
        deleteBackingDoc(services, result.pageId).catch((err) => {
          console.error("wiki backing-doc delete failed", result.pageId, err)
        }),
      )
    }
    return result
  },
}

/**
 * `wiki_upload_image` — validate + shape the image (pure `prepareWikiImage`), then write the bytes to
 * the body store via `ScopedR2` (contentType in httpMetadata). R2-only, so — like `vault_writeback` —
 * there is no in-batch D1 audit (the wiki ops' audit is a WikiStore property; this op has no D1 row).
 * Returns the `![alt](/wiki-media/<id>)` snippet for the caller to embed in a page body.
 */
const wikiUploadImageSurfaceOp: SurfaceOp = {
  def: WIKI_UPLOAD_IMAGE_OP,
  invoke: async (ctx, input) => {
    const parsed = WIKI_UPLOAD_IMAGE_OP.input.parse(input) as {
      filename: string
      data: string
      alt?: string
      contentType?: string
    }
    const services = createScopedServices(ctx.env, ctx.principal)
    const prepared = prepareWikiImage(parsed)
    await services.blobs.put(prepared.key, prepared.bytes, {
      httpMetadata: { contentType: prepared.contentType },
    })
    return {
      id: prepared.id,
      key: prepared.key,
      markdown: prepared.markdown,
      contentType: prepared.contentType,
      bytes: prepared.bytes.byteLength,
    }
  },
}

// ── Governance family (memory_review / break_glass_read / audit_export) ───────
// Governance ops need the break-glass audit sink (a PRESENT sink is the gate — break-glass fails
// closed when it is absent); build the session services WITH it for this family.
const governanceServices = (ctx: SurfaceContext) =>
  createSessionServices(ctx.env, ctx.principal, {
    breakGlassAudit: createBreakGlassAuditSink(ctx.env),
  })

const memoryReviewSurfaceOp: SurfaceOp = {
  def: MEMORY_REVIEW_OP,
  invoke: async (ctx, input) => {
    const parsed = MEMORY_REVIEW_OP.input.parse(input)
    await submitMemoryReview(governanceServices(ctx), parsed.factId, {
      status: parsed.status,
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    })
    return { factId: parsed.factId, status: parsed.status }
  },
}

const breakGlassReadSurfaceOp: SurfaceOp = {
  def: BREAK_GLASS_READ_OP,
  invoke: async (ctx, input) => {
    const parsed = BREAK_GLASS_READ_OP.input.parse(input)
    const result = await breakGlassRead(governanceServices(ctx), parsed)
    return {
      chunks: result.chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
      facts: result.facts.map((fact) => ({ id: fact.id, fact: fact.fact })),
    }
  },
}

const auditExportSurfaceOp: SurfaceOp = {
  def: AUDIT_EXPORT_OP,
  invoke: (ctx, input) =>
    auditExport(governanceServices(ctx), AUDIT_EXPORT_OP.input.parse(input).cursor),
}

const listPendingReviewsSurfaceOp: SurfaceOp = {
  def: LIST_PENDING_REVIEWS_OP,
  invoke: async (ctx, input) => {
    const { limit } = LIST_PENDING_REVIEWS_OP.input.parse(input)
    return { reviews: await listPendingReviews(governanceServices(ctx), limit) }
  },
}

const resolveContradictionSurfaceOp: SurfaceOp = {
  def: RESOLVE_CONTRADICTION_OP,
  invoke: (ctx, input) => {
    const parsed = RESOLVE_CONTRADICTION_OP.input.parse(input)
    return resolveContradiction(governanceServices(ctx), {
      reviewId: parsed.reviewId,
      action: parsed.action,
      ...(parsed.keepFactId !== undefined ? { keepFactId: parsed.keepFactId } : {}),
    })
  },
}

// ── Admin family (mint_api_key / get_token_spend / memberships) ───────────────
const adminSurfaceOp = (op: AdminBoundOp<unknown, unknown>): SurfaceOp => ({
  def: op.def,
  invoke: (ctx, input) =>
    op.handler({ env: ctx.env, principal: ctx.principal }, op.def.input.parse(input)),
})

// ── Ingest family (add_thought | ingest_document) ─────────────────────────────

/**
 * `add_thought` — capture a quick thought as a small note under `brain/thoughts/<yyyy-mm>`
 * (tagged `thought`). fingerprint → R2 → insertDocument → BATCH_INGEST workflow (or inline),
 * reusing the ingest spine. Uses a time-stamped fingerprint + slug so each capture is its OWN
 * doc; a genuine unique-conflict still returns the promised `{status:'duplicate'}`.
 */
const addThoughtSurfaceOp: SurfaceOp = {
  def: ADD_THOUGHT_OP,
  invoke: async (ctx, input) => {
    const parsed = ADD_THOUGHT_OP.input.parse(input) as { thought: string; tags?: string[] }
    const services = createScopedServices(ctx.env, ctx.principal)
    const markdown = toMarkdown(parsed.thought, "text/markdown")
    if (markdown.trim().length === 0) throw new Error("add_thought: empty thought")
    const now = new Date()
    const month = now.toISOString().slice(0, 7) // yyyy-mm
    const path = normalizePath(`brain/thoughts/${month}`)
    const tags = ["thought", ...(parsed.tags ?? [])]
    // A time-stamped fingerprint (+ time-based slug) so each capture is its OWN doc — a repeated
    // identical thought is kept, not deduped away.
    const stamp = now.toISOString()
    const fp = await fingerprint(`${markdown}\n@${stamp}`)
    const slug = `thought-${stamp.replace(/[:.]/g, "-")}-${fp.slice(0, 6)}`
    const documentId = crypto.randomUUID()
    const r2Key = `documents/${documentId}`
    // Durable dedup backstop: catch the UNIQUE conflict → duplicate response (mirrors ingest_document).
    let docId: string
    try {
      docId = await services.db.insertDocument({
        id: documentId,
        slug,
        fingerprint: fp,
        contentType: "text/markdown",
        bodyR2Key: r2Key,
        status: "pending",
        tags,
        ...(path !== null ? { path } : {}),
      })
    } catch {
      const existing = (await services.db.listDocuments()).find(
        (doc) => doc.fingerprint === fp || doc.slug === slug,
      )
      return {
        documentId: existing?.id ?? null,
        slug: existing?.slug ?? slug,
        status: "duplicate" as const,
        chunkCount: 0,
      }
    }
    await services.blobs.put(r2Key, markdown)
    const ingestParams = {
      documentId: docId,
      r2Key,
      contentType: "text/markdown",
      scope: null,
      ...(path !== null ? { path } : {}),
    }
    const workflow = ctx.env.BATCH_INGEST
    if (workflow) {
      await workflow.create({
        id: await workflowInstanceId(`ingest-${ctx.principal.tenantId}-${fp}`),
        params: { principal: ctx.principal, ingest: ingestParams },
      })
      return { documentId: docId, slug, status: "accepted", chunkCount: 0 }
    }
    const result = await runBatchIngestCore(services, ingestParams)
    return { documentId: docId, slug, status: "indexed" as const, chunkCount: result.chunkCount }
  },
}

/**
 * `ingest_document` — fingerprint → R2 → insertDocument → BATCH_INGEST workflow (or inline).
 * Accepts text/markdown and text/plain content. Normalizes path, stores tags as a JSON array,
 * and sets created_at via insertDocument's forced `now`. Mirrors the POST /documents REST route.
 */
const ingestDocumentSurfaceOp: SurfaceOp = {
  def: INGEST_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const parsed = INGEST_DOCUMENT_OP.input.parse(input) as {
      content: string
      title?: string
      path?: string
      tags?: string[]
      contentType: "text/markdown" | "text/plain"
    }
    const services = createScopedServices(ctx.env, ctx.principal)
    const contentType = parsed.contentType
    const markdown = toMarkdown(parsed.content, contentType)
    if (markdown.trim().length === 0) {
      throw new Error("ingest_document: extracted markdown is empty — nothing to ingest")
    }
    const fp = await fingerprint(markdown)
    const slug = `doc-${fp.slice(0, 12)}`
    const documentId = crypto.randomUUID()
    const r2Key = `documents/${documentId}`

    // Insert the documents row; catch the UNIQUE-constraint conflict → dedup response.
    let docId: string
    try {
      docId = await services.db.insertDocument({
        id: documentId,
        slug,
        fingerprint: fp,
        contentType: "text/markdown",
        bodyR2Key: r2Key,
        status: "pending",
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
        ...(parsed.path !== undefined ? { path: normalizePath(parsed.path) } : {}),
      })
    } catch {
      const existing = (await services.db.listDocuments()).find(
        (doc) => doc.fingerprint === fp || doc.slug === slug,
      )
      return {
        documentId: existing?.id ?? null,
        slug: existing?.slug ?? slug,
        status: "duplicate",
        chunkCount: 0,
      }
    }

    // Body (extracted markdown) → R2 before triggering the pipeline.
    await services.blobs.put(r2Key, markdown)

    const normalizedPath = parsed.path !== undefined ? normalizePath(parsed.path) : null
    const ingestParams = {
      documentId: docId,
      r2Key,
      contentType: "text/markdown",
      scope: null,
      ...(normalizedPath !== null ? { path: normalizedPath } : {}),
    }

    // Deploy: dispatch the durable BATCH_INGEST Workflow; local/test: run inline.
    const workflow = ctx.env.BATCH_INGEST
    if (workflow) {
      await workflow.create({
        id: await workflowInstanceId(`ingest-${ctx.principal.tenantId}-${fp}`),
        params: { principal: ctx.principal, ingest: ingestParams },
      })
      return { documentId: docId, slug, status: "accepted", chunkCount: 0 }
    }

    const result = await runBatchIngestCore(services, ingestParams)
    // runBatchIngestCore returns "indexed" | "failed"; both map to "indexed" in the surface
    // contract (a "failed" result throws inside runBatchIngestCore before returning "failed").
    return { documentId: docId, slug, status: "indexed" as const, chunkCount: result.chunkCount }
  },
}

// ── Vault-writeback helper — stamps `source: brain` frontmatter ──────────────

/**
 * Prepend `source: brain` into YAML frontmatter (or add a new frontmatter block) so the
 * Obsidian importer recognises these as Brain-authored and skips them on re-ingest.
 * No dependency on `parseDocument` (circular) — a targeted regex is sufficient here.
 *
 * CRLF safety: capture the opening fence (`---\n` or `---\r\n`) and use its actual length
 * as the injection offset so CRLF files are not malformed.
 * source: detection uses `/^source:/m` (line-anchored) to avoid false-positives on keys
 * like `data-source:`.
 */
const stampBrainFrontmatter = (content: string): string => {
  const FM_RE = /^(---\r?\n)([\s\S]*?)\r?\n---/
  const match = FM_RE.exec(content)
  if (match !== null) {
    // Frontmatter exists: inject `source: brain` if absent.
    // Line-anchored test so `data-source:` etc. don't false-positive.
    if (!/^source:/m.test(match[2] ?? "")) {
      const fenceLen = (match[1] ?? "---\n").length
      return `${content.slice(0, match.index + fenceLen)}source: brain\n${content.slice(match.index + fenceLen)}`
    }
    return content // already has source:
  }
  // No frontmatter: prepend a minimal block.
  return `---\nsource: brain\n---\n\n${content}`
}

// ── Delete document ───────────────────────────────────────────────────────────

/**
 * `delete_document` — soft-delete a document by id or slug. Removes all its chunks from D1
 * (soft-delete), then deletes the corresponding Vectorize vectors off-batch.
 */
const deleteDocumentSurfaceOp: SurfaceOp = {
  def: DELETE_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const { documentId, slug } = DELETE_DOCUMENT_OP.input.parse(input)
    if (documentId === undefined && slug === undefined) {
      throw new Error("delete_document: provide exactly one of documentId or slug")
    }
    const services = createScopedServices(ctx.env, ctx.principal)

    // Resolve to a document id — by explicit id, or by slug lookup.
    let docId: string | null = null
    if (documentId !== undefined) {
      docId = documentId
    } else if (slug !== undefined) {
      const row = await services.db.getDocumentBySlug(slug)
      docId = row?.id ?? null
    }

    if (docId === null) {
      return { documentId: null, deleted: false }
    }

    // A voice doc keeps its raw audio at `documents/audio/<id>` for provenance — remove it on delete
    // (it is large and provenance-only; the transcript body blob follows the existing soft-delete
    // retention policy). Best-effort + idempotent: a missing key is a no-op.
    const row = await services.db.getDocumentById(docId)
    if (row?.contentType === "voice") {
      await services.blobs.delete(`documents/audio/${docId}`)
    }

    const { chunkIds, partDocumentIds } = await services.db.softDeleteDocument(docId)
    if (chunkIds.length > 0) {
      await services.vectors.deleteVectors(chunkIds)
    }
    // Clear the KG knowledge extracted from this document AND its child parts (§4.3, W4.5): clear
    // mentions, prune relations, and GC any entity with no remaining mentions across the tenant (so
    // the entity arm no longer surfaces deleted-note entities — including from split-doc child parts).
    await services.graph.clearExtractionForFamily([docId, ...partDocumentIds])
    return { documentId: docId, deleted: true }
  },
}

// ── Get document ─────────────────────────────────────────────────────────────

/**
 * `get_document` — point-lookup by id; fetches the markdown body from R2 via the scoped blob
 * store. Returns an empty body string when the R2 object is absent (e.g. a pending doc whose
 * body was never written).
 */
const getDocumentSurfaceOp: SurfaceOp = {
  def: GET_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const { documentId } = GET_DOCUMENT_OP.input.parse(input) as { documentId: string }
    const services = createScopedServices(ctx.env, ctx.principal)
    const doc = await services.db.getDocumentById(documentId)
    if (doc === null) {
      throw new Error(`get_document: document ${documentId} not found`)
    }
    let body = ""
    if (doc.bodyR2Key !== null) {
      const obj = await services.blobs.get(doc.bodyR2Key)
      if (obj !== null) {
        body = await obj.text()
      }
    }
    return {
      id: doc.id,
      slug: doc.slug,
      title: doc.title ?? null,
      status: doc.status,
      contentType: doc.contentType ?? null,
      body,
      chunkCount: doc.chunkCount ?? 0,
      tags: JSON.parse(doc.tags ?? "[]") as string[],
      path: doc.path ?? null,
      scope: doc.scope ?? null,
      createdAt: doc.createdAt ?? null,
      updatedAt: doc.updatedAt ?? null,
    }
  },
}

// ── Reprocess document ────────────────────────────────────────────────────────

/**
 * `reprocess_document` — resets a document to `pending` and re-dispatches the full
 * BATCH_INGEST workflow with a fresh `crypto.randomUUID()` nonce in the instance id
 * so rapid re-dispatch is never deduplicated. Falls back to inline `runBatchIngestCore`
 * when the workflow binding is absent (local/test), mirroring `ingest_document`.
 */
const reprocessDocumentSurfaceOp: SurfaceOp = {
  def: REPROCESS_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const { documentId } = REPROCESS_DOCUMENT_OP.input.parse(input) as { documentId: string }
    const services = createScopedServices(ctx.env, ctx.principal)
    const doc = await services.db.getDocumentById(documentId)
    if (doc === null) {
      throw new Error(`reprocess_document: document ${documentId} not found`)
    }

    await services.db.updateDocumentStatus(documentId, { status: "pending" })

    const ingestParams = {
      documentId,
      r2Key: doc.bodyR2Key ?? `documents/${documentId}`,
      // The stored body is ALWAYS extracted markdown (a 'voice' doc's body is its transcript, not
      // audio) — re-ingest it as text/markdown; never re-transcribe. Any non-text origin marker maps
      // to text/markdown for chunking.
      contentType:
        doc.contentType === "voice" ? "text/markdown" : (doc.contentType ?? "text/markdown"),
      scope: doc.scope ?? null,
      ...(doc.path !== null ? { path: doc.path } : {}),
    }

    const workflow = ctx.env.BATCH_INGEST
    if (workflow) {
      const nonce = crypto.randomUUID()
      const instanceId = await workflowInstanceId(
        `reprocess-${ctx.principal.tenantId}-${documentId}-${nonce}`,
      )
      await workflow.create({
        id: instanceId,
        params: { principal: ctx.principal, ingest: ingestParams },
      })
      return { documentId, status: "pending" }
    }

    const result = await runBatchIngestCore(services, ingestParams)
    return { documentId, status: result.status }
  },
}

// ── Update document ───────────────────────────────────────────────────────────

/**
 * Replace a document's body in-place and re-drive the full ingest pipeline: write the new body to R2,
 * hard-delete old chunks (freeing deterministic PKs) + their Vectorize vectors + the old part family's
 * KG mentions (privacy: never orphan mentions of deleted parts), supersede the row (new fingerprint +
 * status `pending`) via `updateDocumentForSupersede`, then re-dispatch BATCH_INGEST (inline when the
 * workflow binding is absent). Shared by `update_document` and `apply_corrections` — this sequence is
 * privacy-sensitive, so it lives in ONE place. `markdown` is the final stored body; id/slug preserved.
 */
const reingestDocumentBody = async (
  ctx: SurfaceContext,
  services: ScopedServices,
  doc: { id: string; bodyR2Key: string | null; scope: string | null; path: string | null },
  markdown: string,
  contentType: string,
  instancePrefix: string,
): Promise<{ documentId: string; status: string }> => {
  const documentId = doc.id
  const r2Key = doc.bodyR2Key ?? `documents/${documentId}`

  // Write new body to R2 first (cheap rollback: old content is still in R2 until overwrite).
  await services.blobs.put(r2Key, markdown)

  const fp = await fingerprint(markdown)

  const { chunkIds: oldChunkIds, partDocumentIds: oldPartIds } =
    await services.db.hardDeleteDocumentChunks(documentId)
  if (oldChunkIds.length > 0) {
    await services.vectors.deleteVectors(oldChunkIds)
  }
  await services.graph.clearExtractionForFamily([documentId, ...oldPartIds])

  await services.db.updateDocumentForSupersede(documentId, {
    fingerprint: fp,
    bodyR2Key: r2Key,
    deletedAt: null,
    contentType,
  })

  const ingestParams = {
    documentId,
    r2Key,
    contentType: "text/markdown",
    scope: doc.scope ?? null,
    ...(doc.path !== null ? { path: doc.path } : {}),
  }

  const workflow = ctx.env.BATCH_INGEST
  if (workflow) {
    const nonce = crypto.randomUUID()
    const instanceId = await workflowInstanceId(
      `${instancePrefix}-${ctx.principal.tenantId}-${documentId}-${nonce}`,
    )
    await workflow.create({
      id: instanceId,
      params: { principal: ctx.principal, ingest: ingestParams },
    })
    return { documentId, status: "pending" }
  }

  const result = await runBatchIngestCore(services, ingestParams)
  return { documentId, status: result.status }
}

/**
 * `update_document` — replaces the document body (from raw `content`) and re-runs ingest via the
 * shared `reingestDocumentBody`. The new body clears any stale 'voice' origin marker (the body is no
 * longer a transcript once the caller replaces it with text).
 */
const updateDocumentSurfaceOp: SurfaceOp = {
  def: UPDATE_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const parsed = UPDATE_DOCUMENT_OP.input.parse(input) as {
      documentId: string
      content: string
      contentType: "text/markdown" | "text/plain"
    }
    const services = createScopedServices(ctx.env, ctx.principal)
    const doc = await services.db.getDocumentById(parsed.documentId)
    if (doc === null) {
      throw new Error(`update_document: document ${parsed.documentId} not found`)
    }
    const markdown = toMarkdown(parsed.content, parsed.contentType)
    return reingestDocumentBody(ctx, services, doc, markdown, parsed.contentType, "update")
  },
}

// ── Propose / apply corrections ───────────────────────────────────────────────

/** Load the current body of a correction target (document R2 body or wiki page body). */
const loadCorrectionBody = async (
  services: ScopedServices,
  targetType: "document" | "wiki",
  target: string,
): Promise<string> => {
  if (targetType === "wiki") {
    const detail = await getWikiPage(services.wiki, target)
    if (detail === null || detail.page.id === "") {
      throw new Error(`propose_corrections: wiki page ${target} not found`)
    }
    return detail.body
  }
  const doc = await services.db.getDocumentById(target)
  if (doc === null) throw new Error(`propose_corrections: document ${target} not found`)
  if (doc.bodyR2Key === null) return ""
  const obj = await services.blobs.get(doc.bodyR2Key)
  return obj === null ? "" : await obj.text()
}

/** Anchored changes are verbose (verbatim before + after per change); the 4 K default truncated them. */
const PROPOSE_MAX_TOKENS = 8192

/**
 * `propose_corrections` — DRY-RUN. One `genExtract` pass over the target body → anchored before/after
 * changes, validated so only anchors that occur EXACTLY ONCE are `applicable`; ambiguous/not-found
 * ones are reported in `skipped`. Writes nothing. `genExtract` never throws (returns null → no changes).
 */
const proposeCorrectionsSurfaceOp: SurfaceOp = {
  def: PROPOSE_CORRECTIONS_OP,
  invoke: async (ctx, input) => {
    const { targetType, target, instruction } = PROPOSE_CORRECTIONS_OP.input.parse(input)
    const services = createScopedServices(ctx.env, ctx.principal)
    const body = await loadCorrectionBody(services, targetType, target)
    if (body.length === 0) return { targetType, target, changes: [], skipped: [] }
    const raw = await services.ai.genExtract(
      buildProposePrompt(instruction, body),
      PROPOSE_CORRECTIONS_SYSTEM,
      { maxTokens: PROPOSE_MAX_TOKENS },
    )
    const proposed = parseProposedChanges(raw)
    const validated = validateProposedChanges(body, proposed)
    const note = emptyProposalNote(raw, proposed, validated)
    return { targetType, target, ...validated, ...(note !== null ? { note } : {}) }
  },
}

/**
 * `apply_corrections` — apply approved anchored changes atomically (each `before` must match exactly
 * once or the whole op throws with nothing written), then reprocess: documents via the shared
 * `reingestDocumentBody`, wiki pages via `saveWikiPage` (+ backing-doc sync), preserving type/tier.
 */
const applyCorrectionsSurfaceOp: SurfaceOp = {
  def: APPLY_CORRECTIONS_OP,
  invoke: async (ctx, input) => {
    const { targetType, target, changes } = APPLY_CORRECTIONS_OP.input.parse(input)
    const services = createScopedServices(ctx.env, ctx.principal)

    if (targetType === "wiki") {
      const detail = await getWikiPage(services.wiki, target)
      if (detail === null || detail.page.id === "") {
        throw new Error(`apply_corrections: wiki page ${target} not found`)
      }
      const { body: newBody, applied } = applyAnchoredChanges(detail.body, changes)
      if (applied === 0 || newBody === detail.body) {
        return { targetType, target, applied: 0, status: "unchanged" }
      }
      // saveWikiPage REBUILDS frontmatter from what's passed, so re-supply the page's existing
      // title/tags/description/draft (else they'd blank) and OMIT visibility to preserve the tier.
      const fm = detail.frontmatter
      const result = await saveWikiPage(services.wiki, {
        slug: detail.page.slug,
        type: detail.page.type,
        title: detail.page.title,
        body: newBody,
        ...(detail.tags.length > 0 ? { tags: detail.tags } : {}),
        ...(typeof fm.description === "string" ? { description: fm.description } : {}),
        ...(typeof fm.draft === "boolean" ? { draft: fm.draft } : {}),
      })
      backgroundSync(ctx, services, result.pageId)
      return { targetType, target, applied, status: "saved" }
    }

    const doc = await services.db.getDocumentById(target)
    if (doc === null) throw new Error(`apply_corrections: document ${target} not found`)
    let currentBody = ""
    if (doc.bodyR2Key !== null) {
      const obj = await services.blobs.get(doc.bodyR2Key)
      if (obj !== null) currentBody = await obj.text()
    }
    if (currentBody.length === 0) {
      throw new Error(`apply_corrections: document ${target} has no body to edit`)
    }
    const { body: newBody, applied } = applyAnchoredChanges(currentBody, changes)
    if (applied === 0 || newBody === currentBody) {
      return { targetType, target, applied: 0, status: "unchanged" }
    }
    // Stored body is always markdown (a 'voice' doc's body is its transcript) — reingest as markdown.
    const contentType =
      doc.contentType === "voice" ? "text/markdown" : (doc.contentType ?? "text/markdown")
    const res = await reingestDocumentBody(ctx, services, doc, newBody, contentType, "correct")
    return { targetType, target, applied, status: res.status }
  },
}

// ── Bulk replace / speaker map ────────────────────────────────────────────────

/** Load a document + its full R2 body, throwing (with the op name) when either is absent. */
const loadDocumentBody = async (
  services: ScopedServices,
  op: string,
  documentId: string,
): Promise<{
  doc: NonNullable<Awaited<ReturnType<ScopedServices["db"]["getDocumentById"]>>>
  body: string
}> => {
  const doc = await services.db.getDocumentById(documentId)
  if (doc === null) throw new Error(`${op}: document ${documentId} not found`)
  let body = ""
  if (doc.bodyR2Key !== null) {
    const obj = await services.blobs.get(doc.bodyR2Key)
    if (obj !== null) body = await obj.text()
  }
  if (body.length === 0) throw new Error(`${op}: document ${documentId} has no body to edit`)
  return { doc, body }
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** Reingest a document body after a bulk edit, preserving a voice doc's markdown transcript. */
const reingestEdited = (
  ctx: SurfaceContext,
  services: ScopedServices,
  doc: Awaited<ReturnType<typeof loadDocumentBody>>["doc"],
  body: string,
  instancePrefix: string,
): Promise<{ documentId: string; status: string }> => {
  const contentType =
    doc.contentType === "voice" ? "text/markdown" : (doc.contentType ?? "text/markdown")
  return reingestDocumentBody(ctx, services, doc, body, contentType, instancePrefix)
}

/**
 * `replace_in_document` — plan every rule against the ORIGINAL body in one pass (`planReplacements`
 * throws with actual counts on any violation, before anything is written), then either return the
 * dry-run preview or write + reprocess via the shared `reingestDocumentBody`.
 */
const replaceInDocumentSurfaceOp: SurfaceOp = {
  def: REPLACE_IN_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const { documentId, replacements, dryRun } = REPLACE_IN_DOCUMENT_OP.input.parse(input)
    const services = createScopedServices(ctx.env, ctx.principal)
    const { doc, body } = await loadDocumentBody(services, "replace_in_document", documentId)
    const plan = planReplacements(body, replacements)
    const base = {
      documentId,
      dryRun,
      results: plan.results,
      bytesBefore: utf8Bytes(body),
      bytesAfter: utf8Bytes(plan.body),
    }
    if (dryRun) return { ...base, status: "dry-run", diff: plan.diff }
    if (plan.body === body) return { ...base, status: "unchanged" }
    const res = await reingestEdited(ctx, services, doc, plan.body, "replace")
    return { ...base, status: res.status }
  },
}

/**
 * `set_speaker_map` — persist the label→person map as agent memory keyed by the recording (so the
 * sync can resolve a re-ingest of the same audio without a human), then optionally relabel the body
 * in place (+ the `## Speakers` block, once) and reprocess.
 */
const setSpeakerMapSurfaceOp: SurfaceOp = {
  def: SET_SPEAKER_MAP_OP,
  invoke: async (ctx, input) => {
    const { documentId, speakers, applyToBody } = SET_SPEAKER_MAP_OP.input.parse(input) as {
      documentId: string
      speakers: SpeakerMap
      applyToBody: boolean
    }
    const services = createScopedServices(ctx.env, ctx.principal)
    const { doc, body } = await loadDocumentBody(services, "set_speaker_map", documentId)
    const key = speakerMapKey(body, documentId)
    const memorySlug = speakerMapSlug(key)
    const resolvedOn = new Date().toISOString().slice(0, 10)
    const meetingSlug = meetingSlugIn(body)
    const record = {
      source: key.startsWith("plaud-") ? "plaud" : "document",
      fileId: key,
      documentId,
      ...(meetingSlug !== null ? { meetingSlug } : {}),
      resolvedOn,
      resolvedBy: ctx.principal.userId,
      speakers,
    }
    await setMemory(
      memoryStore(ctx),
      {
        slug: memorySlug,
        type: "note",
        title: `Speaker map: ${key}`,
        description: `Who each diarised speaker label is in ${key}.`,
        tags: ["meeting", "speaker-map"],
        body: JSON.stringify(record, null, 2),
        // Tenant-wide on purpose: the map is read back by the meetings sync (an API-key principal)
        // that is not the OAuth user who wrote it; a private map would silently never apply.
        visibility: "world",
      },
      new Date().toISOString(),
    )
    const base = { documentId, memorySlug, key }
    if (!applyToBody) {
      return { ...base, results: [], skippedLabels: [], blockInserted: false, status: "stored" }
    }
    const applied = applySpeakerMap(body, speakers, resolvedOn)
    const summary = {
      results: applied.results,
      skippedLabels: applied.skippedLabels,
      blockInserted: applied.blockInserted,
    }
    if (applied.body === body) return { ...base, ...summary, status: "unchanged" }
    const res = await reingestEdited(ctx, services, doc, applied.body, "speakers")
    return { ...base, ...summary, status: res.status }
  },
}

// ── Vault write-back ──────────────────────────────────────────────────────────

/**
 * `vault_writeback` — write Brain-authored files to the Obsidian vault's `Brain/` prefix in R2.
 * Files are stamped with `source: brain` frontmatter so the importer skips them on re-ingest.
 */
const vaultWritebackSurfaceOp: SurfaceOp = {
  def: VAULT_WRITEBACK_OP,
  invoke: async (ctx, input) => {
    const { files } = VAULT_WRITEBACK_OP.input.parse(input) as {
      files: { path: string; content: string }[]
    }
    const services = createScopedServices(ctx.env, ctx.principal)
    let written = 0
    for (const file of files) {
      // Strip leading slashes, remove `..` and `.` segments (defense-in-depth against a
      // filesystem-sync client that normalises `..`), then place under the reserved Brain/ prefix.
      const safePath = file.path
        .replace(/^\/+/, "")
        .split("/")
        .filter((seg) => seg !== ".." && seg !== ".")
        .join("/")
      const vaultPath = `vault/Brain/${safePath}`
      const stamped = stampBrainFrontmatter(file.content)
      await services.blobs.put(vaultPath, stamped)
      written++
    }
    return { written }
  },
}

// ── Deep-link decoration ──────────────────────────────────────────────────────
// Every read result that names a retrievable thing gains a `url` deep link into the dashboard,
// built from ctx.env.DASHBOARD_URL. Applied as one post-invoke wrapper over the WHOLE catalog
// (keyed by op name) so no individual invoker changes and the generic GRAPH_OPS/ADMIN_OPS wrappers
// stay untouched. When DASHBOARD_URL is unset the output is byte-identical (no `url` key emitted).

/** Attach `url` to an object only when defined (keeps outputs byte-identical when the base is unset). */
const withUrl = <T extends object>(item: T, url: string | undefined): T =>
  url === undefined ? item : { ...item, url }

/**
 * Decorate a read op's output with dashboard deep links; unknown ops pass through unchanged.
 * Exported for unit testing (the sibling `deep-links.decorate.test.ts`); not part of the public
 * `@brain/surface` surface.
 */
export const decorateWithUrls = (name: string, out: unknown, links: BrainDeepLinks): unknown => {
  if (out === null || typeof out !== "object") return out
  switch (name) {
    // `query` shares SEARCH_OP.output (same schema object), so it decorates identically.
    case "query":
    case "search": {
      const o = out as { hits: { documentId: string }[] }
      return { ...o, hits: o.hits.map((h) => withUrl(h, links.document(h.documentId))) }
    }
    case "think": {
      // The cited documents (brief: think → each citation .url); evidence rides SearchHitSchema too
      // but stays undecorated (search already covers that shape).
      const o = out as { citations: { documentId: string }[] }
      return { ...o, citations: o.citations.map((c) => withUrl(c, links.document(c.documentId))) }
    }
    case "get_document": {
      const o = out as { id: string }
      return withUrl(o, links.document(o.id))
    }
    case "list_documents": {
      const o = out as { documents: { id: string }[] }
      return { ...o, documents: o.documents.map((d) => withUrl(d, links.document(d.id))) }
    }
    case "wiki_get_page": {
      const o = out as {
        page: ({ page: { slug: string }; headings: { id: string }[] } & object) | null
      }
      if (o.page === null) return o
      const slug = o.page.page.slug
      // Each heading gains its own `#id` deep link; the page itself keeps its top-level url.
      const headings = o.page.headings.map((h) => withUrl(h, links.wikiHeading(slug, h.id)))
      return { ...o, page: withUrl({ ...o.page, headings }, links.wikiPage(slug)) }
    }
    case "wiki_list_pages": {
      const o = out as { pages: { slug: string }[] }
      return { ...o, pages: o.pages.map((p) => withUrl(p, links.wikiPage(p.slug))) }
    }
    case "memory_get": {
      const o = out as { memory: ({ slug: string } & object) | null }
      return o.memory === null
        ? o
        : { ...o, memory: withUrl(o.memory, links.memory(o.memory.slug)) }
    }
    case "memory_list": {
      const o = out as { memories: { slug: string }[] }
      return { ...o, memories: o.memories.map((m) => withUrl(m, links.memory(m.slug))) }
    }
    case "search_entities": {
      // hits[].name is the entity's canonicalName (searchEntities maps row.canonicalName → name).
      const o = out as { hits: { kind: string; name: string }[] }
      return { ...o, hits: o.hits.map((h) => withUrl(h, links.entity(h.kind, h.name))) }
    }
    case "list_entities": {
      const o = out as { entities: { kind: string; canonicalName: string }[] }
      return {
        ...o,
        entities: o.entities.map((e) => withUrl(e, links.entity(e.kind, e.canonicalName))),
      }
    }
    case "list_sessions": {
      const o = out as { sessions: { id: string }[] }
      return { ...o, sessions: o.sessions.map((s) => withUrl(s, links.session(s.id))) }
    }
    default:
      return out
  }
}

/** Wrap a SurfaceOp so its output carries dashboard deep links (see `decorateWithUrls`). */
const withDeepLinks = (op: SurfaceOp): SurfaceOp => ({
  def: op.def,
  invoke: async (ctx, input) => {
    const out = await op.invoke(ctx, input)
    return decorateWithUrls(op.def.name, out, brainDeepLinks(ctx.env.DASHBOARD_URL))
  },
})

/**
 * The full surface catalog (search → graph → session → governance → ingest → admin). The order is
 * purely cosmetic; the generators key off `def.surfaces` / `def.name`, and the drift test asserts
 * every registry op is present here. Every op is wrapped with `withDeepLinks` so read results carry
 * dashboard `url`s (a no-op for ops `decorateWithUrls` doesn't recognise).
 */
export const buildCatalog = (): readonly SurfaceOp[] =>
  [
    searchSurfaceOp(searchOp),
    searchSurfaceOp(queryOp),
    searchSurfaceOp(thinkOp),
    ...(GRAPH_OPS as unknown as readonly ErasedGraphOp[]).map(graphSurfaceOp),
    deleteEntitySurfaceOp,
    mergeEntitiesSurfaceOp,
    captureTurnSurfaceOp,
    finalizeSessionSurfaceOp,
    getSessionContextSurfaceOp,
    recallSurfaceOp,
    forgetFactSurfaceOp,
    reviveFactSurfaceOp,
    createSnapshotSurfaceOp,
    getContextSnapshotSurfaceOp,
    listSnapshotsSurfaceOp,
    dreamNowSurfaceOp,
    adminSurfaceOp(listDreamRunsOp as unknown as AdminBoundOp<unknown, unknown>),
    memorySetSurfaceOp,
    memoryGetSurfaceOp,
    memoryListSurfaceOp,
    memoryHistorySurfaceOp,
    memoryRollbackSurfaceOp,
    memoryForgetSurfaceOp,
    okfExportSurfaceOp,
    okfImportSurfaceOp,
    wikiSavePageSurfaceOp,
    wikiGetPageSurfaceOp,
    wikiPageHistorySurfaceOp,
    wikiExportBundleSurfaceOp,
    wikiImportBundleSurfaceOp,
    wikiListPagesSurfaceOp,
    wikiMovePageSurfaceOp,
    wikiDeletePageSurfaceOp,
    wikiUploadImageSurfaceOp,
    memoryReviewSurfaceOp,
    breakGlassReadSurfaceOp,
    auditExportSurfaceOp,
    listPendingReviewsSurfaceOp,
    resolveContradictionSurfaceOp,
    ingestDocumentSurfaceOp,
    addThoughtSurfaceOp,
    deleteDocumentSurfaceOp,
    getDocumentSurfaceOp,
    reprocessDocumentSurfaceOp,
    updateDocumentSurfaceOp,
    proposeCorrectionsSurfaceOp,
    applyCorrectionsSurfaceOp,
    replaceInDocumentSurfaceOp,
    setSpeakerMapSurfaceOp,
    vaultWritebackSurfaceOp,
    ...(ADMIN_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
    ...(VAULT_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
    ...(NOTION_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
  ].map(withDeepLinks)

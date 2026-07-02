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
  AUDIT_EXPORT_OP,
  auditExport,
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
  DREAM_NOW_OP,
  dispatchDreamRun,
  exportOkfBundle,
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
  INGEST_DOCUMENT_OP,
  importOkfBundle,
  LIST_PENDING_REVIEWS_OP,
  LIST_SNAPSHOTS_OP,
  listDreamRunsOp,
  listMemory,
  listPendingReviews,
  listSnapshots,
  MEMORY_FORGET_OP,
  MEMORY_GET_OP,
  MEMORY_HISTORY_OP,
  MEMORY_LIST_OP,
  MEMORY_REVIEW_OP,
  MEMORY_ROLLBACK_OP,
  MEMORY_SET_OP,
  type MemorySetRequest,
  makeBudgetPort,
  makeRecallSink,
  memoryHistory,
  NOTION_OPS,
  normalizePath,
  OKF_EXPORT_OP,
  OKF_IMPORT_OP,
  queryOp,
  RECALL_OP,
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
  type SearchDeps,
  searchOp,
  setMemory,
  submitMemoryReview,
  type ThinkResult,
  thinkOp,
  UPDATE_DOCUMENT_OP,
  VAULT_OPS,
  VAULT_WRITEBACK_OP,
} from "@brain/db"
import { fingerprint, toMarkdown, workflowInstanceId } from "@brain/ingest"
import type { AnyOpDef, Principal } from "@brain/shared"
import type { SurfaceContext } from "./context"

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
 * `update_document` — replaces the document body in R2, hard-deletes old chunks (freeing
 * deterministic PKs for re-use), removes their Vectorize vectors, then supersedes the
 * document row (new fingerprint + status `pending`) via `updateDocumentForSupersede` and
 * re-dispatches the full BATCH_INGEST workflow.  Slug and id are preserved.
 */
const updateDocumentSurfaceOp: SurfaceOp = {
  def: UPDATE_DOCUMENT_OP,
  invoke: async (ctx, input) => {
    const parsed = UPDATE_DOCUMENT_OP.input.parse(input) as {
      documentId: string
      content: string
      contentType: "text/markdown" | "text/plain"
    }
    const { documentId } = parsed
    const services = createScopedServices(ctx.env, ctx.principal)
    const doc = await services.db.getDocumentById(documentId)
    if (doc === null) {
      throw new Error(`update_document: document ${documentId} not found`)
    }

    const markdown = toMarkdown(parsed.content, parsed.contentType)
    const r2Key = doc.bodyR2Key ?? `documents/${documentId}`

    // Write new body to R2 first (cheap rollback: old content is still in R2 until overwrite).
    await services.blobs.put(r2Key, markdown)

    // Compute new fingerprint from the new content.
    const fp = await fingerprint(markdown)

    // Hard-delete old chunks (frees deterministic PKs for the re-ingest) + drop their vectors, AND
    // remove old child part rows (§4.3, W4.5).
    const { chunkIds: oldChunkIds, partDocumentIds: oldPartIds } =
      await services.db.hardDeleteDocumentChunks(documentId)
    if (oldChunkIds.length > 0) {
      await services.vectors.deleteVectors(oldChunkIds)
    }
    // Clear the OLD part family's KG mentions before re-ingest re-extracts — the old child part ids
    // are deleted by the hard-delete above, so their mentions would otherwise orphan (privacy leak).
    await services.graph.clearExtractionForFamily([documentId, ...oldPartIds])

    // Supersede the document row: new fingerprint + status → pending + clear deletedAt. The new body
    // sets content_type from the replacement content — clearing any stale 'voice' origin marker
    // (the body is no longer a transcript once the caller replaces it with text).
    await services.db.updateDocumentForSupersede(documentId, {
      fingerprint: fp,
      bodyR2Key: r2Key,
      deletedAt: null,
      contentType: parsed.contentType,
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
        `update-${ctx.principal.tenantId}-${documentId}-${nonce}`,
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

/**
 * The full surface catalog (search → graph → session → governance → ingest → admin). The order is
 * purely cosmetic; the generators key off `def.surfaces` / `def.name`, and the drift test asserts
 * every registry op is present here.
 */
export const buildCatalog = (): readonly SurfaceOp[] => [
  searchSurfaceOp(searchOp),
  searchSurfaceOp(queryOp),
  searchSurfaceOp(thinkOp),
  ...(GRAPH_OPS as unknown as readonly ErasedGraphOp[]).map(graphSurfaceOp),
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
  vaultWritebackSurfaceOp,
  ...(ADMIN_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
  ...(VAULT_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
  ...(NOTION_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
]

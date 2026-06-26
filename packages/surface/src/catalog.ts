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
  FINALIZE_SESSION_OP,
  FORGET_FACT_OP,
  forgetFact,
  GET_SESSION_CONTEXT_OP,
  GRAPH_OPS,
  type GraphOpDeps,
  getSessionContext,
  INGEST_DOCUMENT_OP,
  LIST_SNAPSHOTS_OP,
  listSnapshots,
  MEMORY_REVIEW_OP,
  makeBudgetPort,
  makeRecallSink,
  normalizePath,
  queryOp,
  RECALL_OP,
  type RecallRequest,
  type RetrievalInput,
  recall,
  recordThinkSpend,
  runBatchIngestCore,
  runSessionPromote,
  type ScopedServices,
  type SearchDeps,
  searchOp,
  submitMemoryReview,
  type ThinkResult,
  thinkOp,
} from "@brain/db"
import { fingerprint, toMarkdown } from "@brain/ingest"
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
}): RetrievalInput => ({
  query: raw.query,
  topK: raw.topK,
  ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
  ...(raw.path !== undefined ? { path: raw.path } : {}),
  ...(raw.tag !== undefined ? { tag: raw.tag } : {}),
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
    return getSessionContext(sessionServices(ctx), parsed.brainSessionId, parsed.snapshotId)
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
    return { facts: facts.map((fact) => ({ id: fact.id, fact: fact.fact, kind: fact.kind })) }
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

const createSnapshotSurfaceOp: SurfaceOp = {
  def: CREATE_SNAPSHOT_OP,
  invoke: async (ctx, input) => {
    const { label, scope } = CREATE_SNAPSHOT_OP.input.parse(input)
    const snapshotId = await createSnapshot(
      sessionServices(ctx),
      label,
      scope !== undefined ? scope : null,
    )
    return { snapshotId }
  },
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
        id: `promote-${ctx.principal.tenantId}-${brainSessionId}`,
        params: { principal: ctx.principal, promote },
      })
    } else {
      await runSessionPromote(services, promote)
    }
    return { brainSessionId, status: "finalizing" }
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

// ── Admin family (mint_api_key / get_token_spend / memberships) ───────────────
const adminSurfaceOp = (op: AdminBoundOp<unknown, unknown>): SurfaceOp => ({
  def: op.def,
  invoke: (ctx, input) =>
    op.handler({ env: ctx.env, principal: ctx.principal }, op.def.input.parse(input)),
})

// ── Ingest family (ingest_document) ───────────────────────────────────────────

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
        id: `ingest-${ctx.principal.tenantId}-${fp}`,
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
  createSnapshotSurfaceOp,
  listSnapshotsSurfaceOp,
  memoryReviewSurfaceOp,
  breakGlassReadSurfaceOp,
  auditExportSurfaceOp,
  ingestDocumentSurfaceOp,
  ...(ADMIN_OPS as unknown as readonly AdminBoundOp<unknown, unknown>[]).map(adminSurfaceOp),
]

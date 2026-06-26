/**
 * `@brain/api` — the SINGLE deployed Worker (PRD §9). Phase 2c wires the first measurable
 * end-to-end vertical slice: `resolvePrincipal` at the edge → `POST /ingest` (markdown →
 * fingerprint → R2 → `documents` row → BatchIngest) → `POST /think` / `/search` (the
 * registered hybrid-search ops over `createScopedServices` + concrete ports).
 *
 * Below the edge no handler touches a raw binding (invariant 2): every route receives the
 * tenant-scoped `ScopedServices` bundle. The Clerk verifier + the services builder are
 * INJECTABLE (the e2e slice injects a no-network fake verifier + a fake Vectorize/AI), but
 * the production default uses the real Clerk JWKS path + real `createScopedServices`.
 */
import {
  AUDIT_EXPORT_OP,
  AuthError,
  BREAK_GLASS_READ_OP,
  CAPTURE_TURN_OP,
  type ClerkVerifier,
  CostCeilingError,
  createAuditExportCursorStore,
  createBreakGlassAuditSink,
  createScopedServices,
  GRAPH_OPS,
  type GraphOpDeps,
  MEMORY_REVIEW_OP,
  type OpenAiCompatConfig,
  RECALL_OP,
  resolvePrincipal,
  type ScopedServices,
  type SearchDeps,
  searchOp,
  thinkOp,
} from "@brain/db"
import { fingerprint, toMarkdown } from "@brain/ingest"
import {
  type AnyOpDef,
  INGEST_WEBHOOK_MAX_BYTES,
  type Principal,
  SEARCH_OP,
  THINK_OP,
} from "@brain/shared"
import { appRouter, createTrpcContext, type SurfaceEnv } from "@brain/surface"
import { trpcServer } from "@hono/trpc-server"
import { Hono } from "hono"
import {
  type BackfillBindings,
  type BackfillMessage,
  handleBackfillQueue,
  handleReembedQueue,
  type ReembedMessage,
  runReembedSweep,
} from "./backfill"
import type { ApiBindings } from "./bindings"
import { isDeviceFlowPath, mountDeviceFlow } from "./device-flow/routes"
import { HttpError } from "./http"
import { type BatchIngestParams, runBatchIngest } from "./ingest"
import { isMcpPath, mountMcp } from "./mcp/routes"
import { makeBudgetPort, makeRecallSink, recordThinkSpend } from "./ports"
import {
  handleAuditExport,
  handleBreakGlassRead,
  handleCaptureTurn,
  handleFinalizeSession,
  handleForgetFact,
  handleGetSessionContext,
  handleMemoryReview,
  handleRecall,
  runAuditExportSweep,
  runIdlePromotionSweep,
  type SessionBindings,
  sessionServicesFor,
} from "./sessions"

/** Content types the slice accepts directly (passthrough + normalize; §4.3). */
const ALLOWED_CONTENT_TYPES = new Set(["text/markdown", "text/plain"])

/** A function that builds the per-request scoped service bundle (injectable for tests). */
export type MakeServices = (env: ApiBindings, principal: Principal) => ScopedServices

export interface CreateAppOptions {
  /** Inject a no-network Clerk verifier (tests); default = real Clerk JWKS path. */
  clerkVerifier?: ClerkVerifier
  /** Inject a service builder (tests fake Vectorize/AI); default = `createScopedServices`. */
  makeServices?: MakeServices
  /**
   * Run `runBatchIngest` INLINE on the `/ingest` request instead of dispatching the durable
   * Workflow. Default `false` (deploy dispatches `env.BATCH_INGEST`). The e2e slice + local
   * dev set this `true` so ingestion completes synchronously and deterministically — the
   * pool-workers harness DOES bind `BATCH_INGEST`, so binding-presence alone can't select the
   * inline path, and a real Workflow is async/durable (not ready by the time the POST returns).
   */
  inlineIngest?: boolean
}

type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

const baseContentType = (raw: string | undefined): string =>
  (raw ?? "text/markdown").split(";")[0]?.trim().toLowerCase() ?? "text/markdown"

/** Drop an absent `scope` so the value satisfies `exactOptionalPropertyTypes` (no `undefined`). */
const retrievalInput = (parsed: {
  query: string
  topK: number
  scope?: string | undefined
}): { query: string; topK: number; scope?: string } => ({
  query: parsed.query,
  topK: parsed.topK,
  ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
})

/** Compose the concrete `SearchDeps` (budget 429 pre-check + waitUntil recall sink). */
const buildSearchDeps = (
  services: ScopedServices,
  waitUntil: (promise: Promise<unknown>) => void,
): SearchDeps => ({
  db: services.db,
  vectors: services.vectors,
  ai: services.ai,
  budget: makeBudgetPort(services),
  recall: makeRecallSink(services, waitUntil, "rest"),
})

/** Compose the `GraphOpDeps` (graph node-space + entity vectors + read-path embed) from services. */
const buildGraphDeps = (services: ScopedServices): GraphOpDeps => ({
  graph: services.graph,
  entityVectors: services.entityVectors,
  ai: { embed: services.ai.embed },
})

/**
 * A graph op with its handler type-erased for generic REST dispatch. `GRAPH_OPS` is a tuple of
 * differently-typed `BoundOp`s; mounting them through one loop needs a single uniform shape.
 */
interface ErasedGraphOp {
  def: AnyOpDef
  handler: (ctx: { deps: GraphOpDeps; principal: Principal }, input: unknown) => Promise<unknown>
}

/** Every bound graph op keyed by its frozen op name (the registry only holds handler-free defs). */
const GRAPH_OP_BY_NAME = new Map<string, ErasedGraphOp>(
  (GRAPH_OPS as unknown as readonly ErasedGraphOp[]).map((op) => [op.def.name, op]),
)

/** REST path → graph op name (PRD §9 graph reads); each is mounted via the generic dispatcher. */
const GRAPH_ROUTES: readonly (readonly [string, string])[] = [
  ["/graph/traverse", "traverse_graph"],
  ["/graph/links", "get_links"],
  ["/graph/backlinks", "get_backlinks"],
  ["/graph/tags", "get_tags"],
  ["/graph/timeline", "get_timeline"],
  ["/graph/entities", "list_entities"],
  ["/graph/orphans", "find_orphans"],
  ["/graph/search_entities", "search_entities"],
]

/**
 * The Worker's op registry is the SINGLE source from `@brain/surface` (search + graph + session +
 * governance + admin), re-exported here so the MCP DO + the integration smoke import it from one
 * place — the MCP/tRPC/CLI catalog cannot drift from a divergent local copy.
 */
export { buildRegistry } from "@brain/surface"

/**
 * Default service factory: reads `AI_PROVIDER` from env and builds `OpenAiCompatConfig` when
 * `=== "openai-compatible"`, provided `OPENAI_BASE_URL` and `OPENAI_API_KEY` are also set.
 * Falls back to Workers AI (`@cf`) when the provider is unset or any required secret is absent
 * (silently — a misconfigured BYO provider should be caught via `wrangler secret put` tooling).
 */
const makeScopedServicesFromEnv: MakeServices = (env, principal) => {
  let openaiConfig: OpenAiCompatConfig | undefined
  if (
    env.AI_PROVIDER === "openai-compatible" &&
    env.OPENAI_BASE_URL !== undefined &&
    env.OPENAI_API_KEY !== undefined
  ) {
    openaiConfig = {
      baseUrl: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_EMBED_MODEL !== undefined ? { embedModel: env.OPENAI_EMBED_MODEL } : {}),
      ...(env.OPENAI_GEN_MODEL !== undefined ? { genModel: env.OPENAI_GEN_MODEL } : {}),
      ...(env.OPENAI_EXTRACT_MODEL !== undefined ? { extractModel: env.OPENAI_EXTRACT_MODEL } : {}),
      ...(env.OPENAI_RERANK_MODEL !== undefined ? { rerankModel: env.OPENAI_RERANK_MODEL } : {}),
    }
  }
  return createScopedServices(env, principal, openaiConfig !== undefined ? { openaiConfig } : {})
}

export const createApp = (options: CreateAppOptions = {}): Hono<AppEnv> => {
  const makeServices: MakeServices = options.makeServices ?? makeScopedServicesFromEnv
  const app = new Hono<AppEnv>()

  // ── Edge auth (invariant 17): resolve ONCE, attach the Principal, 401 on failure. ──
  //    The MCP transports (`/mcp`, `/mcp/:slug`) OWN their (slug-aware) edge auth — the `:slug` is
  //    the active-tenant selector, which this generic resolver cannot see — so they are skipped
  //    here and resolve their own Principal in `mountMcp` (still `resolvePrincipal` at the edge).
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || isMcpPath(c.req.path) || isDeviceFlowPath(c.req.path))
      return next()
    const principal = await resolvePrincipal(c.env, c.req.raw, {
      ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
    })
    c.set("principal", principal)
    return next()
  })

  app.get("/health", (c) => c.json({ status: "ok" }))

  // ── CLI OAuth 2.1 device-flow (RFC 8628): /device_authorization, /activate, /token. ──
  mountDeviceFlow(app, {
    ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
  })

  // ── MCP transports (PRD §9.2): agent-facing op-registry catalog over the resolved Principal. ──
  mountMcp(app, { ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}) })

  // ── tRPC typed surface (dashboard + CLI) — the generated `appRouter` mounted under the SAME
  //    edge-resolved Principal (invariant 17). The router is built from the single op-registry
  //    (`@brain/surface`), so it cannot drift from the MCP + CLI surfaces. REST routes below are
  //    unchanged (Hono owns webhooks/upload/MCP transport; tRPC owns the typed app surface). ──
  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      endpoint: "/trpc",
      // The Hono adapter types the context as `Record<string, unknown>`; the runtime object IS the
      // `SurfaceContext` the router's procedures consume (cast only bridges the adapter's generic).
      createContext: (_opts, c) =>
        createTrpcContext(
          c.env as unknown as SurfaceEnv,
          c.get("principal") as Principal,
          (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise),
        ) as unknown as Record<string, unknown>,
    }),
  )

  // ── POST /ingest — markdown → fingerprint → R2 → documents(pending) → BatchIngest. ──
  app.post("/ingest", async (c) => {
    const principal = c.get("principal")
    const services = makeServices(c.env, principal)

    const buf = await c.req.arrayBuffer()
    if (buf.byteLength > INGEST_WEBHOOK_MAX_BYTES) {
      throw new HttpError(413, `body exceeds the ${INGEST_WEBHOOK_MAX_BYTES}-byte /ingest cap`)
    }
    const contentType = baseContentType(c.req.header("content-type"))
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new HttpError(
        415,
        `unsupported content type "${contentType}" (slice accepts markdown/text)`,
      )
    }
    const raw = new TextDecoder().decode(buf)
    const scope = c.req.query("scope") ?? undefined

    // Fingerprint over the EXTRACTED markdown (formatting-insensitive dedup, invariant 15).
    const markdown = toMarkdown(raw, contentType)
    const fp = await fingerprint(markdown)
    const slug = c.req.query("slug") ?? `doc-${fp.slice(0, 12)}`
    const documentId = crypto.randomUUID()
    const r2Key = `documents/${documentId}`

    // Durable dedup: the INSERT trips the (tenant,scope,fingerprint) / (tenant,slug) UNIQUE
    // index on a repeat → catch the conflict, treat as already-ingested (no error, no re-run).
    let docId: string
    try {
      docId = await services.db.insertDocument({
        id: documentId,
        slug,
        fingerprint: fp,
        contentType,
        bodyR2Key: r2Key,
        status: "pending",
        ...(scope !== undefined ? { scope } : {}),
      })
    } catch {
      const existing = (await services.db.listDocuments()).find(
        (doc) => doc.fingerprint === fp || doc.slug === slug,
      )
      return c.json({
        documentId: existing?.id ?? null,
        slug: existing?.slug ?? slug,
        status: "duplicate" as const,
        chunkCount: 0,
        deduped: true,
      })
    }

    // Body lives ONLY in R2 (invariant 13); write it after the row exists.
    await services.blobs.put(r2Key, raw)

    const ingestParams: BatchIngestParams = {
      documentId: docId,
      r2Key,
      contentType,
      scope: scope ?? null,
    }

    // Trigger the durable Workflow at DEPLOY (binding present); run inline in test/local.
    const workflow = options.inlineIngest ? undefined : c.env.BATCH_INGEST
    if (workflow) {
      await workflow.create({
        id: `ingest-${principal.tenantId}-${fp}`,
        params: { principal, ingest: ingestParams },
      })
      return c.json({ documentId: docId, slug, status: "accepted" as const, chunkCount: 0 })
    }

    const result = await runBatchIngest(services, ingestParams)
    return c.json({ ...result, slug })
  })

  // ── POST /think — hybrid search + token-budget-guarded cited synthesis. ──
  app.post("/think", async (c) => {
    const principal = c.get("principal")
    const services = makeServices(c.env, principal)
    const parsed = THINK_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid think input")
    const deps = buildSearchDeps(services, (p) => c.executionCtx.waitUntil(p))
    const out = await thinkOp.handler({ deps, principal }, retrievalInput(parsed.data))
    c.executionCtx.waitUntil(recordThinkSpend(services, out))
    return c.json(out)
  })

  // ── POST /search — cheap hybrid (rerank off). ──
  app.post("/search", async (c) => {
    const principal = c.get("principal")
    const services = makeServices(c.env, principal)
    const parsed = SEARCH_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid search input")
    const deps = buildSearchDeps(services, (p) => c.executionCtx.waitUntil(p))
    const out = await searchOp.handler({ deps, principal }, retrievalInput(parsed.data))
    return c.json(out)
  })

  // ── Graph reads (P4) — generic dispatch over the registered GRAPH_OPS bound handlers. ──
  // Each op validates with its own frozen Zod contract, then runs over `GraphOpDeps` built from
  // the tenant-scoped services (graph + entity vectors never see a raw binding).
  for (const [path, opName] of GRAPH_ROUTES) {
    const op = GRAPH_OP_BY_NAME.get(opName)
    if (op === undefined) continue
    app.post(path, async (c) => {
      const principal = c.get("principal")
      const services = makeServices(c.env, principal)
      const parsed = op.def.input.safeParse(await c.req.json())
      if (!parsed.success) throw new HttpError(400, `invalid ${opName} input`)
      const out = await op.handler({ deps: buildGraphDeps(services), principal }, parsed.data)
      return c.json(out as Record<string, unknown>)
    })
  }

  // ── Sessions + governance (P5) — mount the exported handlers on `sessionServicesFor` + the
  //    durable break-glass audit sink. A PRESENT sink is the gate (break-glass fails closed when
  //    absent); `createBreakGlassAuditSink` writes one `memory_audit` row per break-glass read
  //    (the raw DB write lives in `@brain/db`, never apps/api). ──
  const sessionServices = (
    env: ApiBindings,
    principal: Principal,
  ): ReturnType<typeof sessionServicesFor> =>
    sessionServicesFor(env, principal, { breakGlassAudit: createBreakGlassAuditSink(env) })

  app.post("/sessions/capture", async (c) => {
    const principal = c.get("principal")
    const parsed = CAPTURE_TURN_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid capture_turn input")
    // Zod `.optional()` widens to `| undefined`; the handler spread-guards each field internally,
    // so narrow to its param type (absent keys stay absent — no `undefined` is forced through).
    const input = parsed.data as Parameters<typeof handleCaptureTurn>[1]
    return c.json(await handleCaptureTurn(sessionServices(c.env, principal), input))
  })

  app.post("/sessions/:id/finalize", async (c) => {
    const principal = c.get("principal")
    const out = await handleFinalizeSession(
      c.env,
      sessionServices(c.env, principal),
      principal,
      c.req.param("id"),
    )
    return c.json(out)
  })

  app.get("/sessions/:id/context", async (c) => {
    const principal = c.get("principal")
    const snapshotId = c.req.query("snapshot")
    const out = await handleGetSessionContext(sessionServices(c.env, principal), {
      brainSessionId: c.req.param("id"),
      ...(snapshotId !== undefined ? { snapshotId } : {}),
    })
    return c.json(out)
  })

  app.post("/recall", async (c) => {
    const principal = c.get("principal")
    const parsed = RECALL_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid recall input")
    const input = parsed.data as Parameters<typeof handleRecall>[1]
    const out = await handleRecall(
      sessionServices(c.env, principal),
      input,
      (p) => c.executionCtx.waitUntil(p),
      "rest",
    )
    return c.json(out)
  })

  app.post("/facts/:id/forget", async (c) => {
    const principal = c.get("principal")
    const factId = Number(c.req.param("id"))
    if (!Number.isInteger(factId)) throw new HttpError(400, "invalid fact id")
    return c.json(await handleForgetFact(sessionServices(c.env, principal), factId))
  })

  app.post("/memory/review", async (c) => {
    const principal = c.get("principal")
    const parsed = MEMORY_REVIEW_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid memory_review input")
    const input = parsed.data as Parameters<typeof handleMemoryReview>[1]
    return c.json(await handleMemoryReview(sessionServices(c.env, principal), input))
  })

  app.post("/memory/break-glass", async (c) => {
    const principal = c.get("principal")
    const parsed = BREAK_GLASS_READ_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid break_glass_read input")
    return c.json(await handleBreakGlassRead(sessionServices(c.env, principal), parsed.data))
  })

  app.post("/audit/export", async (c) => {
    const principal = c.get("principal")
    const parsed = AUDIT_EXPORT_OP.input.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, "invalid audit_export input")
    return c.json(await handleAuditExport(sessionServices(c.env, principal), parsed.data))
  })

  // Map typed failures to their HTTP status (401 auth, 429 cost-cap, 4xx input).
  app.onError((err, _c) => {
    if (err instanceof AuthError || err instanceof HttpError || err instanceof CostCeilingError) {
      return Response.json({ error: err.message }, { status: err.status })
    }
    return Response.json({ error: "internal error" }, { status: 500 })
  })

  return app
}

/**
 * The full deployed Worker env: the frozen `ApiBindings` plus the deploy-only Workflows/Queues
 * the P3/P5 cron + queue handlers reach (all OPTIONAL — absent in the local test harness).
 */
type WorkerBindings = ApiBindings & SessionBindings & BackfillBindings

/**
 * `scheduled()` (every 5 minutes): the P5 idle-promotion + audit-export sweeps and the P3
 * re-embed sweep. Each builds its own SYSTEM principal + scoped services inside `@brain/db`
 * (the binding removes the wire, not the gate). The audit-export cursor store is built in
 * `@brain/db` (`createAuditExportCursorStore`, OAUTH_KV-backed) — apps/api may not name a raw
 * binding (boundary-lint). The re-embed sweep enqueues references onto `REEMBED_QUEUE`.
 */
const scheduled = async (
  _controller: ScheduledController,
  env: WorkerBindings,
  ctx: ExecutionContext,
): Promise<void> => {
  const cursors = createAuditExportCursorStore(env)
  ctx.waitUntil(
    Promise.all([
      runIdlePromotionSweep(env),
      runAuditExportSweep(env, cursors),
      runReembedSweep(env, {
        enqueue: async (message) => {
          await env.REEMBED_QUEUE?.send(message)
        },
      }),
    ]),
  )
}

/**
 * `queue()`: dispatch by queue name — `brain-backfill` → `handleBackfillQueue` (enumerate→consume
 * →capture), `brain-reembed` → `handleReembedQueue` (re-embed one chunk in place). Each handler
 * acks/retries per message and routes exhausted messages to its DLQ.
 */
const queue = async (
  batch: MessageBatch<BackfillMessage | ReembedMessage>,
  env: WorkerBindings,
): Promise<void> => {
  if (batch.queue === "brain-backfill") {
    await handleBackfillQueue(batch as MessageBatch<BackfillMessage>, env)
  } else if (batch.queue === "brain-reembed") {
    await handleReembedQueue(batch as MessageBatch<ReembedMessage>, env)
  }
}

/** The deployed Worker: real Clerk path + real scoped services + cron/queue handlers. */
const app = createApp()

export default {
  fetch: (req: Request, env: WorkerBindings, ctx: ExecutionContext): Response | Promise<Response> =>
    app.fetch(req, env, ctx),
  scheduled,
  queue,
}

// Every Workflow class the wrangler `workflows` bindings reference MUST be exported from `main`.
export { EnumeratorWorkflow } from "./backfill"
export { EntityExtractionWorkflow } from "./entity-extraction"
// The MCP Durable Object class the wrangler `durable_objects` binding references (PRD §9.2).
export { BrainMCP } from "./mcp/agent"
export { SessionPromoteWorkflow } from "./sessions"
export { BatchIngestWorkflow } from "./workflow"

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
  normalizePath,
  type OpenAiCompatConfig,
  RECALL_OP,
  resolvePrincipal,
  type ScopedServices,
  type SearchDeps,
  searchOp,
  thinkOp,
} from "@brain/db"
import { fingerprint, toMarkdown, workflowInstanceId } from "@brain/ingest"
import {
  type AnyOpDef,
  INGEST_WEBHOOK_MAX_BYTES,
  MAX_BODY_BYTES,
  type Principal,
  SEARCH_OP,
  THINK_OP,
} from "@brain/shared"
import { appRouter, createTrpcContext, type SurfaceEnv } from "@brain/surface"
import OAuthProvider from "@cloudflare/workers-oauth-provider"
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
import { mcpApiHandler } from "./mcp/oauth-handler"
import { isMcpPath, mountMcp } from "./mcp/routes"
import { mountOAuthHandlers } from "./oauth/authorize"
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
import { handleVaultEventQueue, type R2EventMessage } from "./vault-events/consume"

/**
 * Parse a comma-separated tags string (or undefined) into a trimmed, non-empty string array.
 * Accepts "tag1, tag2" or "tag1" → ["tag1", "tag2"] / ["tag1"].
 */
const parseTags = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) return undefined
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  return tags.length > 0 ? tags : undefined
}

/** Content types the slice accepts directly (passthrough + normalize; §4.3). */
const ALLOWED_CONTENT_TYPES = new Set(["text/markdown", "text/plain"])

/**
 * Content types handled via CF Workers AI `toMarkdown` conversion (the `ai.toMarkdown`
 * chokepoint in `ScopedServices`). The upload endpoint accepts these in addition to the
 * text passthrough types above.
 */
const AI_MARKDOWN_TYPES = new Set([
  "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** Map a content-type to a short extension for the `env.AI.toMarkdown` `name` field. */
const extForContentType = (contentType: string): string => {
  const map: Record<string, string> = {
    "text/html": "html",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  }
  return map[contentType] ?? "bin"
}

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

/** Drop absent optionals so the value satisfies `exactOptionalPropertyTypes` (no `undefined`). */
const retrievalInput = (parsed: {
  query: string
  topK: number
  scope?: string | undefined
  path?: string | undefined
  tag?: string | undefined
}): { query: string; topK: number; scope?: string; path?: string; tag?: string } => ({
  query: parsed.query,
  topK: parsed.topK,
  ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
  ...(parsed.path !== undefined ? { path: parsed.path } : {}),
  ...(parsed.tag !== undefined ? { tag: parsed.tag } : {}),
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
  //    The MCP transports (`/mcp`, `/mcp/:slug`) OWN their edge auth — either via mountMcp
  //    (direct Hono path, used in tests) or via the OAuthProvider apiHandler + resolveExternalToken
  //    (production). The OAuth endpoints (/authorize, /callback) are pre-auth (the user is logging
  //    in), and the device-flow paths bypass auth at the protocol level (RFC 8628).
  app.use("*", async (c, next) => {
    if (
      c.req.path === "/health" ||
      c.req.path === "/authorize" ||
      c.req.path === "/authorize/orgs" || // org picker endpoint — carries JWT in body, not header
      c.req.path === "/callback" ||
      isMcpPath(c.req.path) ||
      isDeviceFlowPath(c.req.path)
    )
      return next()
    const principal = await resolvePrincipal(c.env, c.req.raw, {
      ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
    })
    c.set("principal", principal)
    return next()
  })

  app.get("/health", (c) => c.json({ status: "ok" }))

  // ── OAuth 2.1 authorize + callback (Connect with OAuth): /authorize, /callback. ──
  //    Mounted BEFORE device-flow so the auth bypass list comment above is coherent. In the
  //    production OAuthProvider wrapper, /authorize is served as `defaultHandler` (the OAuthProvider
  //    does NOT handle it natively). /callback completes the Clerk sign-in → completeAuthorization.
  mountOAuthHandlers(app, {
    ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
  })

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
    const tags = parseTags(c.req.query("tags") ?? undefined)
    const path = normalizePath(c.req.query("path") ?? undefined)

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
        ...(tags !== undefined ? { tags } : {}),
        ...(path !== null ? { path } : {}),
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
      ...(path !== null ? { path } : {}),
    }

    // Trigger the durable Workflow at DEPLOY (binding present); run inline in test/local.
    const workflow = options.inlineIngest ? undefined : c.env.BATCH_INGEST
    if (workflow) {
      await workflow.create({
        id: await workflowInstanceId(`ingest-${principal.tenantId}-${fp}`),
        params: { principal, ingest: ingestParams },
      })
      return c.json({ documentId: docId, slug, status: "accepted" as const, chunkCount: 0 })
    }

    const result = await runBatchIngest(services, ingestParams)
    return c.json({ ...result, slug })
  })

  // ── POST /documents — browser / dashboard document upload (up to MAX_BODY_BYTES 8MiB). ──
  //    Extends the /ingest pipeline to accept binary/HTML bodies via the `ai.toMarkdown`
  //    chokepoint in `ScopedServices`. Text types are handled inline (same as /ingest).
  //    Binary/HTML types are extracted to markdown first, then stored in R2 + run through
  //    the same fingerprint → documents row → BatchIngest pipeline. The raw /ingest webhook
  //    (256 KiB cap) is left unchanged for programmatic callers.
  //
  //    NOTE: Raw bytes are NOT stored in R2 — the extracted markdown is stored instead.
  //    This is intentional: ai.toMarkdown for images uses LLM-generated descriptions that
  //    are non-deterministic. Storing the extraction output deduplicates correctly and
  //    avoids calling ai.toMarkdown twice (once for fingerprint + once in runBatchIngest).
  app.post("/documents", async (c) => {
    const principal = c.get("principal")
    const services = makeServices(c.env, principal)

    const buf = await c.req.arrayBuffer()
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new HttpError(413, `body exceeds the ${MAX_BODY_BYTES}-byte /documents cap`)
    }
    const contentType = baseContentType(c.req.header("content-type"))
    const scope = c.req.query("scope") ?? undefined
    const title = c.req.query("title") ?? undefined
    const tags = parseTags(c.req.query("tags") ?? undefined)
    const path = normalizePath(c.req.query("path") ?? undefined)

    // Extract to markdown. Text types → passthrough normalize; binary/HTML → ai.toMarkdown.
    let markdown: string
    if (ALLOWED_CONTENT_TYPES.has(contentType)) {
      const raw = new TextDecoder().decode(buf)
      markdown = toMarkdown(raw, contentType)
    } else if (AI_MARKDOWN_TYPES.has(contentType)) {
      if (!services.ai.toMarkdown) {
        throw new HttpError(
          415,
          `content type "${contentType}" requires the AI document converter (ai.toMarkdown), which is unavailable on this provider`,
        )
      }
      const ext = extForContentType(contentType)
      const filename = c.req.header("x-filename") ?? `upload.${ext}`
      markdown = await services.ai.toMarkdown(filename, buf)
    } else {
      throw new HttpError(
        415,
        `unsupported content type "${contentType}" — accepted: text/markdown, text/plain, text/html, application/pdf, DOCX, image/*`,
      )
    }

    if (markdown.trim().length === 0) {
      throw new HttpError(422, "extracted markdown is empty — nothing to ingest")
    }

    // Fingerprint + slug over the extracted markdown (formatting-insensitive dedup, invariant 15).
    const fp = await fingerprint(markdown)
    const slug = c.req.query("slug") ?? `doc-${fp.slice(0, 12)}`
    const documentId = crypto.randomUUID()
    const r2Key = `documents/${documentId}`

    // Durable dedup: UNIQUE index on (tenant,scope,fingerprint)/(tenant,slug) → catch conflict.
    let docId: string
    try {
      docId = await services.db.insertDocument({
        id: documentId,
        slug,
        fingerprint: fp,
        // Always store as text/markdown — binary bodies are already extracted above.
        contentType: "text/markdown",
        bodyR2Key: r2Key,
        status: "pending",
        ...(scope !== undefined ? { scope } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(path !== null ? { path } : {}),
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

    // Body (extracted markdown) lives in R2; the pipeline reads it from there (invariant 13).
    await services.blobs.put(r2Key, markdown)

    const ingestParams: BatchIngestParams = {
      documentId: docId,
      r2Key,
      contentType: "text/markdown",
      scope: scope ?? null,
      ...(path !== null ? { path } : {}),
    }

    const workflow = options.inlineIngest ? undefined : c.env.BATCH_INGEST
    if (workflow) {
      await workflow.create({
        id: await workflowInstanceId(`ingest-${principal.tenantId}-${fp}`),
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
    const memoryPath = c.req.query("memoryPath")
    const out = await handleGetSessionContext(sessionServices(c.env, principal), {
      brainSessionId: c.req.param("id"),
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      ...(memoryPath !== undefined ? { memoryPath } : {}),
      memoryPrefix: c.req.query("memoryPrefix") === "true",
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
 * `queue()`: dispatch by queue name:
 *   - `brain-backfill`     → `handleBackfillQueue` (enumerate→consume→capture)
 *   - `brain-reembed`      → `handleReembedQueue` (re-embed one chunk in place)
 *   - `brain-vault-events` → `handleVaultEventQueue` (R2 event notification → incremental ingest)
 * Each handler acks/retries per message and routes exhausted messages to its DLQ.
 */
const queue = async (
  batch: MessageBatch<BackfillMessage | ReembedMessage | R2EventMessage>,
  env: WorkerBindings,
): Promise<void> => {
  if (batch.queue === "brain-backfill") {
    await handleBackfillQueue(batch as MessageBatch<BackfillMessage>, env)
  } else if (batch.queue === "brain-reembed") {
    await handleReembedQueue(batch as MessageBatch<ReembedMessage>, env)
  } else if (batch.queue === "brain-vault-events") {
    await handleVaultEventQueue(batch as MessageBatch<R2EventMessage>, env)
  }
}

/**
 * Build the full OAuth 2.1-wrapped Worker for a given option set.
 *
 * The `OAuthProvider` is the outermost fetch handler:
 *   - `/.well-known/oauth-authorization-server` (discovery) → served by OAuthProvider
 *   - `/register`   (RFC 7591 dynamic client registration) → served by OAuthProvider
 *   - `/oauth/token` (authorization_code + refresh)         → served by OAuthProvider
 *   - `/mcp`, `/mcp/:slug` (protected MCP resource)        → OAuthProvider validates token →
 *       forwards to `mcpApiHandler` with `ctx.props.principal`
 *   - everything else (REST API, device-flow, /authorize, /callback) → `defaultHandler`
 *     (the Hono app created by `createApp`)
 *
 * `resolveExternalToken` bridges legacy bearer tokens (Clerk JWT / `bk_` / `bdev_`) so that
 * existing callers of `/mcp` with a non-OAuth bearer token continue to work unchanged.
 *
 * NOTE: `/oauth/token` is intentionally distinct from `/token` (the device-flow token endpoint,
 * RFC 8628). Using the same path would create a grant-type conflict; the discovery document
 * advertises `/oauth/token` so MCP clients resolve it automatically.
 */
// OAuthProvider<Env> defaults to Cloudflare.Env which is test-augmented with MIGRATIONS
// (test/env.d.ts). Our runtime bindings lack that key, so we use `any` as Env — the library
// uses `env: any` internally, making this safe.
// biome-ignore lint/suspicious/noExplicitAny: test env augmentation incompatibility (see above)
type AnyOAuthProvider = OAuthProvider<any>

export const createOAuthWorker = (options: CreateAppOptions = {}): AnyOAuthProvider => {
  const honoApp = createApp(options)

  return new OAuthProvider({
    // Protected resource: all /mcp requests require a valid access token.
    // biome-ignore lint/suspicious/noExplicitAny: see AnyOAuthProvider comment above
    apiHandlers: { "/mcp": mcpApiHandler as any },

    // Everything else falls through to the Hono app (REST API, device-flow, /authorize, etc.).
    defaultHandler: {
      fetch: (req: Request, env: unknown, ctx: ExecutionContext) =>
        honoApp.fetch(req, env as ApiBindings, ctx),
      // biome-ignore lint/suspicious/noExplicitAny: see AnyOAuthProvider comment above
    } as any,

    // OAuth 2.1 endpoints advertised in the discovery document.
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",

    // Scopes supported by this provider.
    scopesSupported: ["brain:read", "brain:write", "brain:admin"],

    // S256 PKCE only (OAuth 2.1 §5); no plain, no implicit.
    allowPlainPKCE: false,
    allowImplicitFlow: false,

    /**
     * Bridge for legacy bearer tokens on the protected `/mcp` resource.
     *
     * When the OAuthProvider cannot find the token in its KV (i.e. it is NOT an OAuth-issued
     * access token), it calls this callback. We delegate to the existing `resolvePrincipal`
     * which handles Clerk JWT / `bk_` API keys / `bdev_` machine tokens. The resolved
     * Principal is stored as `props` and forwarded to `mcpApiHandler` — exactly the same
     * shape as the OAuth grant props.
     *
     * The slug is extracted from the URL path so `resolvePrincipal` honours the active-tenant
     * selector on `/mcp/:slug` requests (matching `mountMcp`'s existing behaviour).
     */
    resolveExternalToken: async ({ token: _token, request, env }) => {
      try {
        const url = new URL(request.url)
        const slugMatch = url.pathname.match(/^\/mcp\/([^/]+)\/?$/)
        const activeTenantSlug = slugMatch?.[1]

        const principal = await resolvePrincipal(env as unknown as WorkerBindings, request, {
          ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
          ...(activeTenantSlug ? { activeTenantSlug } : {}),
        })
        return { props: { principal } }
      } catch {
        return null
      }
    },
  })
}

/** The deployed Worker: OAuth-wrapped Hono app + cron/queue handlers. */
const oauthWorker = createOAuthWorker()

export default {
  fetch: (req: Request, env: WorkerBindings, ctx: ExecutionContext): Response | Promise<Response> =>
    oauthWorker.fetch(req, env, ctx),
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

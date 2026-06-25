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
  AuthError,
  type ClerkVerifier,
  createScopedServices,
  resolvePrincipal,
  type ScopedServices,
  type SearchDeps,
  searchOp,
  thinkOp,
} from "@brain/db"
import { fingerprint, toMarkdown } from "@brain/ingest"
import { INGEST_WEBHOOK_MAX_BYTES, type Principal, SEARCH_OP, THINK_OP } from "@brain/shared"
import { Hono } from "hono"
import type { ApiBindings } from "./bindings"
import { HttpError } from "./http"
import { type BatchIngestParams, runBatchIngest } from "./ingest"
import { makeBudgetPort, makeRecallSink, recordThinkSpend } from "./ports"

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

export const createApp = (options: CreateAppOptions = {}): Hono<AppEnv> => {
  const makeServices: MakeServices = options.makeServices ?? createScopedServices
  const app = new Hono<AppEnv>()

  // ── Edge auth (invariant 17): resolve ONCE, attach the Principal, 401 on failure. ──
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next()
    const principal = await resolvePrincipal(c.env, c.req.raw, {
      ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
    })
    c.set("principal", principal)
    return next()
  })

  app.get("/health", (c) => c.json({ status: "ok" }))

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

  // Map typed failures to their HTTP status (401 auth, 429 cost-cap, 4xx input).
  app.onError((err, _c) => {
    if (err instanceof AuthError || err instanceof HttpError) {
      return Response.json({ error: err.message }, { status: err.status })
    }
    return Response.json({ error: "internal error" }, { status: 500 })
  })

  return app
}

/** The deployed Worker: real Clerk path + real scoped services. */
const app = createApp()

export default app
export { BatchIngestWorkflow } from "./workflow"

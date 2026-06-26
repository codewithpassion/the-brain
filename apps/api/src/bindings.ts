/**
 * `ApiBindings` — the Worker env as seen by `apps/api`.
 *
 * The authoritative binding contract is the frozen `BrainBindings` (packages/db). The api-local
 * extensions are:
 *   - DEPLOY-ONLY `BATCH_INGEST` Workflows binding (no pool-workers emulation)
 *   - `OAUTH_PROVIDER` injected by `@cloudflare/workers-oauth-provider` when the Worker is
 *     wrapped by `OAuthProvider`; absent in tests that call `createApp()` directly.
 *   - `CLERK_PUBLISHABLE_KEY` public Clerk key used in the /authorize sign-in HTML page.
 *
 * `Workflow` / `DurableObjectNamespace` are runtime binding types and are NOT banned by the
 * boundary-lint (`D1Database`/`Vectorize`/`R2Bucket` are the banned raw binding types).
 */
import type { BrainBindings } from "@brain/db"
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import type { EntityExtractionWorkflowParams } from "./entity-extraction"
import type { BatchIngestWorkflowParams } from "./ingest"

export type ApiBindings = BrainBindings & {
  /** Deploy-only Workflows binding; absent locally (see module doc). */
  BATCH_INGEST?: Workflow<BatchIngestWorkflowParams>
  /** Deploy-only Workflows binding for Phase-4 KG extraction; absent locally. */
  ENTITY_EXTRACTION?: Workflow<EntityExtractionWorkflowParams>
  /**
   * The `BrainMCP` Durable Object namespace (PRD §9.2). Declared in `wrangler.jsonc` and emulated
   * locally by pool-workers, so it is PRESENT in tests (unlike the Workflows bindings). The
   * `McpAgent.serve`/`serveSSE` handlers resolve it from `env` by binding name (`"BRAIN_MCP"`).
   * `DurableObjectNamespace` is not a boundary-lint-banned raw-binding type.
   */
  BRAIN_MCP: DurableObjectNamespace

  /**
   * OAuth 2.1 provider helper — injected by `OAuthProvider.fetch()` into the env before calling
   * `defaultHandler` (and, via `resolveExternalToken`, into all API-route handlers). ABSENT when
   * the app is called directly in tests (`createApp()`); the `/authorize` + `/callback` handlers
   * guard against this with a graceful 503.
   */
  OAUTH_PROVIDER?: OAuthHelpers

  /**
   * Clerk publishable key (public, non-secret) — used in the `/authorize` HTML sign-in page to
   * initialise Clerk's browser JS SDK. Set via `wrangler.jsonc` vars. Absent in the test harness
   * (the /authorize HTML is not exercised there — the test calls /callback directly).
   */
  CLERK_PUBLISHABLE_KEY?: string

  // ── BYO / openai-compatible provider secrets (set via `wrangler secret put`) ──────────────
  // These are NOT in wrangler.jsonc (they are secrets, not vars) and therefore absent from the
  // generated `Env` type. They are typed here so `makeScopedServicesFromEnv` can read them
  // when `AI_PROVIDER === "openai-compatible"`. All are optional — absent ⇒ Workers AI path.
  /** Base URL of the openai-compatible endpoint (required when AI_PROVIDER=openai-compatible). */
  OPENAI_BASE_URL?: string
  /** API key for the openai-compatible provider (set via `wrangler secret put OPENAI_API_KEY`). */
  OPENAI_API_KEY?: string
  /** Override embedding model (default: gateway EMBEDDING_MODEL constant). */
  OPENAI_EMBED_MODEL?: string
  /** Override generation model (default: gateway GENERATION_MODEL constant). */
  OPENAI_GEN_MODEL?: string
  /** Override extraction model (default: gateway EXTRACT_MODEL constant). */
  OPENAI_EXTRACT_MODEL?: string
  /** Override rerank model (default: gateway RERANK_MODEL constant). */
  OPENAI_RERANK_MODEL?: string
}

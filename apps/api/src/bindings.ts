/**
 * `ApiBindings` — the Worker env as seen by `apps/api`.
 *
 * The authoritative binding contract is the frozen `BrainBindings` (packages/db). The single
 * api-local extension is the DEPLOY-ONLY `BATCH_INGEST` Workflows binding: it is NOT declared
 * in the test-loaded `wrangler.jsonc` (Workflows have no local pool-workers emulation), so it
 * is OPTIONAL here. When absent (local/test) the `/ingest` route runs `runBatchIngest`
 * inline; when present (deploy) it dispatches the durable `BatchIngestWorkflow`.
 *
 * `Workflow` is a runtime binding type (from `@cloudflare/workers-types`) and is NOT one of
 * the boundary-lint-banned raw binding type names (`D1Database`/`Vectorize`/`R2Bucket`).
 */
import type { BrainBindings } from "@brain/db"
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

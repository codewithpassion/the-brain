/**
 * AI Gateway config helper (PRD §5.1, invariant 16 — attribution).
 *
 * Every `env.AI.run` in the chokepoints routes through AI Gateway carrying
 * `tenant_id` custom metadata so spend is attributable per tenant.
 *
 * Spend enforcement layering (defense-in-depth):
 *   PRIMARY:  app-level `token_spend` 429 pre-check (invariant 16) — fires BEFORE
 *             `env.AI.run` and is the authoritative enforcing cap. For v1's all-@cf/
 *             model set, native Neuron-billed calls are not covered by the Gateway's
 *             own spend-limit feature (BYOK/Unified-Billing rails only), so the
 *             token_spend check is the only real enforcing gate.
 *   SECONDARY: AI Gateway dashboard-configured spend limits + `collectLog: true` +
 *             `cost_limit_usd` in metadata for per-tenant cost attribution. If the
 *             Gateway does reject for budget (e.g., on BYOK rails), chokepoints
 *             surface a typed `GatewayBudgetError` rather than a generic Error.
 *
 * NOTE: `GatewayOptions` (as of @cloudflare/workers-types@4.20260625.1) has NO
 * per-call spend-limit field; spend limits are configured in the CF dashboard. The
 * metadata fields here are attribution hints for the dashboard rollups.
 */
import { MONTHLY_COST_CEILING_USD } from "@brain/shared"

/** The third argument shared by every chokepoint's `env.AI.run` call. */
export interface BrainAiRunOptions {
  gateway: GatewayOptions
}

/**
 * Minimal structural view of the Workers AI binding the chokepoints depend on. Decouples
 * them from the per-model `AiModelList` overload map (which fights literal model ids and
 * `exactOptionalPropertyTypes`); the real `Ai` binding is assignable to it. Outputs are
 * parsed defensively at each call site.
 */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<unknown>
}

/**
 * Config for the openai-compatible provider path (`AI_PROVIDER=openai-compatible`).
 * When set on `AiDeps`, all chokepoints route to the configured base URL via fetch
 * instead of `env.AI.run`. The `fetch` field is injectable so tests can stub calls.
 *
 * Env vars consumed by the app layer to build this config (not read here):
 *   AI_PROVIDER=openai-compatible
 *   OPENAI_BASE_URL=https://...
 *   OPENAI_API_KEY=sk-...
 * Optional per-chokepoint model overrides:
 *   OPENAI_EMBED_MODEL, OPENAI_GEN_MODEL, OPENAI_EXTRACT_MODEL, OPENAI_RERANK_MODEL
 */
export interface OpenAiCompatConfig {
  baseUrl: string
  apiKey: string
  /** Override the embedding model (default: EMBEDDING_MODEL). */
  embedModel?: string
  /** Override the generation model used by gen() (default: GENERATION_MODEL). */
  genModel?: string
  /** Override the extraction model used by genExtract() (default: EXTRACT_MODEL). */
  extractModel?: string
  /** Override the rerank model (default: RERANK_MODEL). */
  rerankModel?: string
  /**
   * Injectable fetch — defaults to `globalThis.fetch`. Set in tests to stub
   * HTTP calls without a real server.
   */
  fetch?: typeof globalThis.fetch
}

/**
 * Typed error surfaced when the AI Gateway rejects a call for budget reasons.
 *
 * The token_spend pre-check is the PRIMARY enforcing cap and should prevent this from
 * firing in production. `GatewayBudgetError` is defense-in-depth: when the Gateway
 * itself rejects a call (e.g., on BYOK rails with a dashboard spend limit), callers
 * receive a typed error they can distinguish from generic AI failures — allowing, e.g.,
 * the Workflow to skip retries on budget exhaustion rather than retrying indefinitely.
 *
 * NOTE: The exact error shape thrown by CF AI Gateway is unverified in this codebase.
 * `isGatewayBudgetError()` uses heuristic message matching. Update when observed live.
 */
export class GatewayBudgetError extends Error {
  readonly code = "GATEWAY_BUDGET_EXCEEDED" as const

  constructor(message = "AI Gateway budget limit exceeded") {
    super(message)
    this.name = "GatewayBudgetError"
  }
}

/** Shared dependency bundle for the AI chokepoints (binding + gateway id + tenant). */
export interface AiDeps {
  ai: AiRunner
  gatewayId: string
  tenantId: string
  /**
   * When set, chokepoints route to the openai-compatible provider via fetch instead of
   * `deps.ai.run`. Corresponds to `AI_PROVIDER=openai-compatible` in the runtime env.
   * The app layer is responsible for reading env vars and constructing this config.
   */
  openaiConfig?: OpenAiCompatConfig
}

/**
 * Heuristic detector for AI Gateway budget rejections (defense-in-depth).
 * Shape unverified — update the patterns when the live error format is observed.
 */
export const isGatewayBudgetError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes("budget") || msg.includes("spend limit") || msg.includes("cost limit")
}

/**
 * Build the AI Gateway `run` options for a chokepoint call. Enables `collectLog` so
 * per-call costs are tracked in the CF AI Gateway dashboard, and surfaces `tenant_id` +
 * `cost_limit_usd` in metadata for per-tenant spend attribution.
 */
export const aiGateway = (gatewayId: string, tenantId: string): BrainAiRunOptions => ({
  gateway: {
    id: gatewayId,
    collectLog: true,
    metadata: {
      tenant_id: tenantId,
      cost_limit_usd: MONTHLY_COST_CEILING_USD,
    },
  },
})

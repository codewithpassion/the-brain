/**
 * AI Gateway config helper (PRD §5.1, invariant 16 — attribution).
 *
 * Every `env.AI.run` in the chokepoints routes through AI Gateway carrying
 * `tenant_id` custom metadata so spend is attributable per tenant. In v1 the Gateway is
 * attribution-only; the ENFORCING cost cap is the app-level `token_spend` 429 pre-check
 * (invariant 16), which lives upstream of these calls.
 */

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

/** Shared dependency bundle for the AI chokepoints (binding + gateway id + tenant). */
export interface AiDeps {
  ai: AiRunner
  gatewayId: string
  tenantId: string
}

export const aiGateway = (gatewayId: string, tenantId: string): BrainAiRunOptions => ({
  gateway: { id: gatewayId, metadata: { tenant_id: tenantId } },
})

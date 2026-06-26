/**
 * The Cloudflare binding ENV interface (PRD §9).
 *
 * `packages/db` is the ONLY module allowed to name the raw bindings (invariant 2); the
 * `Scoped*` chokepoints + the AI wrappers are the only things that read them. The global
 * binding types (`D1Database`, `Vectorize`, `R2Bucket`, `Ai`) come from
 * `@cloudflare/workers-types`. Two Vectorize V2 indexes (1024d, cosine), one D1, one R2.
 */
export interface BrainBindings {
  /** Single shared D1 (Drizzle ORM); the tenancy spine. */
  DB: D1Database
  /** `brain-chunks` Vectorize V2 index (1024d, cosine, namespace=tenantId). */
  CHUNK_INDEX: Vectorize
  /** `brain-entities` Vectorize V2 index (1024d, cosine, namespace=tenantId). */
  ENTITY_INDEX: Vectorize
  /** Tenant-prefixed bodies/transcripts/audit ndjson. */
  BODIES: R2Bucket
  /** KV store backing `@cloudflare/workers-oauth-provider` (PRD §7.2/§9). */
  OAUTH_KV: KVNamespace
  /** Workers AI binding (routed through AI Gateway). */
  AI: Ai
  /** AI Gateway id for attribution metadata (invariant 16). */
  AI_GATEWAY_ID: string
  /**
   * Clerk Frontend API host (e.g. `clerk.example.com`); the OAuth 2.1 upstream IdP
   * (PRD §7.2). The issuer is `https://${CLERK_FRONTEND_API}` and the JWKS lives at
   * `${issuer}/.well-known/jwks.json` — both consumed by `createClerkVerifier`.
   */
  CLERK_FRONTEND_API: string
  /**
   * HMAC-SHA256 secret for `bdev_` machine tokens (PRD §7.2). The token is signed and
   * verified with this secret via WebCrypto; the `tenantId` is baked into the claims so
   * a machine token resolves statelessly (no D1 lookup).
   */
  DEVICE_FLOW_SECRET: string
  /**
   * Analytics Engine dataset for per-op + per-AI-call ops metrics (PRD §10). OPTIONAL: AE has
   * NO local emulation, so it is absent in the test harness — the ops-metrics sink then no-ops
   * (`createOpsMetrics(undefined)`). The orchestrator/Phase-6 MCP wires the real binding via
   * `analytics_engine_datasets` in `wrangler.jsonc` (deploy-only).
   */
  ANALYTICS?: AnalyticsEngineDataset
  /**
   * AI provider selector. `"@cf"` (default) = Workers AI via AI Gateway; `"openai-compatible"` =
   * BYO provider via fetch. The app layer reads this and builds `OpenAiCompatConfig` when needed.
   * Always set (has a default in wrangler.jsonc vars), so typed as required string.
   */
  AI_PROVIDER: string
  /**
   * Dashboard URL for device-flow verification URIs. Surfaced to CLI users as the page to open in
   * their browser to approve a CLI auth request. Always set via wrangler.jsonc vars.
   */
  DASHBOARD_URL: string
}

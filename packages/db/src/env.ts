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
  /**
   * Clerk Backend API secret key (`sk_live_…` / `sk_test_…`). Used by `search_user_by_email` to
   * resolve a Clerk user from their email address via `GET /v1/users?email_address=`. Set via
   * `wrangler secret put CLERK_SECRET_KEY`; absent in the local test harness (tests stub the fetch).
   */
  CLERK_SECRET_KEY?: string
  /**
   * Notion OAuth public-integration client id (docs/notion-integration-plan.md §2). Non-secret,
   * but declared here (not wrangler.jsonc vars) so it stays OPTIONAL — the connect flow degrades
   * to a "not configured" state when unset. Registering the integration + redirect_uri is a
   * human step (deferred-gates list). Set via `wrangler secret put NOTION_CLIENT_ID`.
   */
  NOTION_CLIENT_ID?: string
  /** Notion OAuth client secret — the Basic-auth pair for the token exchange. Secret. */
  NOTION_CLIENT_SECRET?: string
  /**
   * AES-GCM key for the stored Notion bot tokens (DEVICE_FLOW_SECRET-style Worker secret). Any
   * string — it is SHA-256-hashed to a 256-bit key. When unset, the poller/webhook no-op (no
   * usable token store), so the feature degrades gracefully. Set via `wrangler secret put`.
   */
  NOTION_TOKEN_ENC_KEY?: string
  /**
   * Notion webhook verification token (integration-level HMAC secret). Every event carries
   * `X-Notion-Signature: sha256=HMAC-SHA256(verification_token, rawBody)`; captured via the
   * one-time handshake and set here. When unset the webhook endpoint no-ops (fail-closed).
   */
  NOTION_WEBHOOK_TOKEN?: string
}

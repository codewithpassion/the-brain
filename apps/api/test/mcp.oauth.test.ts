import { env } from "cloudflare:test"
import type { BrainBindings, ClerkIdentity, ClerkVerifier } from "@brain/db"
import type { SurfaceEnv } from "@brain/surface"
import { beforeAll, describe, expect, test } from "vitest"
import { createOAuthWorker } from "../src/index"
import { seedChunk, seedDoc, seedMembership, seedOrg } from "./seed"

/**
 * MCP OAuth path canary — minimal-boot proof that the OAuthProvider wrapper is wired correctly.
 * Tests the three deliverables from the gate spec:
 *
 *   1. Discovery: `/.well-known/oauth-authorization-server` returns valid metadata with the
 *      expected endpoints advertised.
 *
 *   2. OAuth token path: a full authorization_code flow (register → /authorize → /callback →
 *      /oauth/token → /mcp tools/list) produces a tenant-scoped tool response driven by the
 *      access token's `props.principal`.
 *
 *   3. Bearer path (resolveExternalToken): a legacy Clerk JWT on `/mcp` still works unchanged;
 *      the isolation invariant holds — tenant A's OAuth session cannot read tenant B's data.
 *
 * The worker is constructed with `createOAuthWorker({ clerkVerifier: fakeVerifier })` so no
 * real Clerk network calls occur. The test calls the worker's `.fetch()` directly (not via
 * SELF) so the same fake verifier reaches both the OAuth `/callback` and the
 * `resolveExternalToken` bridge.
 */

const env_ = env as unknown as BrainBindings

// ─── Shared fixtures ────────────────────────────────────────────────────────

const OAUTH_USER = "oauth-test-user"
const OAUTH_TENANT = `org_${OAUTH_USER}` // auto-provisioned on first login
const BEARER_USER = "bearer-test-user"
const BEARER_TENANT = `org_${BEARER_USER}`

const fakeVerifier = (userId: string, email?: string): ClerkVerifier => ({
  verify: async (token: string): Promise<ClerkIdentity | null> => {
    if (token === `fake.${userId}.jwt`) return { userId, ...(email ? { email } : {}) }
    return null
  },
})

// Worker using the fake Clerk verifier for the OAuth user.
const makeWorker = (userId: string) => createOAuthWorker({ clerkVerifier: fakeVerifier(userId) })

const BASE = "https://brain.test"

const makeCtx = (): ExecutionContext =>
  ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext

const workerFetch = (
  worker: ReturnType<typeof createOAuthWorker>,
  path: string,
  init: RequestInit = {},
  overrideEnv?: unknown,
): Promise<Response> =>
  worker.fetch(new Request(`${BASE}${path}`, init), overrideEnv ?? (env as unknown), makeCtx())

// ── Fake Vectorize + AI (no local emulation; mirror what mcp.canary.test.ts does) ──────────
// The adversarial fake returns ONLY tenant-A's chunk id for any query — the D1 re-check then
// drops it if it's cross-tenant. We use this in the isolation test instead of the real
// CHUNK_INDEX (which throws "needs to be run remotely" locally).
const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

// Adversarial fake: returns bearer-chunk (cross-tenant B) FIRST, then oauth-chunk (A).
// The D1 re-check must DROP bearer-chunk (wrong tenant) and KEEP oauth-chunk (correct tenant).
// Without this cross-tenant id in the result, "bearer-chunk absent" would be vacuously true.
const oauthOnlyIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: "bearer-chunk", score: 0.95 }, // cross-tenant — must be DROPPED by D1 re-check
      { id: "oauth-chunk", score: 0.91 }, // same tenant — must be KEPT
    ],
  }),
} as unknown as Vectorize

const fakeAi = {
  run: async (_model: string, inputs: Record<string, unknown>) => ({
    data: ((inputs.text as string[] | undefined) ?? [""]).map(() => vec1024()),
  }),
} as unknown as BrainBindings["AI"]

/** Env with real KV/D1/R2 but faked Vectorize + AI (avoids the "run remotely" crash). */
const mcpEnv = {
  ...env_,
  CHUNK_INDEX: oauthOnlyIndex,
  ENTITY_INDEX: oauthOnlyIndex,
  AI: fakeAi,
  AI_GATEWAY_ID: "test-gateway",
} as unknown as SurfaceEnv

// ─── PKCE helpers ───────────────────────────────────────────────────────────

const base64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")

const pkce = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(digest) }
}

// ─── Seed ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Auto-provision org for OAUTH_USER (triggered by first resolvePrincipal call in /callback).
  // seedOrg / seedMembership are not needed — resolvePrincipal does it. Pre-seed a document
  // so tools/list + a search have real rows to operate on.
  await seedOrg(OAUTH_TENANT, `u-oauth`)
  await seedMembership({ tenantId: OAUTH_TENANT, userId: OAUTH_USER })
  await seedDoc({ id: "oauth-doc", tenantId: OAUTH_TENANT, slug: "oauth-doc" })
  // Distinctive marker so we can assert tenant A's content IS present (non-vacuous).
  await seedChunk({
    id: "oauth-chunk",
    tenantId: OAUTH_TENANT,
    documentId: "oauth-doc",
    content: "oauthuniquesentinel the answer is in tenant A only",
  })

  // Seed tenant B for isolation check.
  await seedOrg(BEARER_TENANT, `u-bearer`)
  await seedMembership({ tenantId: BEARER_TENANT, userId: BEARER_USER })
  await seedDoc({ id: "bearer-doc", tenantId: BEARER_TENANT, slug: "bearer-doc" })
  await seedChunk({
    id: "bearer-chunk",
    tenantId: BEARER_TENANT,
    documentId: "bearer-doc",
    content: "bearertenantsentinel this must not leak to tenant A",
  })
})

// ─── 1. Discovery ────────────────────────────────────────────────────────────

describe("OAuth 2.1 discovery", () => {
  test("/.well-known/oauth-authorization-server returns valid metadata", async () => {
    const worker = makeWorker(OAUTH_USER)
    const res = await workerFetch(worker, "/.well-known/oauth-authorization-server")
    expect(res.status).toBe(200)

    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.issuer).toBeTruthy()
    expect(meta.authorization_endpoint).toContain("/authorize")
    expect(meta.token_endpoint).toContain("/oauth/token")
    expect(meta.registration_endpoint).toContain("/register")
    expect(Array.isArray(meta.scopes_supported)).toBe(true)
    expect(meta.code_challenge_methods_supported).toContain("S256")
  })
})

// ─── 2. Full OAuth code flow ─────────────────────────────────────────────────

describe("OAuth authorization_code flow → MCP tools/list", () => {
  test("register → authorize → callback → token → /mcp tools/list works end-to-end", async () => {
    const worker = makeWorker(OAUTH_USER)

    // 2a. Dynamic client registration.
    const regRes = await workerFetch(worker, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "test-mcp-client",
        redirect_uris: [`${BASE}/mcp-redirect`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client
      }),
    })
    expect(regRes.status).toBe(201)
    const regBody = (await regRes.json()) as { client_id: string }
    const clientId = regBody.client_id
    expect(typeof clientId).toBe("string")

    // 2b. Initiate /authorize — this stores OAuth state in OAUTH_KV and returns the sign-in HTML.
    const { verifier, challenge } = await pkce()
    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: `${BASE}/mcp-redirect`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "brain:read brain:write",
    })
    const authRes = await workerFetch(worker, `/authorize?${authParams}`)
    // The authorize handler returns an HTML page with the Clerk sign-in.
    expect(authRes.status).toBe(200)
    expect(authRes.headers.get("content-type")).toContain("text/html")

    // 2c. Extract the state token from OAUTH_KV (the test env has direct KV access).
    //     The /authorize handler stores the OAuth request as `oauth:state:<stateToken>`.
    const kvList = await env_.OAUTH_KV.list({ prefix: "oauth:state:" })
    // There should be exactly one pending state (from the authorize call above).
    expect(kvList.keys.length).toBeGreaterThan(0)
    const stateKey = kvList.keys[0]?.name ?? ""
    const stateToken = stateKey.replace("oauth:state:", "")
    expect(stateToken).toBeTruthy()

    // 2d. Simulate the Clerk sign-in callback with a fake Clerk JWT.
    //     The real browser flow would POST this after loading Clerk JS and signing in.
    const clerkJwt = `fake.${OAUTH_USER}.jwt`
    const callbackParams = new URLSearchParams({
      token: clerkJwt,
      state: stateToken,
    })
    const callbackRes = await workerFetch(worker, `/callback?${callbackParams}`)
    // Should redirect to the client's redirect_uri with an auth code.
    expect(callbackRes.status).toBe(302)
    const location = callbackRes.headers.get("location") ?? ""
    expect(location).toContain(`${BASE}/mcp-redirect`)
    expect(location).toContain("code=")

    // 2e. Extract the auth code from the redirect URI.
    const codeUrl = new URL(location)
    const code = codeUrl.searchParams.get("code") ?? ""
    expect(code).toBeTruthy()

    // 2f. Exchange the code for an access token.
    const tokenRes = await workerFetch(worker, "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${BASE}/mcp-redirect`,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const tokenBody = (await tokenRes.json()) as { access_token: string; token_type: string }
    // RFC 6749 allows "Bearer" or "bearer" — compare case-insensitively.
    expect(tokenBody.token_type.toLowerCase()).toBe("bearer")
    expect(typeof tokenBody.access_token).toBe("string")
    const accessToken = tokenBody.access_token

    // 2g. Use the OAuth access token on /mcp (stateless path) → tools/list.
    const initRes = await workerFetch(worker, "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    })
    expect(initRes.status).toBe(200)
    const initBody = (await initRes.json()) as {
      result?: { tools: { name: string }[] }
      error?: unknown
    }
    expect(initBody.error).toBeUndefined()
    // The tool catalog is non-empty (the full registry is registered for an owner principal).
    expect((initBody.result?.tools ?? []).length).toBeGreaterThan(0)
  })
})

// ─── 3. Legacy bearer path (resolveExternalToken) + isolation ─────────────────

describe("Legacy bearer path (resolveExternalToken) + tenant isolation", () => {
  test("a Clerk JWT on /mcp reaches the MCP server (resolveExternalToken path)", async () => {
    // The BEARER_USER has already been seeded with their own org.
    const worker = makeWorker(BEARER_USER)
    const clerkJwt = `fake.${BEARER_USER}.jwt`

    const res = await workerFetch(worker, "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clerkJwt}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        // X-Brain-Tenant needed for existing users with memberships (invariant 17).
        "X-Brain-Tenant": BEARER_TENANT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bearer-test", version: "0.0.0" },
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result?: { serverInfo?: { name: string } }
      error?: unknown
    }
    expect(body.error).toBeUndefined()
    expect(body.result?.serverInfo?.name).toBe("the-brain")
  })

  test("a missing bearer on /mcp is 401 (OAuthProvider rejects token-less API route request)", async () => {
    const worker = makeWorker(OAUTH_USER)
    const res = await workerFetch(worker, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(res.status).toBe(401)
  })

  test("OAuth token props are tenant-scoped: tenant A's token reads only A's chunks", async () => {
    // Issue an OAuth token for OAUTH_USER (tenant A) and verify it only sees A's chunks
    // and NOT BEARER_USER's chunks (tenant B) — the D1 re-check invariant (invariant 3).
    const worker = makeWorker(OAUTH_USER)

    // Register client and run the full OAuth flow to get an access_token for OAUTH_TENANT.
    const regRes = await workerFetch(worker, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "isolation-test-client",
        redirect_uris: [`${BASE}/redirect`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    const { client_id: clientId } = (await regRes.json()) as { client_id: string }

    const { verifier, challenge } = await pkce()
    await workerFetch(
      worker,
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: `${BASE}/redirect`,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "brain:read",
      })}`,
    )

    // Read state from KV.
    const kvList = await env_.OAUTH_KV.list({ prefix: "oauth:state:" })
    const stateToken = (
      kvList.keys.find((k) => k.name.startsWith("oauth:state:"))?.name ?? ""
    ).replace("oauth:state:", "")

    const callbackRes = await workerFetch(
      worker,
      `/callback?${new URLSearchParams({ token: `fake.${OAUTH_USER}.jwt`, state: stateToken })}`,
    )
    const code = new URL(callbackRes.headers.get("location") ?? "").searchParams.get("code") ?? ""

    const tokenBody = (await (
      await workerFetch(worker, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${BASE}/redirect`,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      })
    ).json()) as { access_token: string }
    const accessToken = tokenBody.access_token

    // Call `search` via /mcp with the OAuth access token, using the faked Vectorize env.
    // The adversarial fake vector index returns "oauth-chunk" for any query; the D1 re-check
    // then validates it belongs to the principal's tenant. We pass `mcpEnv` (which has faked
    // CHUNK_INDEX/AI but real OAUTH_KV/DB) so the access-token lookup still works while
    // Vectorize is locally available without a remote connection.
    const searchRes = await workerFetch(
      worker,
      "/mcp",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { query: "sentinel", topK: 5 } },
        }),
      },
      mcpEnv,
    )
    expect(searchRes.status).toBe(200)
    const searchBody = (await searchRes.json()) as {
      result?: { content: { text: string }[]; isError?: boolean }
      error?: unknown
    }
    expect(searchBody.error).toBeUndefined()
    expect(searchBody.result?.isError ?? false).toBe(false)

    const text = searchBody.result?.content[0]?.text ?? ""

    // NON-VACUOUS: the adversarial vector arm returned "oauth-chunk" for this query;
    // the D1 re-check KEPT it (it belongs to OAUTH_TENANT) — so the text must contain
    // the unique content we seeded into that chunk.
    expect(text).toContain("oauthuniquesentinel")
    expect(text).toContain("oauth-chunk")

    // ISOLATION: tenant B's chunk ("bearer-chunk") was NOT in the fake index result,
    // but even if it had been, the D1 re-check would have dropped it. Assert absence.
    expect(text).not.toContain("bearer-chunk")
    expect(text).not.toContain("bearertenantsentinel")
    expect(text).not.toContain(BEARER_TENANT)
  })
})

// ─── 4. Device-flow /token is unaffected by the OAuthProvider ──────────────

describe("Device-flow /token survives the OAuthProvider wrapper", () => {
  test("POST /token with an unknown grant_type reaches the Hono app (device-flow handler)", async () => {
    const worker = makeWorker(OAUTH_USER)
    const res = await workerFetch(worker, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "nonexistent-code",
      }).toString(),
    })
    // The device-flow handler should answer (error "authorization_pending" or similar).
    // Critically, it should NOT return a 404 (meaning the defaultHandler received it).
    expect(res.status).not.toBe(404)
    // device_code exchange for a nonexistent code returns 400 with a JSON error body.
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(typeof body.error).toBe("string")
  })
})

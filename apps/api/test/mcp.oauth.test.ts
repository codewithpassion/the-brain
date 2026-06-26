import { env } from "cloudflare:test"
import type { BrainBindings, ClerkIdentity, ClerkVerifier } from "@brain/db"
import type { SurfaceEnv } from "@brain/surface"
import { beforeAll, describe, expect, test } from "vitest"
import { createOAuthWorker } from "../src/index"
import { seedChunk, seedDoc, seedMembership, seedOrg } from "./seed"

/**
 * MCP OAuth path canary — tests the OAuthProvider wrapper, the hardened callback (T9), the
 * org picker flow (T10), and the legacy bearer bridge.
 *
 *   1. Discovery: `/.well-known/oauth-authorization-server` returns valid metadata.
 *
 *   2. OAuth token path (T9 hardened): a full authorization_code flow now POSTs
 *      `{ token, state }` to `/callback` (Clerk JWT never in the URL). The response is
 *      JSON `{ redirectTo }` and the page JS navigates the browser. The full code→token→/mcp
 *      chain still works end-to-end.
 *
 *   3. Org picker (T10):
 *      - Multi-org user's chosen tenant scopes the grant Principal, verified by D1 tenant
 *        isolation (team chunk visible; personal chunk absent from results).
 *      - Non-member choice is rejected with 401.
 *      - Single non-personal org user: /authorize/orgs returns that org; /callback with its
 *        id succeeds; fallback to org_${userId} (which doesn't exist) correctly 401s.
 *
 *   4. Bearer path (resolveExternalToken): legacy Clerk JWT on `/mcp` unchanged.
 *
 *   5. Device-flow survives the OAuthProvider wrapper.
 */

const env_ = env as unknown as BrainBindings

// ─── Shared fixtures ────────────────────────────────────────────────────────

const OAUTH_USER = "oauth-test-user"
const OAUTH_TENANT = `org_${OAUTH_USER}` // auto-provisioned on first login
const BEARER_USER = "bearer-test-user"
const BEARER_TENANT = `org_${BEARER_USER}`

/** Multi-org user for T10 picker tests (has personal org + team org). */
const MULTI_USER = "multi-org-test-user"
const MULTI_PERSONAL = `org_${MULTI_USER}`
const MULTI_TEAM = "team-org-id-for-t10"
const MULTI_TEAM_SLUG = "team-org-slug-t10"

/**
 * Non-member tenant (exists in DB; MULTI_USER is NOT a member — for rejection test).
 */
const OTHER_TENANT = "other-tenant-not-a-member"

/**
 * Solo user whose ONLY org is non-personal (guards the org_${userId} fallback trap:
 * if the page JS mistakenly sends no tenantId for single-org users, the server's
 * fallback to org_${userId} hits an unknown tenant → 401 instead of their real org).
 */
const SOLO_USER = "solo-nonpersonal-user"
const SOLO_TEAM = "solo-team-org-id"

const fakeVerifier = (userId: string, email?: string): ClerkVerifier => ({
  verify: async (token: string): Promise<ClerkIdentity | null> => {
    if (token === `fake.${userId}.jwt`) return { userId, ...(email ? { email } : {}) }
    return null
  },
})

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

// ── Fake Vectorize + AI ──────────────────────────────────────────────────────

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

const fakeAi = {
  run: async (_model: string, inputs: Record<string, unknown>) => ({
    data: ((inputs.text as string[] | undefined) ?? [""]).map(() => vec1024()),
  }),
} as unknown as BrainBindings["AI"]

/**
 * Adversarial fake for the OAUTH_USER isolation test: returns bearer-chunk first (cross-tenant
 * B) then oauth-chunk (A). D1 re-check must drop bearer-chunk and keep oauth-chunk.
 */
const oauthOnlyIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: "bearer-chunk", score: 0.95 }, // cross-tenant — must be DROPPED
      { id: "oauth-chunk", score: 0.91 }, // same tenant — must be KEPT
    ],
  }),
} as unknown as Vectorize

/** Env with real KV/D1/R2 but faked Vectorize + AI for OAUTH_USER isolation test. */
const mcpEnv = {
  ...env_,
  CHUNK_INDEX: oauthOnlyIndex,
  ENTITY_INDEX: oauthOnlyIndex,
  AI: fakeAi,
  AI_GATEWAY_ID: "test-gateway",
} as unknown as SurfaceEnv

/**
 * Adversarial fake for the T10 team-scoping test: returns multi-personal-chunk first
 * (cross-tenant — MULTI_PERSONAL) then multi-team-chunk (MULTI_TEAM). When the OAuth token
 * is correctly scoped to MULTI_TEAM, the D1 re-check must DROP multi-personal-chunk and KEEP
 * multi-team-chunk. If the token were mistakenly scoped to MULTI_PERSONAL, the result would
 * be inverted — making this a discriminating isolation test.
 */
const multiTeamOnlyIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: "multi-personal-chunk", score: 0.95 }, // cross-tenant — must be DROPPED
      { id: "multi-team-chunk", score: 0.91 }, // same tenant — must be KEPT
    ],
  }),
} as unknown as Vectorize

/** Env with faked Vectorize pointing at MULTI_TEAM chunks for T10 scoping test. */
const multiTeamMcpEnv = {
  ...env_,
  CHUNK_INDEX: multiTeamOnlyIndex,
  ENTITY_INDEX: multiTeamOnlyIndex,
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

// ─── Helper: extract stateToken from /authorize HTML ────────────────────────
/**
 * The /authorize handler embeds `const STATE_TOKEN = "<hex>";` in the page HTML.
 * Parsing it here is more reliable than a KV list that may pick up stale tokens.
 */
const extractStateToken = (html: string): string => {
  const m = html.match(/STATE_TOKEN\s*=\s*"([0-9a-f]{64})"/)
  if (!m?.[1]) throw new Error("STATE_TOKEN not found in /authorize HTML")
  return m[1]
}

/** Run a minimal /authorize and return the embedded state token. */
const authorizeAndGetState = async (
  worker: ReturnType<typeof createOAuthWorker>,
  clientId: string,
  redirectUri: string,
  scope: string,
  challenge: string,
): Promise<string> => {
  const authRes = await workerFetch(
    worker,
    `/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope,
    })}`,
  )
  expect(authRes.status).toBe(200)
  const html = await authRes.text()
  return extractStateToken(html)
}

/** POST { token, state, tenantId? } to /callback → return parsed response. */
const postCallback = async (
  worker: ReturnType<typeof createOAuthWorker>,
  token: string,
  stateToken: string,
  tenantId?: string,
): Promise<{ status: number; redirectTo?: string; error?: string }> => {
  const body: Record<string, string> = { token, state: stateToken }
  if (tenantId !== undefined) body.tenantId = tenantId
  const res = await workerFetch(worker, "/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { redirectTo?: string; error?: string }
  return { status: res.status, ...json }
}

// ─── Seed ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // OAUTH_USER: single personal org.
  await seedOrg(OAUTH_TENANT, "u-oauth")
  await seedMembership({ tenantId: OAUTH_TENANT, userId: OAUTH_USER })
  await seedDoc({ id: "oauth-doc", tenantId: OAUTH_TENANT, slug: "oauth-doc" })
  await seedChunk({
    id: "oauth-chunk",
    tenantId: OAUTH_TENANT,
    documentId: "oauth-doc",
    content: "oauthuniquesentinel the answer is in tenant A only",
  })

  // BEARER_USER: single personal org (for legacy bearer + tenant isolation tests).
  await seedOrg(BEARER_TENANT, "u-bearer")
  await seedMembership({ tenantId: BEARER_TENANT, userId: BEARER_USER })
  await seedDoc({ id: "bearer-doc", tenantId: BEARER_TENANT, slug: "bearer-doc" })
  await seedChunk({
    id: "bearer-chunk",
    tenantId: BEARER_TENANT,
    documentId: "bearer-doc",
    content: "bearertenantsentinel this must not leak to tenant A",
  })

  // MULTI_USER: personal org + team org (for T10 picker + scoping + rejection tests).
  await seedOrg(MULTI_PERSONAL, "u-multi")
  await seedMembership({ tenantId: MULTI_PERSONAL, userId: MULTI_USER })
  await seedDoc({ id: "multi-personal-doc", tenantId: MULTI_PERSONAL, slug: "multi-personal-doc" })
  await seedChunk({
    id: "multi-personal-chunk",
    tenantId: MULTI_PERSONAL,
    documentId: "multi-personal-doc",
    content: "multipersonalsentinel personal org content must not appear in team search",
  })
  await seedOrg(MULTI_TEAM, MULTI_TEAM_SLUG)
  await seedMembership({ tenantId: MULTI_TEAM, userId: MULTI_USER, role: "member" })
  await seedDoc({ id: "multi-team-doc", tenantId: MULTI_TEAM, slug: "multi-team-doc" })
  await seedChunk({
    id: "multi-team-chunk",
    tenantId: MULTI_TEAM,
    documentId: "multi-team-doc",
    content: "multiteamsentinel team org content confirms MULTI_TEAM scoping",
  })

  // OTHER_TENANT: exists in DB but MULTI_USER is NOT a member (for rejection test).
  await seedOrg(OTHER_TENANT, "other-tenant-slug-t10")

  // SOLO_USER: only one membership in a non-personal org (no personal org seeded).
  // Guards the org_${userId} fallback trap: if the page JS mistakenly sends no tenantId,
  // the server fallback hits an unknown tenant → 401 instead of the real org.
  await seedOrg(SOLO_TEAM, "solo-team-slug")
  await seedMembership({ tenantId: SOLO_TEAM, userId: SOLO_USER, role: "member" })
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

// ─── 2. Full OAuth code flow (T9: POST /callback, JWT never in URL) ───────────

describe("OAuth authorization_code flow → MCP tools/list (T9: POST /callback)", () => {
  test("register → authorize → POST /callback → token → /mcp tools/list works end-to-end", async () => {
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
        token_endpoint_auth_method: "none",
      }),
    })
    expect(regRes.status).toBe(201)
    const regBody = (await regRes.json()) as { client_id: string }
    const clientId = regBody.client_id
    expect(typeof clientId).toBe("string")

    // 2b. /authorize returns HTML with embedded state token (T9: no token in URL).
    const { verifier, challenge } = await pkce()
    const stateToken = await authorizeAndGetState(
      worker,
      clientId,
      `${BASE}/mcp-redirect`,
      "brain:read brain:write",
      challenge,
    )
    expect(stateToken).toBeTruthy()

    // 2c. POST { token, state } to /callback (T9: Clerk JWT never in the URL).
    //     OAUTH_USER has a single personal org → server defaults to it.
    const clerkJwt = `fake.${OAUTH_USER}.jwt`
    const cbResult = await postCallback(worker, clerkJwt, stateToken)
    // /callback returns JSON { redirectTo }, NOT a 302 redirect.
    expect(cbResult.status).toBe(200)
    expect(cbResult.redirectTo).toContain(`${BASE}/mcp-redirect`)
    expect(cbResult.redirectTo).toContain("code=")

    // 2d. Extract the auth code from the JSON redirectTo URL.
    const code = new URL(cbResult.redirectTo ?? "").searchParams.get("code") ?? ""
    expect(code).toBeTruthy()

    // 2e. Exchange the code for an access token.
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
    expect(tokenBody.token_type.toLowerCase()).toBe("bearer")
    expect(typeof tokenBody.access_token).toBe("string")
    const accessToken = tokenBody.access_token

    // 2f. Use the OAuth access token on /mcp → tools/list.
    const initRes = await workerFetch(worker, "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(initRes.status).toBe(200)
    const initBody = (await initRes.json()) as {
      result?: { tools: { name: string }[] }
      error?: unknown
    }
    expect(initBody.error).toBeUndefined()
    expect((initBody.result?.tools ?? []).length).toBeGreaterThan(0)
  })

  test("GET /callback is gone — JWT must never be placed in the URL", async () => {
    const worker = makeWorker(OAUTH_USER)
    const res = await workerFetch(worker, "/callback?token=fake&state=fake")
    expect(res.status).not.toBe(302) // no redirect — the old GET handler is gone
    expect(res.status).not.toBe(200) // not a success response
  })
})

// ─── 3. T10 — org picker ──────────────────────────────────────────────────────

describe("T10 — org picker on /authorize for multi-org users", () => {
  test("POST /authorize/orgs returns both orgs for a multi-org user", async () => {
    const worker = makeWorker(MULTI_USER)
    const res = await workerFetch(worker, "/authorize/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: `fake.${MULTI_USER}.jwt` }),
    })
    expect(res.status).toBe(200)
    const { orgs } = (await res.json()) as { orgs: { id: string; name: string }[] }
    expect(orgs.length).toBe(2)
    const ids = orgs.map((o) => o.id)
    expect(ids).toContain(MULTI_PERSONAL)
    expect(ids).toContain(MULTI_TEAM)
  })

  test("POST /authorize/orgs returns 401 for an invalid Clerk token", async () => {
    const worker = makeWorker(MULTI_USER)
    const res = await workerFetch(worker, "/authorize/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invalid.jwt.token" }),
    })
    expect(res.status).toBe(401)
  })

  test("chosen team org scopes the grant Principal — D1 isolation: team chunk present, personal chunk absent", async () => {
    // This test is discriminating: the adversarial fake index returns multi-personal-chunk
    // first (cross-tenant) then multi-team-chunk (correct tenant). If the OAuth token were
    // scoped to MULTI_PERSONAL instead of MULTI_TEAM, the results would be inverted.
    const worker = makeWorker(MULTI_USER)

    // Register a client for the MULTI_USER flow.
    const regRes = await workerFetch(worker, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "multi-org-scoping-client",
        redirect_uris: [`${BASE}/multi-redirect`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    const { client_id: clientId } = (await regRes.json()) as { client_id: string }

    const { verifier, challenge } = await pkce()
    const stateToken = await authorizeAndGetState(
      worker,
      clientId,
      `${BASE}/multi-redirect`,
      "brain:read",
      challenge,
    )

    // POST /callback with MULTI_TEAM as the chosen org (org picker selection).
    const cbResult = await postCallback(worker, `fake.${MULTI_USER}.jwt`, stateToken, MULTI_TEAM)
    expect(cbResult.status).toBe(200)
    const code = new URL(cbResult.redirectTo ?? "").searchParams.get("code") ?? ""
    expect(code).toBeTruthy()

    // Exchange code → access token.
    const tokenRes = await workerFetch(worker, "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${BASE}/multi-redirect`,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }

    // Search via /mcp with the team-scoped token + adversarial fake index.
    // The adversarial index returns multi-personal-chunk first; D1 re-check must DROP it
    // (wrong tenant) and KEEP multi-team-chunk (correct tenant for this token).
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
      multiTeamMcpEnv,
    )
    expect(searchRes.status).toBe(200)
    const searchBody = (await searchRes.json()) as {
      result?: { content: { text: string }[]; isError?: boolean }
      error?: unknown
    }
    expect(searchBody.error).toBeUndefined()
    expect(searchBody.result?.isError ?? false).toBe(false)

    const text = searchBody.result?.content[0]?.text ?? ""

    // NON-VACUOUS: adversarial index returned multi-team-chunk; D1 re-check KEPT it
    // because it belongs to MULTI_TEAM (the token's tenant).
    expect(text).toContain("multiteamsentinel")
    expect(text).toContain("multi-team-chunk")

    // ISOLATION: multi-personal-chunk was DROPPED by D1 re-check (wrong tenant).
    expect(text).not.toContain("multipersonalsentinel")
    expect(text).not.toContain("multi-personal-chunk")
  })

  test("non-member tenantId in POST /callback is rejected with 401", async () => {
    const worker = makeWorker(MULTI_USER)

    const regRes = await workerFetch(worker, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "non-member-test-client",
        redirect_uris: [`${BASE}/non-member-redirect`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    const { client_id: clientId } = (await regRes.json()) as { client_id: string }

    const { challenge } = await pkce()
    const stateToken = await authorizeAndGetState(
      worker,
      clientId,
      `${BASE}/non-member-redirect`,
      "brain:read",
      challenge,
    )

    // POST /callback with OTHER_TENANT — MULTI_USER has no membership there.
    const cbResult = await postCallback(worker, `fake.${MULTI_USER}.jwt`, stateToken, OTHER_TENANT)
    expect(cbResult.status).toBe(401)
    expect(cbResult.error).toBeTruthy()
  })

  test("POST /authorize/orgs returns 1 org for a single-org user (picker skipped in browser)", async () => {
    // OAUTH_USER has exactly one org (personal). /authorize/orgs confirms this.
    // The page JS would auto-submit orgs[0].id without showing the picker (in-browser).
    const worker = makeWorker(OAUTH_USER)
    const res = await workerFetch(worker, "/authorize/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: `fake.${OAUTH_USER}.jwt` }),
    })
    expect(res.status).toBe(200)
    const { orgs } = (await res.json()) as { orgs: { id: string }[] }
    expect(orgs.length).toBe(1)
    expect(orgs[0]?.id).toBe(OAUTH_TENANT)
  })

  test("single non-personal org user: /authorize/orgs returns that org; /callback with its id succeeds", async () => {
    // SOLO_USER's only org is SOLO_TEAM (not org_${SOLO_USER}).
    // This test guards the fallback trap: if the page JS mistakenly sends no tenantId,
    // /callback falls back to org_${SOLO_USER} which doesn't exist → 401.
    // The correct path is to submit orgs[0].id = SOLO_TEAM.
    const worker = makeWorker(SOLO_USER)

    // Confirm /authorize/orgs returns the non-personal org.
    const orgsRes = await workerFetch(worker, "/authorize/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: `fake.${SOLO_USER}.jwt` }),
    })
    expect(orgsRes.status).toBe(200)
    const { orgs } = (await orgsRes.json()) as { orgs: { id: string }[] }
    expect(orgs.length).toBe(1)
    expect(orgs[0]?.id).toBe(SOLO_TEAM) // not org_${SOLO_USER}

    // Register a client so we can get a state token.
    const regRes = await workerFetch(worker, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "solo-org-test-client",
        redirect_uris: [`${BASE}/solo-redirect`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    const { client_id: clientId } = (await regRes.json()) as { client_id: string }

    // Happy path: submit orgs[0].id → succeeds, scopes to SOLO_TEAM.
    const stateOk = await authorizeAndGetState(
      worker,
      clientId,
      `${BASE}/solo-redirect`,
      "brain:read",
      (await pkce()).challenge,
    )
    const cbOk = await postCallback(worker, `fake.${SOLO_USER}.jwt`, stateOk, SOLO_TEAM)
    expect(cbOk.status).toBe(200)
    expect(cbOk.redirectTo).toContain("code=")

    // Fallback trap: no tenantId → server falls to org_${SOLO_USER} which doesn't exist → 401.
    // (State token not burned on the non-member 401 path, but we get a fresh one anyway.)
    const stateFallback = await authorizeAndGetState(
      worker,
      clientId,
      `${BASE}/solo-redirect`,
      "brain:read",
      (await pkce()).challenge,
    )
    const cbFallback = await postCallback(worker, `fake.${SOLO_USER}.jwt`, stateFallback)
    expect(cbFallback.status).toBe(401) // org_${SOLO_USER} unknown → "unknown active tenant"
  })
})

// ─── 4. Legacy bearer path (resolveExternalToken) + isolation ─────────────────

describe("Legacy bearer path (resolveExternalToken) + tenant isolation", () => {
  test("a Clerk JWT on /mcp reaches the MCP server (resolveExternalToken path)", async () => {
    const worker = makeWorker(BEARER_USER)
    const clerkJwt = `fake.${BEARER_USER}.jwt`

    const res = await workerFetch(worker, "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clerkJwt}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
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
    const worker = makeWorker(OAUTH_USER)

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
    const stateToken = await authorizeAndGetState(
      worker,
      clientId,
      `${BASE}/redirect`,
      "brain:read",
      challenge,
    )

    // T9: POST { token, state } → JSON { redirectTo }.
    const cbResult = await postCallback(worker, `fake.${OAUTH_USER}.jwt`, stateToken)
    expect(cbResult.status).toBe(200)
    const code = new URL(cbResult.redirectTo ?? "").searchParams.get("code") ?? ""

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

    // NON-VACUOUS: adversarial index returned "oauth-chunk"; D1 re-check KEPT it (correct tenant).
    expect(text).toContain("oauthuniquesentinel")
    expect(text).toContain("oauth-chunk")

    // ISOLATION: bearer-chunk was DROPPED by D1 re-check (wrong tenant).
    expect(text).not.toContain("bearer-chunk")
    expect(text).not.toContain("bearertenantsentinel")
    expect(text).not.toContain(BEARER_TENANT)
  })
})

// ─── 5. Device-flow /token is unaffected by the OAuthProvider ──────────────

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
    expect(res.status).not.toBe(404)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(typeof body.error).toBe("string")
  })
})

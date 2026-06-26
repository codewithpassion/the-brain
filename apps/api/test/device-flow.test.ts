/**
 * Device-flow integration tests (RFC 8628).
 *
 * Runs inside workerd via @cloudflare/vitest-pool-workers with real D1 + KV.
 * Clerk verification is injected as a no-network fake verifier.
 */
import { env } from "cloudflare:test"
import {
  type BrainBindings,
  type ClerkIdentity,
  type ClerkVerifier,
  createDeviceSession,
  resolveApiKeyPrincipal,
} from "@brain/db"
import { drizzle } from "drizzle-orm/d1"
import { describe, expect, test } from "vitest"
import { createApp } from "../src/index"

const env_ = env as unknown as BrainBindings

const USER = "device-test-user"

const fakeVerifier = (identity: ClerkIdentity): ClerkVerifier => ({
  verify: async () => identity,
})

const makeCtx = () => {
  const tasks: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext
  return { ctx, flush: () => Promise.all(tasks) }
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString()

const app = createApp({
  clerkVerifier: fakeVerifier({ userId: USER, email: "device-test@example.com" }),
})

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

describe("device flow", () => {
  // Each test uses unique device codes so KV slow_down state from one test cannot bleed into
  // another. The real KV in the test harness persists across tests in a describe block.

  test("full round-trip: authorize → pending → approve → token → refresh", async () => {
    const { ctx } = makeCtx()

    // Step 1: POST /device_authorization
    const authRes = await app.request(
      "/device_authorization",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ client_id: "brain-cli" }),
      },
      env_,
      ctx,
    )
    expect(authRes.status).toBe(200)
    const auth = (await authRes.json()) as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete: string
      expires_in: number
      interval: number
    }
    expect(auth.device_code).toMatch(/^dc_/)
    expect(auth.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(auth.verification_uri).toContain("/activate")
    expect(auth.verification_uri_complete).toContain(auth.user_code)
    expect(auth.expires_in).toBe(900)
    expect(auth.interval).toBe(5)

    // Step 2: Poll before approval — must return 400 authorization_pending.
    const pendingRes = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: auth.device_code,
          client_id: "brain-cli",
        }),
      },
      env_,
      ctx,
    )
    expect(pendingRes.status).toBe(400)
    const pendingBody = (await pendingRes.json()) as { error: string }
    expect(pendingBody.error).toBe("authorization_pending")

    // Step 3: Approve via /activate (Clerk-authenticated).
    const approveRes = await app.request(
      "/activate",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Bearer fake-clerk-jwt",
        },
        body: form({ user_code: auth.user_code }),
      },
      env_,
      ctx,
    )
    expect(approveRes.status).toBe(200)
    expect(await approveRes.json()).toMatchObject({ ok: true })

    // Step 4: Poll after approval — session is now approved, slow_down check is skipped,
    // so this succeeds immediately even though it follows shortly after the pending poll.
    const tokenRes = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: auth.device_code,
          client_id: "brain-cli",
        }),
      },
      env_,
      ctx,
    )
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      token_type: string
    }
    expect(tokens.access_token).toMatch(/^bk_/)
    expect(tokens.refresh_token).toMatch(/^rt_/)
    expect(tokens.expires_in).toBeGreaterThan(0)
    expect(tokens.token_type).toBe("Bearer")

    // The minted key resolves to the correct tenant (org_${userId}).
    const db = drizzle(env_.DB)
    const principal = await resolveApiKeyPrincipal(db, tokens.access_token)
    expect(principal).not.toBeNull()
    expect(principal?.tenantId).toBe(`org_${USER}`)

    // Step 5: Second poll after consumed → access_denied.
    const consumedRes = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: auth.device_code,
          client_id: "brain-cli",
        }),
      },
      env_,
      ctx,
    )
    expect(consumedRes.status).toBe(400)
    expect(((await consumedRes.json()) as { error: string }).error).toBe("access_denied")

    // Step 6: Refresh token rotation — new tokens issued, old refresh token revoked.
    const refreshRes = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: "brain-cli",
        }),
      },
      env_,
      ctx,
    )
    expect(refreshRes.status).toBe(200)
    const refreshed = (await refreshRes.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      token_type: string
    }
    expect(refreshed.access_token).toMatch(/^bk_/)
    expect(refreshed.refresh_token).toMatch(/^rt_/)
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token) // token rotated
    expect(refreshed.expires_in).toBe(3600)
    expect(refreshed.token_type).toBe("Bearer")

    // Step 7: Old refresh token is now revoked — second use must fail.
    const revokedRes = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: "brain-cli",
        }),
      },
      env_,
      ctx,
    )
    expect(revokedRes.status).toBe(400)
    expect(((await revokedRes.json()) as { error: string }).error).toBe("invalid_grant")
  })

  test("expired device code → expired_token (400)", async () => {
    // Directly insert a session with a past expiresAt.
    const expiredCode = `dc_expired_${crypto.randomUUID()}`
    await env_.DB.prepare(
      "INSERT INTO cli_auth_sessions (id, device_code, user_code, status, expires_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        expiredCode,
        "ZZZZ-ZZZZ",
        new Date(Date.now() - 10_000).toISOString(),
        new Date().toISOString(),
      )
      .run()

    const { ctx } = makeCtx()
    const res = await app.request(
      "/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: expiredCode,
          client_id: "brain-cli",
        }),
      },
      env_,
      ctx,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("expired_token")
  })

  test("verification_uri uses DASHBOARD_URL when set, falls back to origin otherwise", async () => {
    // Minimal env — createDeviceSession only reads DB and DASHBOARD_URL.
    const customDashboard = "https://custom-dashboard.example.com"
    const customEnv = { DB: env_.DB, DASHBOARD_URL: customDashboard } as unknown as BrainBindings
    const result = await createDeviceSession(customEnv, "https://api.example.com")
    expect(result.verification_uri).toBe(`${customDashboard}/cli/activate`)
    expect(result.verification_uri_complete).toBe(
      `${customDashboard}/cli/activate?user_code=${encodeURIComponent(result.user_code)}`,
    )

    // Fallback: empty DASHBOARD_URL ⇒ use origin.
    const fallbackEnv = { DB: env_.DB, DASHBOARD_URL: "" } as unknown as BrainBindings
    const fallback = await createDeviceSession(fallbackEnv, "https://api.example.com")
    expect(fallback.verification_uri).toBe("https://api.example.com/cli/activate")
  })

  test("slow_down: second rapid poll while pending returns slow_down (400)", async () => {
    // Create a fresh session for this test.
    const authRes = await app.request(
      "/device_authorization",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ client_id: "brain-cli" }),
      },
      env_,
      makeCtx().ctx,
    )
    const auth = (await authRes.json()) as { device_code: string }

    const pollInit = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: DEVICE_CODE_GRANT,
        device_code: auth.device_code,
        client_id: "brain-cli",
      }),
    }

    // First poll — no KV key yet, gets authorization_pending and writes the key.
    const first = await app.request("/token", pollInit, env_, makeCtx().ctx)
    expect(first.status).toBe(400)
    expect(((await first.json()) as { error: string }).error).toBe("authorization_pending")

    // Second poll immediately — KV key exists, time delta < 5s → slow_down.
    const second = await app.request("/token", pollInit, env_, makeCtx().ctx)
    expect(second.status).toBe(400)
    expect(((await second.json()) as { error: string }).error).toBe("slow_down")
  })
})

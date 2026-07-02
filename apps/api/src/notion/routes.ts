/**
 * Notion OAuth callback route (docs/notion-integration-plan.md §2) — thin Hono layer. The Brain is
 * the OAuth CLIENT here. `connect_notion` (an op) mints the authorize URL + a one-time nonce; the
 * user consents in Notion, which redirects the browser to `/notion/callback?code&state`. This
 * PUBLIC route (no bearer — a browser redirect) recovers the tenant from the nonce and exchanges the
 * code for the bot token, but does NOT auto-persist: it STASHES the (encrypted) grant and redirects
 * to the dashboard for a same-principal confirmation (`confirm_notion_connection`) — the login-CSRF
 * defence, since Notion is a confidential client with no PKCE support (see the residual note).
 *
 * MUST NOT reference raw binding types (boundary-lint): all D1/KV logic lives in `@brain/db`.
 */
import {
  consumeNotionOAuthNonce,
  encryptToken,
  NOTION_REDIRECT_URI,
  notionHandshakeToken,
  parseNotionEvent,
  randomToken,
  resolveNotionWorkspaceFromEnv,
  storeNotionPendingGrant,
  storeNotionWebhookToken,
  verifyNotionSignature,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"
import { exchangeNotionCode } from "./client"

type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

/** Returns `true` for Notion paths that must bypass the global auth middleware. */
export const isNotionPublicPath = (path: string): boolean =>
  path === "/notion/callback" || path === "/notion/webhook"

/** Redirect the browser back to the dashboard Notion screen with a status query param. */
const dashboardRedirect = (env: ApiBindings, status: string): Response => {
  const base = env.DASHBOARD_URL ?? ""
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}/notion?notion=${status}` },
  })
}

/** Redirect to the dashboard confirmation screen (same-principal confirm before persisting). */
const confirmRedirect = (
  env: ApiBindings,
  confirmToken: string,
  workspaceName: string,
): Response => {
  const base = env.DASHBOARD_URL ?? ""
  const ws = encodeURIComponent(workspaceName)
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}/notion?confirm=${confirmToken}&workspace=${ws}` },
  })
}

export const mountNotion = (app: Hono<AppEnv>): void => {
  // GET /notion/callback — Notion redirects here after consent. Public (no bearer).
  app.get("/notion/callback", async (c) => {
    const url = new URL(c.req.url)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const error = url.searchParams.get("error")

    if (error !== null) return dashboardRedirect(c.env, "denied")
    if (code === null || state === null) return dashboardRedirect(c.env, "invalid")

    const clientId = c.env.NOTION_CLIENT_ID
    const clientSecret = c.env.NOTION_CLIENT_SECRET
    const encKey = c.env.NOTION_TOKEN_ENC_KEY
    if (!(clientId && clientSecret && encKey)) {
      return dashboardRedirect(c.env, "not_configured")
    }

    // Recover the tenant from the one-time nonce (CSRF + tenant binding). Unknown/expired/reused → fail.
    const tenantId = await consumeNotionOAuthNonce(c.env, state)
    if (tenantId === null) return dashboardRedirect(c.env, "expired")

    try {
      const grant = await exchangeNotionCode({
        clientId,
        clientSecret,
        code,
        redirectUri: NOTION_REDIRECT_URI,
      })
      // Do NOT auto-persist: stash the (encrypted) grant and require a SAME-PRINCIPAL confirmation
      // via the authenticated dashboard (`confirm_notion_connection`). This blocks the login-CSRF
      // "persist workspace W to tenant X" injection — persistence only happens when an admin of the
      // bound tenant explicitly confirms the (named) workspace.
      const confirmToken = randomToken("")
      await storeNotionPendingGrant(c.env, confirmToken, {
        tenantId,
        workspaceId: grant.workspaceId,
        workspaceName: grant.workspaceName,
        botId: grant.botId,
        accessTokenCipher: await encryptToken(encKey, grant.accessToken),
        refreshTokenCipher:
          grant.refreshToken !== null ? await encryptToken(encKey, grant.refreshToken) : null,
      })
      return confirmRedirect(c.env, confirmToken, grant.workspaceName ?? grant.workspaceId)
    } catch {
      // Token exchange / stash failure — never leak details to the URL.
      return dashboardRedirect(c.env, "error")
    }
  })

  // POST /notion/webhook — Notion event ingress. Public; verifies its own signature.
  app.post("/notion/webhook", async (c) => {
    const raw = await c.req.text()
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return c.text("bad request", 400)
    }

    // One-time verification handshake: stash the token in KV for one-time operator retrieval —
    // NEVER log it (it is the HMAC signing secret for every future event). No-op once the secret
    // is configured; first-write-wins when unset (a duplicate/forged handshake cannot clobber it).
    // Always return 200 so Notion's handshake completes regardless.
    const handshake = notionHandshakeToken(body)
    if (handshake !== null) {
      if (!c.env.NOTION_WEBHOOK_TOKEN) {
        const stored = await storeNotionWebhookToken(c.env, handshake)
        console.log(
          stored
            ? "notion-webhook: verification handshake stored"
            : "notion-webhook: handshake ignored (a stash already exists)",
        )
      }
      return c.json({ ok: true })
    }

    const secret = c.env.NOTION_WEBHOOK_TOKEN
    if (!secret) return c.json({ ok: true }) // not configured — no-op (graceful degradation)

    // Verify the signature over the RAW body BEFORE touching any tenant data (fail-closed).
    const valid = await verifyNotionSignature(
      secret,
      raw,
      c.req.header("x-notion-signature") ?? null,
    )
    if (!valid) return c.text("invalid signature", 401)

    const event = parseNotionEvent(body)
    if (event === null) return c.json({ ok: true }) // non-page / ignored event

    // Route by workspace_id → tenant; an unknown workspace is dropped (fail-closed).
    const conn = await resolveNotionWorkspaceFromEnv(c.env, event.workspaceId)
    if (conn === null) return c.json({ ok: true })

    await c.env.NOTION_EVENTS_QUEUE?.send({
      tenantId: conn.tenantId,
      workspaceId: event.workspaceId,
      pageId: event.pageId,
      action: event.action,
    })
    return c.json({ ok: true })
  })
}

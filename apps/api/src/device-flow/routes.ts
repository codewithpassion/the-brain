/**
 * Device-flow route handlers (RFC 8628) — thin Hono layer.
 *
 * All D1 / KV logic lives in `@brain/db`; this file MUST NOT reference raw binding types
 * (`D1Database` / `KVNamespace` / `R2Bucket` are banned in apps/api — boundary-lint).
 */
import {
  approveDeviceSession,
  type ClerkVerifier,
  createDeviceSession,
  exchangeDeviceToken,
  refreshDeviceToken,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"

type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

/** Returns `true` for paths that must bypass the global auth middleware. */
export const isDeviceFlowPath = (path: string): boolean =>
  path === "/device_authorization" || path === "/token" || path === "/activate"

export interface DeviceFlowOptions {
  clerkVerifier?: ClerkVerifier
}

export const mountDeviceFlow = (app: Hono<AppEnv>, options: DeviceFlowOptions = {}): void => {
  // POST /device_authorization — generate device + user codes, store pending session.
  app.post("/device_authorization", async (c) => {
    const origin = new URL(c.req.url).origin
    const result = await createDeviceSession(c.env, origin)
    return c.json(result)
  })

  // POST /activate — Clerk-authenticated user approves the device code.
  // Auth errors (invalid JWT, unknown code) are thrown as `AuthError` and caught by onError.
  app.post("/activate", async (c) => {
    const body = await c.req.parseBody()
    const userCode = String(body.user_code ?? "")
    if (!userCode) return c.json({ error: "missing user_code" }, 400)
    await approveDeviceSession(
      c.env,
      userCode,
      options.clerkVerifier,
      c.req.header("authorization"),
    )
    return c.json({ ok: true })
  })

  // POST /token — device_code poll or refresh_token rotation.
  // Protocol errors (authorization_pending / slow_down / expired_token) are HTTP 400 with a JSON
  // `{error}` body — the CLI reads them as non-ok responses and branches on `raw.error`.
  app.post("/token", async (c) => {
    const body = await c.req.parseBody()
    const grantType = String(body.grant_type ?? "")

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = String(body.device_code ?? "")
      if (!deviceCode) return c.json({ error: "missing device_code" }, 400)
      const result = await exchangeDeviceToken(c.env, deviceCode)
      return "error" in result ? c.json(result, 400) : c.json(result)
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(body.refresh_token ?? "")
      if (!refreshToken) return c.json({ error: "missing refresh_token" }, 400)
      const result = await refreshDeviceToken(c.env, refreshToken)
      return "error" in result ? c.json(result, 400) : c.json(result)
    }

    return c.json({ error: "unsupported_grant_type" }, 400)
  })
}

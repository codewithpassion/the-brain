/**
 * OAuth 2.1 device-authorization-grant client (RFC 8628) — the `brain auth login` (device) path.
 *
 * Flow: `POST /device_authorization` → show the user the `user_code` + `verification_uri` → poll
 * `POST /token` (grant `urn:ietf:params:oauth:grant-type:device_code`) until the user approves,
 * honouring `authorization_pending` (keep waiting) and `slow_down` (back off +5s) per §3.5.
 *
 * The SERVER endpoints (`/device_authorization`, `/token`) are a small follow-up the orchestrator
 * wires into apps/api (s09 line 126). Until then a `404` surfaces as `ServerEndpointPendingError`
 * with a clear "endpoint pending" message — `brain login --token` remains the working v1 path.
 *
 * All I/O (`fetch`, `sleep`, `now`) is injected so the polling state machine is unit-testable with
 * no real network and no wall-clock waiting.
 */

/** A public, non-secret client identifier for the installed CLI (RFC 8628 §3.1, public client). */
export const DEVICE_FLOW_CLIENT_ID = "brain-cli"

/** RFC 8628 device-code grant type. */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** The injectable I/O the state machine runs on. */
export interface DeviceFlowDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/** `POST /device_authorization` success body (camelCased). */
export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

/** A token grant (device-code OR refresh). `expiresAt` is epoch-ms, computed from `expires_in`. */
export interface TokenGrant {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

/** A device-flow protocol error (a terminal OAuth `error` code, e.g. `access_denied`). */
export class DeviceFlowError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "DeviceFlowError"
    this.code = code
  }
}

/** The server device-flow endpoints are not deployed yet (404) — the documented v1 deferral. */
export class ServerEndpointPendingError extends Error {
  constructor(endpoint: string) {
    super(
      `device-flow endpoint ${endpoint} is not available yet (server follow-up pending). ` +
        "Use `brain login --token <bk_…>` for now.",
    )
    this.name = "ServerEndpointPendingError"
  }
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString()

const tokenUrl = (apiUrl: string): string => `${apiUrl.replace(/\/$/, "")}/token`

const grantFrom = (raw: RawTokenResponse, now: number): TokenGrant => {
  if (!raw.access_token)
    throw new DeviceFlowError("invalid_response", "token response had no access_token")
  return {
    accessToken: raw.access_token,
    ...(raw.refresh_token !== undefined ? { refreshToken: raw.refresh_token } : {}),
    expiresAt: now + (raw.expires_in ?? 3600) * 1000,
  }
}

/** Step 1 — request a device + user code. `404` ⇒ `ServerEndpointPendingError` (documented deferral). */
export const requestDeviceAuthorization = async (
  deps: DeviceFlowDeps,
  options: { apiUrl: string; clientId?: string; scope?: string },
): Promise<DeviceAuthorization> => {
  const endpoint = `${options.apiUrl.replace(/\/$/, "")}/device_authorization`
  const response = await deps.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      client_id: options.clientId ?? DEVICE_FLOW_CLIENT_ID,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    }),
  })
  if (response.status === 404) throw new ServerEndpointPendingError("/device_authorization")
  if (!response.ok) {
    throw new DeviceFlowError("device_authorization_failed", `HTTP ${response.status}`)
  }
  const raw = (await response.json()) as Record<string, unknown>
  return {
    deviceCode: String(raw.device_code ?? ""),
    userCode: String(raw.user_code ?? ""),
    verificationUri: String(raw.verification_uri ?? ""),
    ...(typeof raw.verification_uri_complete === "string"
      ? { verificationUriComplete: raw.verification_uri_complete }
      : {}),
    expiresIn: typeof raw.expires_in === "number" ? raw.expires_in : 900,
    interval: typeof raw.interval === "number" ? raw.interval : 5,
  }
}

/**
 * Step 2 — poll `/token` until approval. Honours `authorization_pending` (wait) and `slow_down`
 * (back off +5s); any other `error` is terminal; running past `expiresIn` throws `expired_token`.
 */
export const pollForToken = async (
  deps: DeviceFlowDeps,
  options: {
    apiUrl: string
    clientId?: string
    deviceCode: string
    interval: number
    expiresIn: number
  },
): Promise<TokenGrant> => {
  const clientId = options.clientId ?? DEVICE_FLOW_CLIENT_ID
  const deadline = deps.now() + options.expiresIn * 1000
  let waitSeconds = options.interval
  while (deps.now() < deadline) {
    await deps.sleep(waitSeconds * 1000)
    const response = await deps.fetch(tokenUrl(options.apiUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: DEVICE_CODE_GRANT,
        device_code: options.deviceCode,
        client_id: clientId,
      }),
    })
    const raw = (await response.json()) as RawTokenResponse
    if (response.ok) return grantFrom(raw, deps.now())
    if (raw.error === "authorization_pending") continue
    if (raw.error === "slow_down") {
      waitSeconds += 5
      continue
    }
    throw new DeviceFlowError(
      raw.error ?? "token_error",
      raw.error_description ?? "device-flow token request failed",
    )
  }
  throw new DeviceFlowError("expired_token", "device code expired before the user approved")
}

/** Exchange a refresh token for a fresh grant (the 401 auto-refresh path). */
export const refreshGrant = async (
  deps: DeviceFlowDeps,
  options: { apiUrl: string; clientId?: string; refreshToken: string },
): Promise<TokenGrant> => {
  const response = await deps.fetch(tokenUrl(options.apiUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId ?? DEVICE_FLOW_CLIENT_ID,
    }),
  })
  if (response.status === 404) throw new ServerEndpointPendingError("/token")
  const raw = (await response.json()) as RawTokenResponse
  if (!response.ok) {
    throw new DeviceFlowError(
      raw.error ?? "refresh_failed",
      raw.error_description ?? "token refresh failed",
    )
  }
  return grantFrom(raw, deps.now())
}

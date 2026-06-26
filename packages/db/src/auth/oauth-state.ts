/**
 * OAuth 2.1 authorization-state helpers — the `OAUTH_KV` chokepoint for the Worker's
 * `/authorize` → `/callback` CSRF state. Follows invariant 2 (only `packages/db` names
 * raw KV bindings); `apps/api` calls these functions instead of touching `env.OAUTH_KV`
 * directly.
 *
 * Stored under: `oauth:state:<random_hex_token>` with a 10-minute TTL.
 */
import type { BrainBindings } from "../env"

const STATE_PREFIX = "oauth:state:"
const STATE_TTL_SECONDS = 600

/**
 * Store a pending OAuth authorization state. The `oauthStateJson` is the JSON-encoded
 * parsed authorization request from `env.OAUTH_PROVIDER.parseAuthRequest()`.
 */
export const storeOAuthState = (
  env: BrainBindings,
  stateToken: string,
  oauthStateJson: string,
): Promise<void> =>
  env.OAUTH_KV.put(`${STATE_PREFIX}${stateToken}`, oauthStateJson, {
    expirationTtl: STATE_TTL_SECONDS,
  })

/**
 * Load a pending OAuth authorization state. Returns `null` if the token is unknown or
 * has expired (the KV TTL auto-cleans after 10 minutes).
 */
export const loadOAuthState = (env: BrainBindings, stateToken: string): Promise<string | null> =>
  env.OAUTH_KV.get(`${STATE_PREFIX}${stateToken}`)

/**
 * Delete a used OAuth authorization state (one-time use — burn after reading at /callback).
 */
export const deleteOAuthState = (env: BrainBindings, stateToken: string): Promise<void> =>
  env.OAUTH_KV.delete(`${STATE_PREFIX}${stateToken}`)

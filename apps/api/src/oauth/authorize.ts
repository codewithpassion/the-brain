/**
 * OAuth 2.1 authorize + callback handlers — the Clerk-upstream IdP flow.
 *
 * Mounted on the Hono app (which runs as `defaultHandler` inside `OAuthProvider`):
 *
 *   GET  /authorize  — parse the client's OAuth request; store it in OAUTH_KV under a random
 *                      state token; return an HTML page that loads Clerk JS and, after sign-in,
 *                      redirects the browser to /callback with the Clerk session JWT in the URL.
 *   GET  /callback   — validate the state token (CSRF); validate the Clerk JWT with our
 *                      ClerkVerifier; resolve userId → active tenant → Principal; call
 *                      `env.OAUTH_PROVIDER.completeAuthorization` to mint the auth code and
 *                      redirect back to the MCP client.
 *
 * Both handlers are no-ops (503) when `env.OAUTH_PROVIDER` is absent, i.e. when the app is
 * called directly in tests that bypass the OAuthProvider wrapper.
 *
 * Security note: passing the Clerk JWT in a query parameter (`?token=`) is a minimal-boot
 * shortcut (logs, browser history). A hardened production implementation should POST to /callback
 * or use the `fragment` URI scheme. Left as a TODO for the in-browser verification pass.
 */
import {
  type ClerkVerifier,
  createClerkVerifier,
  deleteOAuthState,
  loadOAuthState,
  resolvePrincipal,
  storeOAuthState,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"

/** Options injected from `createApp` (matching its own `CreateAppOptions`). */
export interface MountOAuthOptions {
  clerkVerifier?: ClerkVerifier
}

type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

/**
 * Return a cryptographically random hex state token (32 bytes = 64 hex chars).
 * We use WebCrypto directly — it is always available in the Workers runtime.
 */
const randomStateToken = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export const mountOAuthHandlers = (app: Hono<AppEnv>, options: MountOAuthOptions = {}): void => {
  /**
   * GET /authorize
   *
   * Entry point for an MCP client's OAuth flow. Validates the request, stores the parsed
   * OAuth parameters in KV, and returns an HTML page that authenticates the user via Clerk JS.
   */
  app.get("/authorize", async (c) => {
    const oauth = c.env.OAUTH_PROVIDER
    if (!oauth) return c.text("OAuth provider not configured", 503)

    // Parse and validate the OAuth request (client_id, redirect_uri, PKCE, scope, state).
    const oauthReqInfo = await oauth.parseAuthRequest(c.req.raw)
    if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request: missing client_id", 400)

    // Store the parsed request under a fresh state token (prevents CSRF at /callback).
    const stateToken = randomStateToken()
    await storeOAuthState(c.env, stateToken, JSON.stringify(oauthReqInfo))

    const origin = new URL(c.req.url).origin
    const callbackBase = `${origin}/callback`
    const clerkFrontendApi = c.env.CLERK_FRONTEND_API
    const publishableKey = c.env.CLERK_PUBLISHABLE_KEY ?? ""

    // The HTML page loads Clerk's browser SDK, shows the sign-in form, and on success
    // redirects to /callback with the Clerk JWT and our state token in the query string.
    // TODO (hardening): use POST + form or message-passing instead of query param for the token.
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect to The Brain</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    #clerk-mount { margin-top: 1.5rem; }
  </style>
</head>
<body>
  <h1>Connect to The Brain</h1>
  <p>Sign in to authorise access.</p>
  <div id="clerk-mount"></div>
  <script>
    const CALLBACK_URL = ${JSON.stringify(callbackBase)};
    const STATE_TOKEN   = ${JSON.stringify(stateToken)};

    function redirect(token) {
      const url = new URL(CALLBACK_URL);
      url.searchParams.set('token', token);
      url.searchParams.set('state', STATE_TOKEN);
      window.location.href = url.toString();
    }

    const script = document.createElement('script');
    script.src = 'https://${clerkFrontendApi}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';
    script.setAttribute('data-clerk-publishable-key', ${JSON.stringify(publishableKey)});
    script.onload = async function() {
      const clerk = window.Clerk;
      await clerk.load();
      if (clerk.user) {
        redirect(await clerk.session.getToken());
        return;
      }
      clerk.mountSignIn(document.getElementById('clerk-mount'));
      clerk.addListener(async function(resources) {
        if (resources.user && resources.session) {
          redirect(await resources.session.getToken());
        }
      });
    };
    document.head.appendChild(script);
  </script>
</body>
</html>`

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  })

  /**
   * GET /callback
   *
   * Receives the Clerk JWT (`?token=`) and state token (`?state=`) after the user signs in.
   * Validates CSRF state, verifies the Clerk JWT, resolves the tenant → Principal, and calls
   * `completeAuthorization` to mint the auth code and redirect back to the MCP client.
   */
  app.get("/callback", async (c) => {
    const oauth = c.env.OAUTH_PROVIDER
    if (!oauth) return c.text("OAuth provider not configured", 503)

    const token = c.req.query("token")
    const stateToken = c.req.query("state")

    if (!(token && stateToken)) {
      return c.text("Missing token or state parameter", 400)
    }

    // CSRF validation: ensure the state token was issued by OUR /authorize handler.
    const storedReqJson = await loadOAuthState(c.env, stateToken)
    if (!storedReqJson) {
      return c.text("Invalid or expired state token", 400)
    }
    const oauthReqInfo = JSON.parse(storedReqJson) as Parameters<
      typeof oauth.completeAuthorization
    >[0]["request"]

    // Validate the Clerk JWT → extract the userId.
    const verifier = options.clerkVerifier ?? createClerkVerifier(c.env)
    const identity = await verifier.verify(token)
    if (!identity) {
      return c.text("Invalid Clerk token", 401)
    }

    // Resolve the userId → active tenant → Principal.
    // Default to `org_${userId}` (the user's personal org, auto-provisioned on first login);
    // honor a `tenant:<slug>` scope or `login_hint` if the client supplied one. This matches
    // the PRD design: "org_${userId} by default; honor a slug if present".
    let principal: import("@brain/shared").Principal
    try {
      const syntheticReq = new Request(c.req.url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const activeTenantSlug = extractTenantSlug(oauthReqInfo) ?? `org_${identity.userId}`
      principal = await resolvePrincipal(c.env, syntheticReq, {
        ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
        activeTenantSlug,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "auth error"
      return c.text(`Could not resolve tenant: ${msg}`, 401)
    }

    // Burn the state token (one-time use).
    await deleteOAuthState(c.env, stateToken)

    // Mint the authorization code and redirect the MCP client to its redirect_uri.
    const { redirectTo } = await oauth.completeAuthorization({
      request: oauthReqInfo,
      userId: identity.userId,
      scope: oauthReqInfo.scope,
      // props is the encrypted payload carried in every OAuth access token; the MCP handler
      // reads it as `ctx.props` (set by the OAuthProvider before calling the apiHandler).
      props: { principal } satisfies { principal: import("@brain/shared").Principal },
      metadata: { tenantId: principal.tenantId },
    })

    return Response.redirect(redirectTo, 302)
  })
}

/**
 * Extract an optional tenant slug from an OAuth request. The MCP client may embed it as a
 * scope (`tenant:<slug>`) or as a custom `login_hint` parameter. Returns undefined when absent.
 */
function extractTenantSlug(oauthReqInfo: {
  scope: string[]
  loginHint?: string
}): string | undefined {
  // Check for `tenant:<slug>` scope item.
  for (const s of oauthReqInfo.scope) {
    if (s.startsWith("tenant:")) return s.slice("tenant:".length)
  }
  // Fall back to login_hint (non-standard but widely used by MCP clients for account targeting).
  if (oauthReqInfo.loginHint) return oauthReqInfo.loginHint
  return undefined
}

/**
 * OAuth 2.1 authorize + callback handlers — the Clerk-upstream IdP flow.
 *
 * Mounted on the Hono app (which runs as `defaultHandler` inside `OAuthProvider`):
 *
 *   GET  /authorize       — parse the client's OAuth request; store it in OAUTH_KV under a
 *                           random state token; return an HTML page that loads Clerk JS and,
 *                           after sign-in, POSTs the Clerk JWT + chosen org to /callback.
 *   POST /authorize/orgs  — verify the Clerk JWT and return the list of orgs the user is a
 *                           member of (drives the org picker on the /authorize page).
 *   POST /callback        — validate state (CSRF); verify the Clerk JWT; resolve the chosen
 *                           tenant → Principal; call `completeAuthorization` to mint the auth
 *                           code; return `{ redirectTo }` JSON (page JS navigates the browser).
 *
 * All three handlers are no-ops (503) when `env.OAUTH_PROVIDER` is absent for callback, i.e.
 * when the app is called directly in tests that bypass the OAuthProvider wrapper.
 *
 * Security hardening (T9): the Clerk JWT is NEVER placed in a URL query parameter. After
 * sign-in the browser POSTs `{ token, state }` to `/callback` (same-origin fetch, JSON).
 * The final redirect to the MCP client's `redirect_uri?code=...` is a normal browser navigation
 * driven by `window.location = redirectTo` after the page receives `{ redirectTo }` JSON.
 *
 * Org picker (T10): after sign-in the page fetches `/authorize/orgs` (POST, same-origin) to
 * retrieve the user's org list. If the user belongs to more than one org, a simple picker is
 * rendered and the chosen org id is included in the `/callback` POST. Single-org users skip
 * the picker. The chosen tenant is re-validated server-side via `resolvePrincipal` /
 * `loadMembershipPrincipal`; a non-member choice returns 401.
 */
import {
  type ClerkVerifier,
  createClerkVerifier,
  deleteOAuthState,
  listOrgsForUserId,
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
   *
   * After sign-in the page JS:
   *   1. POSTs `{ token }` to `/authorize/orgs` to fetch the user's org list.
   *   2. Shows a picker if the user belongs to more than one org; auto-selects for single-org
   *      users.
   *   3. POSTs `{ token, state, tenantId? }` to `/callback` and navigates to `redirectTo`.
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

    const clerkFrontendApi = c.env.CLERK_FRONTEND_API
    const publishableKey = c.env.CLERK_PUBLISHABLE_KEY ?? ""

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
    #err { color: #c00; margin-top: 1rem; min-height: 1.2em; }
    select { display: block; margin: 0.5rem 0 1rem; width: 100%; padding: 0.3rem; }
    button { padding: 0.4rem 1rem; }
  </style>
</head>
<body>
  <h1>Connect to The Brain</h1>
  <p>Sign in to authorise access.</p>
  <div id="clerk-mount"></div>
  <p id="err"></p>
  <script>
    const STATE_TOKEN = ${JSON.stringify(stateToken)};

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showErr(msg) {
      document.getElementById('err').textContent = msg;
    }

    async function afterSignIn(token) {
      // Fetch the user's org list (never puts the token in the URL).
      let orgList = [];
      try {
        const r = await fetch('/authorize/orgs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (r.ok) orgList = (await r.json()).orgs ?? [];
      } catch (_) { /* treat as empty — brand-new user; /callback will auto-provision */ }

      if (orgList.length > 1) {
        showPicker(orgList, token);
      } else {
        // Single org or brand-new user: proceed immediately.
        await completeFlow(token, orgList[0]?.id ?? null);
      }
    }

    function showPicker(orgList, token) {
      const mount = document.getElementById('clerk-mount');
      const form = document.createElement('form');
      const opts = orgList.map(o =>
        '<option value="' + escHtml(o.id) + '">' + escHtml(o.name) + '</option>'
      ).join('');
      form.innerHTML =
        '<p>Choose which organisation to grant access to:</p>' +
        '<select name="orgId">' + opts + '</select>' +
        '<button type="submit">Continue</button>';
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        const orgId = new FormData(form).get('orgId');
        await completeFlow(token, orgId);
      });
      mount.replaceChildren(form);
    }

    async function completeFlow(token, tenantId) {
      try {
        const body = { token: token, state: STATE_TOKEN };
        if (tenantId) body.tenantId = tenantId;
        const r = await fetch('/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (r.ok) {
          const data = await r.json();
          window.location.href = data.redirectTo;
        } else {
          const data = await r.json().catch(() => ({}));
          showErr(data.error ?? 'Authorization failed. Please try again.');
        }
      } catch (_) {
        showErr('Network error. Please try again.');
      }
    }

    const script = document.createElement('script');
    script.src = 'https://${clerkFrontendApi}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';
    script.setAttribute('data-clerk-publishable-key', ${JSON.stringify(publishableKey)});
    script.onload = async function() {
      const clerk = window.Clerk;
      await clerk.load();
      if (clerk.user) {
        await afterSignIn(await clerk.session.getToken());
        return;
      }
      clerk.mountSignIn(document.getElementById('clerk-mount'));
      clerk.addListener(async function(resources) {
        if (resources.user && resources.session) {
          await afterSignIn(await resources.session.getToken());
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
   * POST /authorize/orgs
   *
   * Verifies the Clerk JWT (from the sign-in page) and returns the list of orgs the user
   * is a member of. Used by the `/authorize` page to populate the org picker before the
   * user submits the final `/callback` POST. The JWT is in the JSON body — never in the URL.
   *
   * Does NOT consume the OAuth state token (only `/callback` burns it).
   */
  app.post("/authorize/orgs", async (c) => {
    let body: { token?: string }
    try {
      body = (await c.req.json()) as { token?: string }
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400)
    }
    const { token } = body
    if (!token) return c.json({ error: "Missing token" }, 400)

    const verifier = options.clerkVerifier ?? createClerkVerifier(c.env)
    const identity = await verifier.verify(token)
    if (!identity) return c.json({ error: "Invalid Clerk token" }, 401)

    const userOrgs = await listOrgsForUserId(c.env, identity.userId)
    return c.json({ orgs: userOrgs })
  })

  /**
   * POST /callback
   *
   * Receives `{ token, state, tenantId? }` as JSON from the `/authorize` page after the user
   * signs in (and optionally chooses an org). The Clerk JWT is NEVER in the URL.
   *
   * Steps:
   *   1. CSRF: validate `state` against OAUTH_KV (10-min TTL, same as before).
   *   2. Verify the Clerk JWT → extract `userId`.
   *   3. Resolve tenant: `tenantId` from body → `tenant:<slug>` scope / login_hint → personal org.
   *   4. `resolvePrincipal` re-checks membership (non-member tenantId → 401 JSON).
   *   5. Burn the state token (one-time use).
   *   6. `completeAuthorization` → mint auth code.
   *   7. Return `{ redirectTo }` JSON — the page JS navigates the browser.
   */
  app.post("/callback", async (c) => {
    const oauth = c.env.OAUTH_PROVIDER
    if (!oauth) return c.text("OAuth provider not configured", 503)

    let body: { token?: string; state?: string; tenantId?: string }
    try {
      body = (await c.req.json()) as { token?: string; state?: string; tenantId?: string }
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400)
    }

    const { token, state: stateToken, tenantId } = body

    if (!(token && stateToken)) {
      return c.json({ error: "Missing token or state" }, 400)
    }

    // CSRF validation: ensure the state token was issued by OUR /authorize handler.
    const storedReqJson = await loadOAuthState(c.env, stateToken)
    if (!storedReqJson) {
      return c.json({ error: "Invalid or expired state token" }, 400)
    }
    const oauthReqInfo = JSON.parse(storedReqJson) as Parameters<
      typeof oauth.completeAuthorization
    >[0]["request"]

    // Validate the Clerk JWT → extract the userId.
    const verifier = options.clerkVerifier ?? createClerkVerifier(c.env)
    const identity = await verifier.verify(token)
    if (!identity) {
      return c.json({ error: "Invalid Clerk token" }, 401)
    }

    // Resolve the userId → active tenant → Principal.
    // Priority: explicit `tenantId` from org picker → `tenant:<slug>` scope or login_hint →
    // personal org (`org_${userId}`, auto-provisioned for brand-new users).
    let principal: Principal
    try {
      const syntheticReq = new Request(c.req.url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const activeTenantSlug =
        tenantId ?? extractTenantSlug(oauthReqInfo) ?? `org_${identity.userId}`
      principal = await resolvePrincipal(c.env, syntheticReq, {
        ...(options.clerkVerifier ? { clerkVerifier: options.clerkVerifier } : {}),
        activeTenantSlug,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "auth error"
      return c.json({ error: `Could not resolve tenant: ${msg}` }, 401)
    }

    // Burn the state token (one-time use).
    await deleteOAuthState(c.env, stateToken)

    // Mint the authorization code and return the redirect URL as JSON.
    // The page JS (`window.location.href = redirectTo`) performs the final browser navigation
    // to the MCP client's redirect_uri — the JWT never appears in any URL.
    const { redirectTo } = await oauth.completeAuthorization({
      request: oauthReqInfo,
      userId: identity.userId,
      scope: oauthReqInfo.scope,
      props: { principal } satisfies { principal: Principal },
      metadata: { tenantId: principal.tenantId },
    })

    return c.json({ redirectTo })
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

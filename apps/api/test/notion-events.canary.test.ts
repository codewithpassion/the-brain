import { env } from "cloudflare:test"
import {
  type BrainBindings,
  completeNotionConnection,
  confirmNotionConnectionOp,
  encryptToken,
  resolveNotionWorkspaceFromEnv,
  storeNotionOAuthNonce,
  storeNotionPendingGrant,
} from "@brain/db"
import type { NotionClient, NotionPageContent } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import { beforeAll, describe, expect, test } from "vitest"
import type { BackfillBindings } from "../src/backfill"
import { createApp } from "../src/index"
import { NotionEventRejectError, runNotionEventMessage } from "../src/notion-events/consume"
import { seedMembership, seedOrg } from "./seed"

const encoder = new TextEncoder()
/** Sign a body the way Notion does, for the route-level webhook tests. */
const signHeader = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return `sha256=${Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")}`
}

/**
 * Phase-8 Notion webhook-event canary — the consumer path against real workerd D1 + R2, all Notion
 * HTTP stubbed (injected `clientFactory`). Proves the load-bearing isolation invariants:
 *   - `workspace_id → tenant` routing is tenant-isolated (WS_A → tenant A, WS_B → tenant B, unknown
 *     → null / dropped);
 *   - an event routed to tenant A ingests ONLY under tenant A, never tenant B (non-vacuous);
 *   - the ingested doc is stamped `source_kind='notion'` + `ingested_via='notion-event'`;
 *   - an unknown tenant fails closed (`NotionEventRejectError` → DLQ);
 *   - a delete event soft-deletes the doc.
 */

const env_ = env as unknown as BrainBindings
const bfEnv = env_ as unknown as BackfillBindings
const ENC_KEY = "notion-events-canary-key"

const TENANT_A = "ne-tA"
const TENANT_B = "ne-tB"
const WS_A = "ne-ws-a"
const WS_B = "ne-ws-b"
const TOKEN_A = "ntn_ev_token_a"
const TOKEN_B = "ntn_ev_token_b"

const principalFor = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["admin"],
  readOnly: false,
})

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

const eventEnv = (): BackfillBindings =>
  ({
    ...bfEnv,
    NOTION_TOKEN_ENC_KEY: ENC_KEY,
    AI: {
      run: async (_m: string, inputs: { text: string[] }) => ({
        data: inputs.text.map(() => vec1024()),
      }),
    },
    CHUNK_INDEX: {
      upsert: async () => {},
      query: async () => ({ matches: [] }),
      deleteByIds: async () => {},
    },
    ENTITY_INDEX: {
      upsert: async () => {},
      query: async () => ({ matches: [] }),
      deleteByIds: async () => {},
    },
  }) as unknown as BackfillBindings

const pageFor = (id: string, title: string): NotionPageContent => ({
  id,
  lastEditedTime: "2026-07-01T10:00:00.000Z",
  properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  blocks: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: `${title} body.` }] } }],
})

/** Per-token stub client: each tenant's token yields only that tenant's page (isolation proof). */
const clientFactory = (token: string): NotionClient => {
  const pages = token === TOKEN_A ? [pageFor("pgA", "Alpha")] : [pageFor("pgB", "Beta")]
  return {
    listChangedPages: async () => ({ pages: [], nextCursor: null }),
    getPageContent: async (pageId) => {
      const p = pages.find((x) => x.id === pageId)
      if (p === undefined) throw new Error(`stub: unknown page ${pageId}`)
      return p
    },
  }
}

const docBySlug = (tenantId: string, slug: string) =>
  env_.DB.prepare(
    "SELECT status, source_kind, ingested_via, deleted_at FROM documents WHERE tenant_id = ? AND slug = ?",
  )
    .bind(tenantId, slug)
    .first<{
      status: string
      source_kind: string | null
      ingested_via: string | null
      deleted_at: string | null
    }>()

describe("notion webhook-event consumer canary (real local D1 + R2)", () => {
  beforeAll(async () => {
    await seedOrg(TENANT_A, "ne-org-a")
    await seedOrg(TENANT_B, "ne-org-b")
    await seedMembership({ tenantId: TENANT_A, userId: "userA" })
    await seedMembership({ tenantId: TENANT_B, userId: "userB" })
    const e = eventEnv()
    await completeNotionConnection(e, principalFor(TENANT_A, "userA"), {
      workspaceId: WS_A,
      accessToken: TOKEN_A,
    })
    await completeNotionConnection(e, principalFor(TENANT_B, "userB"), {
      workspaceId: WS_B,
      accessToken: TOKEN_B,
    })
  })

  test("workspace→tenant routing is tenant-isolated and fail-closed on unknown", async () => {
    expect(await resolveNotionWorkspaceFromEnv(eventEnv(), WS_A)).toMatchObject({
      tenantId: TENANT_A,
    })
    expect(await resolveNotionWorkspaceFromEnv(eventEnv(), WS_B)).toMatchObject({
      tenantId: TENANT_B,
    })
    expect(await resolveNotionWorkspaceFromEnv(eventEnv(), "ne-ws-ghost")).toBeNull()
  })

  test("an event routed to tenant A ingests ONLY under A (never B), stamped notion-event", async () => {
    await runNotionEventMessage(
      eventEnv(),
      { tenantId: TENANT_A, workspaceId: WS_A, pageId: "pgA", action: "upsert" },
      { clientFactory },
    )

    const docA = await docBySlug(TENANT_A, "notion:pgA")
    expect(docA?.status).toBe("indexed")
    expect(docA?.source_kind).toBe("notion")
    expect(docA?.ingested_via).toBe("notion-event")

    // Non-vacuous isolation: the same slug is absent under tenant B.
    expect(await docBySlug(TENANT_B, "notion:pgA")).toBeNull()
  })

  test("unknown tenant → NotionEventRejectError (fail-closed → DLQ)", async () => {
    await expect(
      runNotionEventMessage(
        eventEnv(),
        { tenantId: "ghost-tenant", workspaceId: WS_A, pageId: "pgA", action: "upsert" },
        { clientFactory },
      ),
    ).rejects.toBeInstanceOf(NotionEventRejectError)
  })

  test("a delete event soft-deletes the doc", async () => {
    await runNotionEventMessage(
      eventEnv(),
      { tenantId: TENANT_A, workspaceId: WS_A, pageId: "pgA", action: "delete" },
      { clientFactory },
    )
    const docA = await docBySlug(TENANT_A, "notion:pgA")
    expect(docA?.deleted_at).not.toBeNull()
  })

  test("an undelete (page.undeleted → upsert) round-trips a trashed doc back to visible", async () => {
    // pgA was soft-deleted by the previous test; an undelete re-ingests (resurrects) it.
    await runNotionEventMessage(
      eventEnv(),
      { tenantId: TENANT_A, workspaceId: WS_A, pageId: "pgA", action: "upsert" },
      { clientFactory },
    )
    const docA = await docBySlug(TENANT_A, "notion:pgA")
    expect(docA?.deleted_at).toBeNull()
    expect(docA?.status).toBe("indexed")
  })
})

describe("GET /notion/callback route — stashes a pending grant, does NOT auto-persist", () => {
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext

  test("exchange → stash → redirect to ?confirm (no connection persisted until confirmed)", async () => {
    await storeNotionOAuthNonce(eventEnv(), "cb-nonce", TENANT_A)
    const realFetch = globalThis.fetch
    // Stub the Notion token exchange (exchangeNotionCode uses the global fetch).
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "ntn_cb",
            workspace_id: "ws-callback",
            workspace_name: "CB WS",
            bot_id: "bot",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    }) as unknown as typeof fetch
    try {
      const env2 = {
        ...eventEnv(),
        NOTION_CLIENT_ID: "cid",
        NOTION_CLIENT_SECRET: "csec",
      } as unknown as BackfillBindings
      const res = await createApp().fetch(
        new Request("https://api.test/notion/callback?code=abc&state=cb-nonce"),
        env2 as never,
        ctx,
      )
      expect(res.status).toBe(302)
      const loc = res.headers.get("location") ?? ""
      expect(loc).toContain("/notion?confirm=")
      expect(loc).toContain("workspace=")
      // The connection is NOT persisted until the same-principal confirm step runs.
      expect(await resolveNotionWorkspaceFromEnv(eventEnv(), "ws-callback")).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("confirm_notion_connection — same-principal confirmation (login-CSRF defence)", () => {
  const stashGrant = async (confirmToken: string, tenantId: string, workspaceId: string) =>
    storeNotionPendingGrant(eventEnv(), confirmToken, {
      tenantId,
      workspaceId,
      workspaceName: workspaceId,
      botId: "bot",
      accessTokenCipher: await encryptToken(ENC_KEY, "ntn_pending_token"),
      refreshTokenCipher: null,
    })

  test("an admin of the bound tenant confirms → the connection persists", async () => {
    await stashGrant("ct-happy", TENANT_A, "ws-confirm-a")
    const out = await confirmNotionConnectionOp.handler(
      { env: eventEnv(), principal: principalFor(TENANT_A, "userA") },
      { confirmToken: "ct-happy" },
    )
    expect(out.confirmed).toBe(true)
    expect(await resolveNotionWorkspaceFromEnv(eventEnv(), "ws-confirm-a")).toMatchObject({
      tenantId: TENANT_A,
    })
  })

  test("a DIFFERENT tenant cannot confirm (403); the grant survives so the real tenant still can", async () => {
    await stashGrant("ct-evil", TENANT_A, "ws-evil")

    // Wrong tenant → 403, and the workspace is NEVER persisted to anyone.
    await expect(
      confirmNotionConnectionOp.handler(
        { env: eventEnv(), principal: principalFor(TENANT_B, "userB") },
        { confirmToken: "ct-evil" },
      ),
    ).rejects.toThrow()
    expect(await resolveNotionWorkspaceFromEnv(eventEnv(), "ws-evil")).toBeNull()

    // Defense-in-depth: the mismatch did NOT burn the token — the bound tenant can still confirm.
    const out = await confirmNotionConnectionOp.handler(
      { env: eventEnv(), principal: principalFor(TENANT_A, "userA") },
      { confirmToken: "ct-evil" },
    )
    expect(out.confirmed).toBe(true)
    expect(await resolveNotionWorkspaceFromEnv(eventEnv(), "ws-evil")).toMatchObject({
      tenantId: TENANT_A,
    })
  })

  test("an expired / unknown confirm token → confirmed:false (no throw)", async () => {
    const out = await confirmNotionConnectionOp.handler(
      { env: eventEnv(), principal: principalFor(TENANT_A, "userA") },
      { confirmToken: "does-not-exist" },
    )
    expect(out.confirmed).toBe(false)
  })
})

describe("POST /notion/webhook route — handshake gating (first-write-wins, no-op when configured)", () => {
  const KEY = "notion:webhook:verification_token"
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext

  const handshake = (env2: BackfillBindings, token: string) =>
    createApp().fetch(
      new Request("https://api.test/notion/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verification_token: token }),
      }),
      env2 as never,
      ctx,
    )

  test("first handshake stores; a second does NOT overwrite (first-write-wins)", async () => {
    await env_.OAUTH_KV.delete(KEY)
    const env2 = eventEnv() // NOTION_WEBHOOK_TOKEN unset → store path
    expect((await handshake(env2, "tok-first")).status).toBe(200)
    expect(await env_.OAUTH_KV.get(KEY)).toBe("tok-first")
    expect((await handshake(env2, "tok-attacker")).status).toBe(200)
    expect(await env_.OAUTH_KV.get(KEY)).toBe("tok-first") // unchanged — clobber refused
  })

  test("handshake is a no-op once NOTION_WEBHOOK_TOKEN is configured", async () => {
    await env_.OAUTH_KV.delete(KEY)
    const env2 = {
      ...eventEnv(),
      NOTION_WEBHOOK_TOKEN: "already-set",
    } as unknown as BackfillBindings
    expect((await handshake(env2, "sneaky")).status).toBe(200)
    expect(await env_.OAUTH_KV.get(KEY)).toBeNull() // nothing stored
  })
})

describe("POST /notion/webhook route — signature is verified BEFORE enqueue", () => {
  const WEBHOOK_SECRET = "wh-secret-xyz"
  const body = JSON.stringify({
    type: "page.content_updated",
    entity: { id: "pgA" },
    workspace_id: WS_A,
  })

  /** Build an env with the webhook secret + a spy queue that counts sends. */
  const routeEnv = (counter: { sent: number }) =>
    ({
      ...eventEnv(),
      NOTION_WEBHOOK_TOKEN: WEBHOOK_SECRET,
      NOTION_EVENTS_QUEUE: {
        send: async () => {
          counter.sent += 1
        },
      },
    }) as unknown as BackfillBindings

  const post = (env2: BackfillBindings, signature: string | null) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (signature !== null) headers["x-notion-signature"] = signature
    return createApp().fetch(
      new Request("https://api.test/notion/webhook", { method: "POST", headers, body }),
      env2 as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    )
  }

  test("a bad signature → 401 and NEVER enqueues", async () => {
    const counter = { sent: 0 }
    const res = await post(routeEnv(counter), "sha256=deadbeef")
    expect(res.status).toBe(401)
    expect(counter.sent).toBe(0)
  })

  test("a valid signature for a known workspace → 200 and enqueues once", async () => {
    const counter = { sent: 0 }
    const res = await post(routeEnv(counter), await signHeader(WEBHOOK_SECRET, body))
    expect(res.status).toBe(200)
    expect(counter.sent).toBe(1)
  })
})

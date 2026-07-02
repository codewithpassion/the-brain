import { env } from "cloudflare:test"
import {
  type BrainBindings,
  completeNotionConnection,
  disconnectNotionOp,
  SourceStore,
} from "@brain/db"
import type { NotionClient, NotionPageContent } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { type BackfillBindings, type BackfillMessage, runBackfillMessage } from "../src/backfill"
import { runNotionPollSweep } from "../src/notion/sweep"
import { seedMembership, seedOrg } from "./seed"

/**
 * Phase-8 Notion poll canary — the connect→poll→ingest→revoke-stops-sync lifecycle end-to-end
 * against real workerd D1 + R2, with ALL Notion HTTP stubbed (injected `clientFactory`). Proves:
 *   - a poll enumerates changed pages → stages → the backfill consumer ingests them as documents
 *     stamped `source_kind='notion'` (the delete-safety boundary) + `ingested_via='notion-poll'`;
 *   - tenant isolation: tenant A's poll uses A's token/pages and never writes tenant B (and vice
 *     versa) — non-vacuous (both tenants seeded, distinct pages);
 *   - the `last_sync_at` watermark advances so a second poll re-scans nothing;
 *   - disconnect archives the source → the next poll is a no-op (sync stops).
 */

const env_ = env as unknown as BrainBindings
const bfEnv = env_ as unknown as BackfillBindings
const ENC_KEY = "notion-poll-canary-key"

const TENANT_A = "np-tA"
const TENANT_B = "np-tB"
const WS_A = "np-ws-a"
const WS_B = "np-ws-b"
const TOKEN_A = "ntn_token_a"
const TOKEN_B = "ntn_token_b"
const EDITED = "2026-07-01T09:00:00.000Z"
const NOW = new Date("2026-07-01T12:00:00.000Z")

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

/** AI + Vectorize mocks (so `runBatchIngest` completes) + the Notion encryption key. */
const pollEnv = (): BackfillBindings =>
  ({
    ...bfEnv,
    NOTION_TOKEN_ENC_KEY: ENC_KEY,
    AI: {
      run: async (_model: string, inputs: { text: string[] }) => ({
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

const principal = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["admin"],
  readOnly: false,
})

const pA = principal(TENANT_A, "userA")

/** A stub NotionClient over a fixed page set, honouring the `since` watermark (>= filter). */
const stubClient = (pages: NotionPageContent[]): NotionClient => ({
  listChangedPages: async ({ since }) => {
    const visible = pages.filter((p) => since === undefined || p.lastEditedTime >= since)
    return {
      pages: visible.map((p) => ({ id: p.id, lastEditedTime: p.lastEditedTime })),
      nextCursor: null,
    }
  },
  getPageContent: async (pageId) => {
    const page = pages.find((p) => p.id === pageId)
    if (page === undefined) throw new Error(`stub: unknown page ${pageId}`)
    return page
  },
})

const pageA: NotionPageContent = {
  id: "pageA",
  lastEditedTime: EDITED,
  properties: {
    Name: { type: "title", title: [{ plain_text: "Alpha Doc" }] },
    Stage: { type: "select", select: { name: "active" } },
  },
  parentPath: ["Workspace A"],
  blocks: [
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Alpha body content." }] } },
  ],
}
const pageB: NotionPageContent = {
  id: "pageB",
  lastEditedTime: EDITED,
  properties: { Name: { type: "title", title: [{ plain_text: "Beta Doc" }] } },
  blocks: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Beta body content." }] } }],
}

/** Map each tenant's bot token to its own page set (proves per-tenant client isolation). */
const clientFactory = (token: string): NotionClient => {
  if (token === TOKEN_A) return stubClient([pageA])
  if (token === TOKEN_B) return stubClient([pageB])
  throw new Error(`stub: unexpected token ${token}`)
}

/** Run one poll sweep and drive the enqueued messages through the real backfill ingest consumer. */
const pollAndIngest = async (env2: BackfillBindings, now: Date): Promise<BackfillMessage[]> => {
  const captured: BackfillMessage[] = []
  await runNotionPollSweep(env2, {
    enqueue: async (m) => {
      captured.push(m)
    },
    clientFactory,
    tenantIds: [TENANT_A, TENANT_B],
    now,
  })
  for (const m of captured) await runBackfillMessage(env2, m)
  return captured
}

const docBySlug = (tenantId: string, slug: string) =>
  env_.DB.prepare(
    "SELECT id, status, source_kind, ingested_via, path, tags, deleted_at FROM documents WHERE tenant_id = ? AND slug = ?",
  )
    .bind(tenantId, slug)
    .first<{
      id: string
      status: string
      source_kind: string | null
      ingested_via: string | null
      path: string | null
      tags: string | null
      deleted_at: string | null
    }>()

describe("notion poll lifecycle canary (real local D1 + R2)", () => {
  beforeAll(async () => {
    await seedOrg(TENANT_A, "np-org-a")
    await seedOrg(TENANT_B, "np-org-b")
    await seedMembership({ tenantId: TENANT_A, userId: "userA" })
    await seedMembership({ tenantId: TENANT_B, userId: "userB" })
    const env2 = pollEnv()
    await completeNotionConnection(env2, principal(TENANT_A, "userA"), {
      workspaceId: WS_A,
      accessToken: TOKEN_A,
    })
    await completeNotionConnection(env2, principal(TENANT_B, "userB"), {
      workspaceId: WS_B,
      accessToken: TOKEN_B,
    })
  })

  test("poll → ingest stamps source_kind='notion' + ingested_via='notion-poll', tenant-isolated", async () => {
    const env2 = pollEnv()
    const captured = await pollAndIngest(env2, NOW)

    // Each tenant enumerated exactly its own page.
    expect(captured.filter((m) => m.tenantId === TENANT_A).map((m) => m.stableSlug)).toEqual([
      "notion:pageA",
    ])
    expect(captured.filter((m) => m.tenantId === TENANT_B).map((m) => m.stableSlug)).toEqual([
      "notion:pageB",
    ])
    // The message carries the delete-safety stamp + provenance.
    const aMsg = captured.find((m) => m.tenantId === TENANT_A)
    expect(aMsg?.sourceKind).toBe("notion")
    expect(aMsg?.ingestedVia).toBe("notion-poll")

    // Tenant A's doc is ingested, correctly stamped, with path + tags from the page.
    const docA = await docBySlug(TENANT_A, "notion:pageA")
    expect(docA?.status).toBe("indexed")
    expect(docA?.source_kind).toBe("notion")
    expect(docA?.ingested_via).toBe("notion-poll")
    expect(docA?.path).toBe("/Workspace A")
    expect(docA?.tags).toBe(JSON.stringify(["active"]))

    // Tenant B's doc exists under B and NOT under A (isolation, non-vacuous).
    expect(await docBySlug(TENANT_B, "notion:pageB")).not.toBeNull()
    expect(await docBySlug(TENANT_A, "notion:pageB")).toBeNull()
    expect(await docBySlug(TENANT_B, "notion:pageA")).toBeNull()
  })

  test("the last_sync_at watermark advances so a second poll re-scans nothing", async () => {
    const env2 = pollEnv()
    // The first test already advanced last_sync_at to NOW; pages are older than NOW → 0 enumerated.
    const captured = await pollAndIngest(env2, new Date("2026-07-01T13:00:00.000Z"))
    expect(captured).toEqual([])
  })

  test("an archived page in the delta soft-deletes its doc (opportunistic poll delete)", async () => {
    const env2 = pollEnv()
    // pageA (ingested in the first test) is now archived and edited after the watermark. The stub
    // surfaces it as an archived ref → the importer's onArchived soft-deletes it (no page fetch).
    const factory = (_token: string): NotionClient => ({
      listChangedPages: async () => ({
        pages: [{ id: "pageA", lastEditedTime: "2026-07-01T16:00:00.000Z", archived: true }],
        nextCursor: null,
      }),
      getPageContent: async () => {
        throw new Error("archived pages must not be fetched")
      },
    })
    const captured: BackfillMessage[] = []
    await runNotionPollSweep(env2, {
      enqueue: async (m) => {
        captured.push(m)
      },
      clientFactory: factory,
      tenantIds: [TENANT_A],
      now: new Date("2026-07-01T17:00:00.000Z"),
    })
    expect(captured).toEqual([]) // no upsert enqueued for an archived page
    const docA = await docBySlug(TENANT_A, "notion:pageA")
    expect(docA?.deleted_at).not.toBeNull()
  })

  test("disconnect archives the source → the next poll is a no-op (sync stops)", async () => {
    const env2 = pollEnv()
    const out = await disconnectNotionOp.handler(
      { env: env2, principal: pA },
      { workspaceId: WS_A },
    )
    expect(out).toEqual({ revoked: true })

    // Even a fresh full poll (no `since`, via a brand-new edit) enqueues nothing for A: the source
    // is archived, so listReenqueuable skips it. Use a page edited AFTER the watermark to prove the
    // stop is the archive, not the watermark.
    const freshPage: NotionPageContent = { ...pageA, lastEditedTime: "2026-07-01T14:00:00.000Z" }
    const factory = (token: string): NotionClient =>
      token === TOKEN_A ? stubClient([freshPage]) : stubClient([pageB])
    const captured: BackfillMessage[] = []
    await runNotionPollSweep(env2, {
      enqueue: async (m) => {
        captured.push(m)
      },
      clientFactory: factory,
      tenantIds: [TENANT_A],
      now: new Date("2026-07-01T15:00:00.000Z"),
    })
    expect(captured).toEqual([])
  })
})

describe("notion poll — fault isolation + tenant-guarded source upsert", () => {
  const TENANT_C = "np-tC"
  const TENANT_D = "np-tD"
  const WS_C = "np-ws-c"
  const WS_D = "np-ws-d"
  const TOKEN_D = "ntn_token_d"

  beforeAll(async () => {
    await seedOrg(TENANT_C, "np-org-c")
    await seedOrg(TENANT_D, "np-org-d")
    await seedMembership({ tenantId: TENANT_C, userId: "userC" })
    await seedMembership({ tenantId: TENANT_D, userId: "userD" })
    const env2 = pollEnv()
    await completeNotionConnection(env2, principal(TENANT_C, "userC"), {
      workspaceId: WS_C,
      accessToken: "ntn_token_c",
    })
    await completeNotionConnection(env2, principal(TENANT_D, "userD"), {
      workspaceId: WS_D,
      accessToken: TOKEN_D,
    })
    // Corrupt tenant C's stored ciphertext so its decrypt throws mid-sweep.
    await env_.DB.prepare(
      "UPDATE notion_connections SET token_ciphertext = ? WHERE workspace_id = ?",
    )
      .bind("not-valid-ciphertext", WS_C)
      .run()
  })

  test("one tenant's corrupt token fails closed; other tenants still sync", async () => {
    const env2 = pollEnv()
    const pageD: NotionPageContent = {
      id: "pageD",
      lastEditedTime: EDITED,
      properties: { Name: { type: "title", title: [{ plain_text: "Delta Doc" }] } },
      blocks: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Delta body." }] } }],
    }
    const factory = (token: string): NotionClient => {
      if (token !== TOKEN_D) throw new Error("stub: only tenant D has a usable token")
      return stubClient([pageD])
    }
    const captured: BackfillMessage[] = []
    await runNotionPollSweep(env2, {
      enqueue: async (m) => {
        captured.push(m)
      },
      clientFactory: factory,
      tenantIds: [TENANT_C, TENANT_D],
      now: NOW,
    })
    for (const m of captured) await runBackfillMessage(env2, m)

    // D synced despite C's decrypt failure aborting nothing.
    expect(captured.map((m) => m.tenantId)).toEqual([TENANT_D])
    expect(await docBySlug(TENANT_D, "notion:pageD")).not.toBeNull()
    // C recorded a failure (backoff bumped), no doc.
    const cSource = await env_.DB.prepare("SELECT sync_fail_count FROM sources WHERE id = ?")
      .bind(`notion:${WS_C}`)
      .first<{ sync_fail_count: number }>()
    expect(cSource?.sync_fail_count).toBeGreaterThanOrEqual(1)
  })

  test("SourceStore.create cannot mutate another tenant's row on an id collision", async () => {
    const db = drizzle(env_.DB)
    const sX = new SourceStore(db, principal("np-tX", "uX"))
    const sY = new SourceStore(db, principal("np-tY", "uY"))
    await sX.create({ id: "collide-1", name: "X-source", kind: "notion", config: '{"o":"x"}' })
    // Tenant Y attempts the SAME globally-unique id — must NOT overwrite X's row.
    await sY.create({ id: "collide-1", name: "Y-source", kind: "notion", config: '{"o":"y"}' })

    const row = await env_.DB.prepare("SELECT tenant_id, name, config FROM sources WHERE id = ?")
      .bind("collide-1")
      .first<{ tenant_id: string; name: string; config: string }>()
    expect(row?.tenant_id).toBe("np-tX")
    expect(row?.name).toBe("X-source") // Y's update did NOT apply
    expect(row?.config).toBe('{"o":"x"}')
    expect(await sY.get("collide-1")).toBeNull() // Y sees no such source (tenant-scoped)
  })
})

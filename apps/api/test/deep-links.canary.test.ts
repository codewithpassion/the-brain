import { env } from "cloudflare:test"
import type { BrainBindings } from "@brain/db"
import type { Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext } from "@brain/surface"
import { beforeAll, describe, expect, test } from "vitest"
import { seedMembership, seedOrg } from "./seed"

/**
 * Deep-link canary — drives the REAL surface catalog (with `withDeepLinks` wrapping every op) over
 * local D1 in workerd, proving that read results carry a `url` deep link into the dashboard built
 * from `ctx.env.DASHBOARD_URL`. Complements the pure `decorateWithUrls` unit test (packages/surface):
 * that one guards the switch logic; THIS one proves the real op output shapes match the casts AND
 * that DASHBOARD_URL is actually threaded end-to-end. Also asserts the local-dev floor: no
 * DASHBOARD_URL → no `url` key (output byte-identical).
 */

const env_ = env as unknown as BrainBindings
const BASE = (env as unknown as { DASHBOARD_URL: string }).DASHBOARD_URL.replace(/\/+$/, "")

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

const fakeAi = {
  run: async (_model: string, inputs: Record<string, unknown>) => ({
    data: ((inputs.text as string[] | undefined) ?? [""]).map(() => vec1024()),
  }),
} as unknown as BrainBindings["AI"]

const fakeVectorize = {
  upsert: async (vectors: { id: string }[]) => ({
    mutationId: "fake",
    count: vectors.length,
    ids: vectors.map((v) => v.id),
  }),
  query: async () => ({ count: 0, matches: [] }),
} as unknown as Vectorize

/** ctx.env WITHOUT BATCH_INGEST → the ingest spine (add_thought, wiki backing-doc) runs inline. */
const baseEnv = {
  ...env_,
  CHUNK_INDEX: fakeVectorize,
  ENTITY_INDEX: fakeVectorize,
  AI: fakeAi,
  AI_GATEWAY_ID: "test-gateway",
  BATCH_INGEST: undefined,
} as unknown as SurfaceContext["env"]

const principal: Principal = {
  tenantId: "linksA",
  userId: "ownerA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
}

const ctxWith = (dashboardUrl: string): SurfaceContext => ({
  principal,
  env: { ...baseEnv, DASHBOARD_URL: dashboardUrl } as SurfaceContext["env"],
  waitUntil: () => {},
  surface: "mcp",
})

const ctx = ctxWith(BASE)
const catalog = buildCatalog()
const op = (name: string) => {
  const found = catalog.find((o) => o.def.name === name)
  if (found === undefined) throw new Error(`op ${name} missing from catalog`)
  return found
}

const NEEDLE = "zeddelinkneedle"
let docId = ""

beforeAll(async () => {
  await seedOrg("linksA", "links-a")
  await seedMembership({ tenantId: "linksA", userId: "ownerA" })

  const thought = (await op("add_thought").invoke(ctx, {
    thought: `remember the ${NEEDLE} plan for next quarter`,
    tags: ["plan"],
  })) as { documentId: string }
  docId = thought.documentId

  await op("memory_set").invoke(ctx, {
    slug: "agent/links/pref",
    type: "preference",
    body: "prefer deep links in tool output",
  })

  await op("wiki_save_page").invoke(ctx, {
    slug: "guides/links-demo",
    type: "guide",
    title: "Links demo",
    body: "A page for the deep-link canary.",
  })
})

describe("deep-link canary — real catalog over local D1 in workerd", () => {
  test("get_document carries the document url", async () => {
    const out = (await op("get_document").invoke(ctx, { documentId: docId })) as { url?: string }
    expect(out.url).toBe(`${BASE}/documents/${docId}`)
  })

  test("search hits carry the document url", async () => {
    const out = (await op("search").invoke(ctx, { query: NEEDLE, topK: 12 })) as {
      hits: { documentId: string; url?: string }[]
    }
    const hit = out.hits.find((h) => h.documentId === docId)
    expect(hit).toBeDefined()
    expect(hit?.url).toBe(`${BASE}/documents/${docId}`)
  })

  test("memory_get carries the memory url (slug with slashes)", async () => {
    const out = (await op("memory_get").invoke(ctx, { slug: "agent/links/pref" })) as {
      memory: { url?: string } | null
    }
    expect(out.memory?.url).toBe(`${BASE}/memory/agent/links/pref`)
  })

  test("wiki_get_page carries the page url", async () => {
    const out = (await op("wiki_get_page").invoke(ctx, { target: "guides/links-demo" })) as {
      page: { url?: string } | null
    }
    expect(out.page?.url).toBe(`${BASE}/wiki/guides/links-demo`)
  })

  test("wiki_list_pages entries carry page urls", async () => {
    const out = (await op("wiki_list_pages").invoke(ctx, {})) as {
      pages: { slug: string; url?: string }[]
    }
    const entry = out.pages.find((p) => p.slug === "guides/links-demo")
    expect(entry?.url).toBe(`${BASE}/wiki/guides/links-demo`)
  })

  test("local-dev floor: no DASHBOARD_URL → no `url` key (byte-identical output)", async () => {
    const out = (await op("get_document").invoke(ctxWith(""), { documentId: docId })) as Record<
      string,
      unknown
    >
    expect("url" in out).toBe(false)
  })
})

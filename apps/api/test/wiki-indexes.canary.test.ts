import { env } from "cloudflare:test"
import {
  type BrainBindings,
  createDreamIndexesServices,
  runDreamIndexes,
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { describe, expect, test } from "vitest"

/**
 * W5 index-page canary — the auto-maintained OKF index pages + `indexes` dream kind, over REAL local
 * D1 in workerd. Proves the SECURITY property (a world index leaks no private child), idempotency
 * (unchanged data → no new revision), and the anti-loop (an index page is not a reflection target).
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "wIx",
  userId: "u1",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
  ...overrides,
})

/**
 * The REAL principal the `dream_now kind='indexes'` admin op dispatches with — a non-system user who
 * owns private/team pages. `createDreamIndexesServices` MUST coerce this to a system principal
 * internally; feeding a hand-made `system()` here would only test a principal prod never supplies.
 */
const dispatcher = (tenantId: string, o: Partial<Principal> = {}): Principal =>
  principal({ tenantId, userId: "u1", role: "admin", ...o })
const wiki = (o: Partial<Principal> = {}) => new WikiStore(raw(), principal(o))

const indexBody = async (tenantId: string, slug: string): Promise<string | null> => {
  const row = await env_.DB.prepare(
    `SELECT compiled_truth AS body FROM pages WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
  )
    .bind(tenantId, slug)
    .first<{ body: string }>()
  return row?.body ?? null
}
/** How many revisions a page has (a no-op save appends none). */
const revisionCount = async (tenantId: string, slug: string): Promise<number> => {
  const row = await env_.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_revisions pr JOIN pages p ON p.id = pr.page_id
     WHERE p.tenant_id = ? AND p.slug = ?`,
  )
    .bind(tenantId, slug)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const runIndexes = (tenantId: string, runId: string, caller: Principal = dispatcher(tenantId)) =>
  runDreamIndexes(createDreamIndexesServices(env_, caller), { runId })

describe("wiki indexes — leak-safety, idempotency, anti-loop (W5)", () => {
  test("dispatched by a REAL admin, the world index leaks NEITHER their private NOR their team page", async () => {
    const t = "ixLeak"
    // The dispatching admin OWNS the private page and is a member of the team — so an un-coerced
    // visibilityPredicate(admin) would pull both into the child set. The coercion must exclude them.
    const admin = dispatcher(t, { teamIds: ["tA"] })
    const w = new WikiStore(raw(), admin)
    await w.savePage({
      slug: "ideas/public-plan",
      type: "note",
      title: "Public Plan",
      body: "A world-visible idea.",
      visibility: "world",
    })
    await w.savePage({
      slug: "ideas/secret-plan",
      type: "note",
      title: "Secret Plan",
      body: "A private idea nobody should index.",
      visibility: "private",
    })
    await w.savePage({
      slug: "ideas/team-plan",
      type: "note",
      title: "Team Plan",
      body: "A team idea nobody outside the team should see in a world index.",
      visibility: "team",
    })

    // Dispatch as the REAL admin (not a hand-fed system principal) — exercises the actual op path.
    const res = await runIndexes(t, `${t}-run1`, admin)
    expect(res.status).toBe("success")

    const body = await indexBody(t, "ideas/index")
    expect(body).not.toBeNull()
    // world child present…
    expect(body).toContain("ideas/public-plan")
    expect(body).toContain("Public Plan")
    // …private + team children ABSENT despite the dispatcher owning them (no slug/title leak)
    expect(body).not.toContain("ideas/secret-plan")
    expect(body).not.toContain("Secret Plan")
    expect(body).not.toContain("ideas/team-plan")
    expect(body).not.toContain("Team Plan")
  })

  test("a second run on unchanged data writes NO new revision (deterministic idempotency)", async () => {
    const t = "ixIdem"
    await wiki({ tenantId: t, userId: "u1" }).savePage({
      slug: "guides/onboarding",
      type: "guide",
      title: "Onboarding",
      body: "Welcome.",
      visibility: "world",
    })
    await runIndexes(t, `${t}-a`)
    const r1 = await revisionCount(t, "guides/index")
    expect(r1).toBe(1)
    await runIndexes(t, `${t}-b`)
    const r2 = await revisionCount(t, "guides/index")
    expect(r2).toBe(1) // byte-identical body → PageStore no-op → NO new revision
  })

  test("the ROOT index is generated (world), listing each namespace → its index", async () => {
    const t = "ixRoot"
    const w = wiki({ tenantId: t, userId: "u1" })
    await w.savePage({ slug: "ideas/a", type: "note", title: "A", body: "x", visibility: "world" })
    await w.savePage({ slug: "guides/b", type: "note", title: "B", body: "y", visibility: "world" })
    // a namespace-less top-level page also belongs on the root index
    await w.savePage({
      slug: "readme",
      type: "note",
      title: "Readme",
      body: "z",
      visibility: "world",
    })

    const res = await runIndexes(t, `${t}-r`)
    expect(res.status).toBe("success")

    const row = await env_.DB.prepare(
      `SELECT compiled_truth AS body, visibility FROM pages WHERE tenant_id = ? AND slug = 'index' AND deleted_at IS NULL`,
    )
      .bind(t)
      .first<{ body: string; visibility: string }>()
    expect(row).not.toBeNull() // the ROOT sentinel path actually ran
    expect(row?.visibility).toBe("world")
    expect(row?.body).toContain("[[ideas/index]]")
    expect(row?.body).toContain("[[guides/index]]")
    expect(row?.body).toContain("[[readme]]") // namespace-less page linked directly
  })

  test("an index page is provenance ingested_via='index' (excluded from reflection by W-i4)", async () => {
    const t = "ixProv"
    await wiki({ tenantId: t, userId: "u1" }).savePage({
      slug: "topics/x",
      type: "note",
      title: "X",
      body: "content",
      visibility: "world",
    })
    await runIndexes(t, `${t}-r`)
    const row = await env_.DB.prepare(
      `SELECT ingested_via AS via, visibility, type FROM pages WHERE tenant_id = ? AND slug = 'topics/index'`,
    )
      .bind(t)
      .first<{ via: string; visibility: string; type: string }>()
    expect(row?.via).toBe("index")
    expect(row?.visibility).toBe("world")
    expect(row?.type).toBe("index")

    // NO backing document (navigation, not knowledge — kept out of recall/think/W3).
    const doc = await env_.DB.prepare(
      `SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND slug = 'topics/index'`,
    )
      .bind(t)
      .first<{ n: number }>()
    expect(doc?.n).toBe(0)
  })
})

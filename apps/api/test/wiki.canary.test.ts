import { env } from "cloudflare:test"
import { type BrainBindings, MemoryStore, WikiStore } from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"

/**
 * THE v3/W1 wiki-isolation canary — first-class pages on the shared `pages` layer, against REAL
 * local D1 inside workerd (same harness as the memory/graph canaries). Proves, NON-VACUOUSLY:
 *   - tenant + scope + visibility isolation (a page in tenant A is never visible/mutable from B;
 *     a private page is not mutable by another user in the same tenant);
 *   - versioning (a second save appends a revision);
 *   - red links (an unresolved [[slug]] is recorded, then resolves when the target is created) —
 *     including the tenant-scoped retroactive resolution (a cross-tenant pending row NEVER creates
 *     a cross-tenant edge);
 *   - move re-points links (id preserved) + leaves a redirect stub + resolves red links to the new slug;
 *   - the two provenance lanes stay clean: `memory_*` is untouched by wiki writes, and a
 *     `wiki_save_page` onto a memory slug is rejected with a teaching error.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "wA",
  userId: "uA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
  ...overrides,
})

const wiki = (overrides: Partial<Principal> = {}) => new WikiStore(raw(), principal(overrides))
const memory = (overrides: Partial<Principal> = {}) => new MemoryStore(raw(), principal(overrides))

const count = async (sql: string, binds: unknown[] = []): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

describe("wiki create / get / versioning — real local D1 in workerd", () => {
  test("save then get returns body + frontmatter at version 1; a second save appends a revision", async () => {
    const w = wiki({ tenantId: "wc", userId: "u1" })
    const first = await w.savePage({
      slug: "guides/intro",
      type: "guide",
      title: "Intro",
      tags: ["onboarding"],
      body: "Welcome to the wiki.",
    })
    expect(first).toMatchObject({ slug: "guides/intro", version: 1, changed: true })

    const got = await w.getPage("guides/intro")
    expect(got?.page.type).toBe("guide")
    expect(got?.page.ingestedVia).toBe("wiki")
    expect(got?.body).toBe("Welcome to the wiki.")
    expect(got?.tags).toEqual(["onboarding"])
    expect(got?.revisions.map((r) => r.version)).toEqual([1])

    const second = await w.savePage({
      slug: "guides/intro",
      type: "guide",
      title: "Intro",
      tags: ["onboarding"],
      body: "Welcome to the wiki (v2).",
    })
    expect(second).toMatchObject({ version: 2, changed: true })

    const after = await w.getPage("guides/intro")
    expect(after?.body).toBe("Welcome to the wiki (v2).")
    expect(after?.revisions.map((r) => r.version)).toEqual([2, 1]) // newest-first
    // authorship: the principal is recorded as the revision author (W-i3)
    expect(after?.revisions[0]?.authorUserId).toBe("u1")

    // unchanged re-save is a no-op (no new revision)
    const noop = await w.savePage({
      slug: "guides/intro",
      type: "guide",
      title: "Intro",
      tags: ["onboarding"],
      body: "Welcome to the wiki (v2).",
    })
    expect(noop.changed).toBe(false)
    expect((await w.getPage("guides/intro"))?.revisions.length).toBe(2)
  })
})

describe("wiki red links — record unresolved, resolve on target creation", () => {
  test("a [[missing]] link is a pending red link; creating the target resolves it into a real edge", async () => {
    const w = wiki({ tenantId: "wr", userId: "u1" })
    await w.savePage({ slug: "src", type: "note", body: "see [[target]] and [x](/other.md)" })

    const before = await w.getPage("src")
    expect(before?.links.pending.sort()).toEqual(["other", "target"])
    expect(before?.links.resolved).toEqual([]) // nothing exists yet

    // Create one of the targets → its red link resolves retroactively.
    await w.savePage({ slug: "target", type: "note", body: "I am the target." })
    const after = await w.getPage("src")
    expect(after?.links.pending).toEqual(["other"]) // 'target' resolved, 'other' still red
    expect(after?.links.resolved.length).toBe(1)
    // The resolved edge is a real backlink on the target page.
    const targetBacklinks = await w.getPage("target")
    expect(targetBacklinks?.backlinks.map((b) => b.fromId).length).toBe(1)
  })
})

describe("wiki move — id preserved, links re-point, redirect stub", () => {
  test("move re-points backlinks to the moved page, resolves red links to the new slug, leaves a redirect", async () => {
    const w = wiki({ tenantId: "wm", userId: "u1" })
    await w.savePage({ slug: "old", type: "note", body: "original page" })
    // refA already links [[old]] (a resolved edge); refB links [[new]] before it exists (a red link).
    const refA = await w.savePage({ slug: "refA", type: "note", body: "points to [[old]]" })
    const refB = await w.savePage({ slug: "refB", type: "note", body: "points to [[new]]" })
    expect((await w.getPage("refB"))?.links.pending).toEqual(["new"])

    const result = await w.movePage("old", "new")
    expect(result).toMatchObject({ fromSlug: "old", toSlug: "new" })

    // The moved page lives at the new slug (same id) and keeps refA as a backlink.
    const atNew = await w.getPage("new")
    expect(atNew?.page.id).toBe(result.pageId)
    const backlinkFroms = new Set(atNew?.backlinks.map((b) => b.fromId))
    // (a) refA's RESOLVED edge survived the rename because the page id is preserved; and
    // (b) refB's RED link resolved to the moved page on move — both are now real backlinks.
    // (The redirect stub's [[new]] body adds a third, so this is a containment check, not equality.)
    expect(backlinkFroms.has(refA.pageId)).toBe(true)
    expect(backlinkFroms.has(refB.pageId)).toBe(true)
    expect((await w.getPage("refB"))?.links.pending).toEqual([]) // resolved by the move

    // A redirect stub sits at the old slug.
    const stub = await w.getPage("old")
    expect(stub?.page.type).toBe("redirect")
    expect(stub?.body).toContain("[[new]]")

    // Moving onto an occupied slug is rejected.
    await expect(w.movePage("new", "refA")).rejects.toThrow(/already in use/)
  })
})

describe("wiki list — tree shape (childCount), includes memory pages", () => {
  test("childCount reports the subtree size under a slug (non-zero, correlated correctly)", async () => {
    const w = wiki({ tenantId: "wl", userId: "u1" })
    await w.savePage({ slug: "ns/a", type: "note", body: "parent" })
    await w.savePage({ slug: "ns/a/child", type: "note", body: "child" })
    await w.savePage({ slug: "ns/b", type: "note", body: "leaf" })

    const listed = await w.listPages({ namespacePrefix: "ns" })
    const bySlug = Object.fromEntries(listed.map((e) => [e.slug, e]))
    expect(bySlug["ns/a"]?.childCount).toBeGreaterThanOrEqual(1) // has a descendant
    expect(bySlug["ns/a/child"]?.childCount).toBe(0) // leaf
    expect(bySlug["ns/b"]?.childCount).toBe(0) // leaf
  })

  test("long slugs (≥60 chars) list + count without tripping the D1 LIKE-pattern cap", async () => {
    // REGRESSION (prod-only): Cloudflare D1 caps LIKE/GLOB patterns at 50 BYTES, so the old
    // `child.slug LIKE ${slug}/%` childCount subquery + `slug LIKE ${prefix}/%` namespace filter
    // threw `SQLITE_ERROR: LIKE or GLOB pattern too complex` for any slug ≳50 bytes. Local D1
    // (workerd/miniflare) defaults to 50,000, so this can NOT be reproduced here — this test instead
    // PINS the LIKE-free `substr(...)` semantics (list returns the long page + a correct childCount).
    const w = wiki({ tenantId: "wlong", userId: "u1" })
    const parent = "articles/langchain-nvidia-nemoclaw-deep-agents-blueprint" // 56 chars
    const child = `${parent}/appendix-a-detailed-benchmark-methodology-and-results` // ~110 chars
    expect(parent.length).toBeGreaterThanOrEqual(50)
    await w.savePage({ slug: parent, type: "note", body: "parent" })
    await w.savePage({ slug: child, type: "note", body: "child" })

    // (a) unfiltered list surfaces the long-slug pages and counts the descendant correctly.
    const all = Object.fromEntries((await w.listPages()).map((e) => [e.slug, e]))
    expect(all[parent]).toBeDefined()
    expect(all[parent]?.childCount).toBe(1)
    expect(all[child]?.childCount).toBe(0)

    // (b) a long namespacePrefix filter (≳50 bytes) returns the subtree without throwing.
    const filtered = Object.fromEntries(
      (await w.listPages({ namespacePrefix: parent })).map((e) => [e.slug, e]),
    )
    expect(filtered[parent]).toBeDefined()
    expect(filtered[child]).toBeDefined()
  })

  test("childCount excludes descendants the caller cannot see (no existence oracle via the number)", async () => {
    // u1 creates a WORLD parent + a PRIVATE child under it.
    const u1 = wiki({ tenantId: "wl2", userId: "u1" })
    await u1.savePage({ slug: "px/root", type: "note", visibility: "world", body: "parent" })
    await u1.savePage({
      slug: "px/root/secret",
      type: "note",
      visibility: "private",
      body: "hidden",
    })

    // The author counts the child; a different user sees the world parent but NOT the hidden child.
    const u1list = Object.fromEntries(
      (await u1.listPages({ namespacePrefix: "px" })).map((e) => [e.slug, e]),
    )
    expect(u1list["px/root"]?.childCount).toBe(1)

    const u2list = Object.fromEntries(
      (await wiki({ tenantId: "wl2", userId: "u2" }).listPages({ namespacePrefix: "px" })).map(
        (e) => [e.slug, e],
      ),
    )
    expect(u2list["px/root"]).toBeDefined() // the world parent is visible
    expect(u2list["px/root"]?.childCount).toBe(0) // ...but the private child does NOT inflate its count
  })
})

describe("wiki delete — soft-delete, wiki-only", () => {
  test("delete hides the page from get/list; idempotent when already gone", async () => {
    const w = wiki({ tenantId: "wd", userId: "u1" })
    await w.savePage({ slug: "temp", type: "note", body: "throwaway" })
    expect(await w.deletePage("temp")).toMatchObject({ deleted: true })
    expect(await w.getPage("temp")).toBeNull()
    expect(await w.deletePage("temp")).toMatchObject({ deleted: false })
    expect((await w.listPages()).some((p) => p.slug === "temp")).toBe(false)
  })
})

describe("wiki visibility — omit preserves, never silently escalates", () => {
  test("editing without visibility keeps the tier; new pages default to safe private; explicit change applies", async () => {
    const u1 = wiki({ tenantId: "wv", userId: "u1" })
    const other = wiki({ tenantId: "wv", userId: "u2" })

    // A private page, re-saved WITHOUT visibility → stays private (not escalated to world).
    await u1.savePage({ slug: "p1", type: "note", visibility: "private", body: "v1" })
    await u1.savePage({ slug: "p1", type: "note", body: "v2" }) // visibility omitted
    expect((await u1.getPage("p1"))?.page.visibility).toBe("private")
    expect(await other.getPage("p1")).toBeNull() // really still private

    // A NEW page with no visibility defaults to the SAFE private tier, not world.
    await u1.savePage({ slug: "p2", type: "note", body: "new" })
    expect((await u1.getPage("p2"))?.page.visibility).toBe("private")
    expect(await other.getPage("p2")).toBeNull()

    // An EXPLICIT change still works, both directions.
    await u1.savePage({ slug: "p1", type: "note", visibility: "world", body: "v3" })
    expect((await other.getPage("p1"))?.page.visibility).toBe("world")
    await u1.savePage({ slug: "p1", type: "note", body: "v4" }) // omit again → stays world now
    expect((await other.getPage("p1"))?.page.visibility).toBe("world")
  })

  test("world→team change on edit writes teamId so the team sees it + author can re-edit", async () => {
    const author = wiki({ tenantId: "wt", userId: "u1", teamIds: ["teamX"] })
    await author.savePage({ slug: "t1", type: "note", visibility: "world", body: "v1" })
    await author.savePage({ slug: "t1", type: "note", visibility: "team", body: "v2" })

    const mate = wiki({ tenantId: "wt", userId: "u2", teamIds: ["teamX"] })
    expect((await mate.getPage("t1"))?.body).toBe("v2") // teamId was written → team can see it
    expect(await wiki({ tenantId: "wt", userId: "u3", teamIds: [] }).getPage("t1")).toBeNull()

    // Author re-edits omitting visibility → stays team, teamId preserved.
    await author.savePage({ slug: "t1", type: "note", body: "v3" })
    expect((await mate.getPage("t1"))?.body).toBe("v3")
    expect((await author.getPage("t1"))?.page.visibility).toBe("team")
  })
})

describe("wiki red-link resolution is visibility-scoped (no existence oracle)", () => {
  test("a private target by another user never consumes my pending; a world target does", async () => {
    const u1 = wiki({ tenantId: "wo", userId: "u1" })
    await u1.savePage({
      slug: "u1a",
      type: "note",
      visibility: "private",
      body: "see [[priv-t]] and [[world-t]]",
    })
    const u1aId = (await u1.getPage("u1a"))?.page.id
    expect((await u1.getPage("u1a"))?.links.pending.sort()).toEqual(["priv-t", "world-t"])

    const u2 = wiki({ tenantId: "wo", userId: "u2" })
    // (a) a PRIVATE target u1 cannot see → u1's pending stays red, no edge (no existence oracle).
    await u2.savePage({ slug: "priv-t", type: "note", visibility: "private", body: "u2 only" })
    // (b) a WORLD target visible to u1 → resolves.
    await u2.savePage({ slug: "world-t", type: "note", visibility: "world", body: "everyone" })

    expect((await u1.getPage("u1a"))?.links.pending).toEqual(["priv-t"]) // only the hidden one stays
    expect(await count("SELECT count(*) AS n FROM doc_links WHERE from_id = ?", [u1aId])).toBe(1)
  })
})

describe("wiki isolation — tenant, visibility (invariants 1, 8)", () => {
  beforeAll(async () => {
    // Tenant tA world-visible page + a private page authored by u1.
    await wiki({ tenantId: "tA", userId: "u1" }).savePage({
      slug: "shared",
      type: "note",
      body: "tenant A content",
    })
    await wiki({ tenantId: "tA", userId: "u1" }).savePage({
      slug: "priv",
      type: "note",
      visibility: "private",
      body: "u1 only",
    })
    // Tenant tB independently uses the SAME slug 'shared'.
    await wiki({ tenantId: "tB", userId: "u9" }).savePage({
      slug: "shared",
      type: "note",
      body: "tenant B content",
    })
  })

  test("a colliding slug resolves to the caller's OWN tenant; B never sees A's page", async () => {
    expect((await wiki({ tenantId: "tA", userId: "u1" }).getPage("shared"))?.body).toBe(
      "tenant A content",
    )
    expect((await wiki({ tenantId: "tB", userId: "u9" }).getPage("shared"))?.body).toBe(
      "tenant B content",
    )
  })

  test("a private page is invisible AND not editable by another user in the same tenant", async () => {
    const u2 = wiki({ tenantId: "tA", userId: "u2" })
    expect(await u2.getPage("priv")).toBeNull()
    await expect(u2.savePage({ slug: "priv", type: "note", body: "hijack" })).rejects.toThrow(
      /not visible/,
    )
    // ...but the author still sees it.
    expect((await wiki({ tenantId: "tA", userId: "u1" }).getPage("priv"))?.body).toBe("u1 only")
  })

  test("retroactive red-link resolution is tenant-scoped: a cross-tenant pending row never links", async () => {
    // Tenant xA has a pending red link to slug 'xtarget'.
    const xa = wiki({ tenantId: "xA", userId: "u1" })
    await xa.savePage({ slug: "xsrc", type: "note", body: "see [[xtarget]]" })
    const xaSrcId = (await xa.getPage("xsrc"))?.page.id
    expect((await xa.getPage("xsrc"))?.links.pending).toEqual(["xtarget"])

    // Tenant xB creates a page at 'xtarget' — this must NOT resolve tenant xA's pending row.
    await wiki({ tenantId: "xB", userId: "u9" }).savePage({
      slug: "xtarget",
      type: "note",
      body: "different tenant",
    })

    // No doc_link was created from xA's source into ANY page (the cross-tenant edge is impossible).
    expect(await count("SELECT count(*) AS n FROM doc_links WHERE from_id = ?", [xaSrcId])).toBe(0)
    expect((await xa.getPage("xsrc"))?.links.pending).toEqual(["xtarget"]) // still red

    // xA creating its OWN 'xtarget' resolves it.
    await xa.savePage({ slug: "xtarget", type: "note", body: "same tenant" })
    expect((await xa.getPage("xsrc"))?.links.pending).toEqual([])
    expect(await count("SELECT count(*) AS n FROM doc_links WHERE from_id = ?", [xaSrcId])).toBe(1)
  })
})

describe("provenance lanes stay clean — memory ⟂ wiki", () => {
  test("wiki_list includes memory pages, but memory_* ignores wiki pages", async () => {
    const p = { tenantId: "pv", userId: "u1" }
    await memory(p).upsertMemory({ slug: "mem/x", frontmatter: { type: "note" }, body: "a memory" })
    await wiki(p).savePage({ slug: "wiki/y", type: "note", body: "a wiki page" })

    // memory_get/list see ONLY the memory page.
    expect((await memory(p).getMemory("mem/x"))?.body).toBe("a memory")
    expect(await memory(p).getMemory("wiki/y")).toBeNull()
    expect((await memory(p).listMemory({})).map((m) => m.slug)).toEqual(["mem/x"])

    // wiki_list sees BOTH (a page is a page — W-i1).
    const listed = new Set((await wiki(p).listPages()).map((e) => e.slug))
    expect(listed.has("mem/x")).toBe(true)
    expect(listed.has("wiki/y")).toBe(true)
  })

  test("wiki_save_page onto a memory slug is rejected with a teaching error", async () => {
    const p = { tenantId: "px", userId: "u1" }
    await memory(p).upsertMemory({ slug: "mem/z", frontmatter: { type: "note" }, body: "mine" })
    await expect(wiki(p).savePage({ slug: "mem/z", type: "note", body: "hijack" })).rejects.toThrow(
      /agent memory/,
    )
    // ...and the reverse: memory_set onto a wiki slug is rejected.
    await wiki(p).savePage({ slug: "wiki/w", type: "note", body: "a wiki page" })
    await expect(
      memory(p).upsertMemory({ slug: "wiki/w", frontmatter: { type: "note" }, body: "x" }),
    ).rejects.toThrow(/non-memory page/)
  })
})

describe("wiki_page_history — bodies + visibility gate (W4a / Option B)", () => {
  test("history returns full body snapshots newest-first for a visible page", async () => {
    const w = wiki({ tenantId: "wh", userId: "u1" })
    await w.savePage({ slug: "notes/h", type: "note", title: "H", body: "body one" })
    await w.savePage({ slug: "notes/h", type: "note", title: "H", body: "body two" })
    const hist = await w.pageHistory("notes/h")
    expect(hist.revisions).not.toBeNull()
    const revs = hist.revisions ?? []
    expect(revs.length).toBe(2)
    // newest-first
    expect(revs[0]?.version).toBe(2)
    expect(revs[0]?.body).toBe("body two")
    expect(revs[1]?.version).toBe(1)
    expect(revs[1]?.body).toBe("body one")
    expect(revs[0]?.authorUserId).toBe("u1")
  })

  test("a system/dream-authored revision surfaces author=system", async () => {
    const sys = wiki({ tenantId: "wh2", userId: "system" })
    await sys.savePage({ slug: "entities/person/ada", type: "entity", body: "agent summary" })
    const hist = await sys.pageHistory("entities/person/ada")
    expect(hist.revisions?.[0]?.authorUserId).toBe("system")
  })

  test("a cross-user PRIVATE page's history is denied (revisions:null); the author sees it", async () => {
    const u1 = wiki({ tenantId: "wh3", userId: "u1" })
    await u1.savePage({
      slug: "secret/plan",
      type: "note",
      body: "top secret",
      visibility: "private",
    })
    // same tenant, different user → gated out
    const u2 = wiki({ tenantId: "wh3", userId: "u2" })
    expect((await u2.pageHistory("secret/plan")).revisions).toBeNull()
    // the author still sees the bodies
    expect((await u1.pageHistory("secret/plan")).revisions?.[0]?.body).toBe("top secret")
    // another tenant → gated out
    expect(
      (await wiki({ tenantId: "wOther", userId: "u1" }).pageHistory("secret/plan")).revisions,
    ).toBeNull()
  })
})

describe("navigable backlinks — fromSlug/fromTitle, gated (W4a / Option B)", () => {
  test("a backlink carries the source slug+title from the gated join", async () => {
    const w = wiki({ tenantId: "bl", userId: "u1" })
    await w.savePage({ slug: "target", type: "note", title: "Target", body: "the target page" })
    await w.savePage({ slug: "source", type: "note", title: "Source Page", body: "see [[target]]" })
    const got = await w.getPage("target")
    const back = got?.backlinks ?? []
    expect(back.length).toBe(1)
    expect(back[0]?.fromSlug).toBe("source")
    expect(back[0]?.fromTitle).toBe("Source Page")
  })

  test("a backlink from a source the caller can't see is excluded (no slug/title leak)", async () => {
    const u1 = wiki({ tenantId: "bl2", userId: "u1" })
    await u1.savePage({
      slug: "target",
      type: "note",
      title: "T",
      body: "world target",
      visibility: "world",
    })
    // u1's PRIVATE source links to the world target
    await u1.savePage({
      slug: "secret-source",
      type: "note",
      title: "Secret Source",
      body: "see [[target]]",
      visibility: "private",
    })
    // author sees the backlink...
    const u1back = (await u1.getPage("target"))?.backlinks ?? []
    expect(u1back.some((b) => b.fromSlug === "secret-source")).toBe(true)
    // ...another user does NOT (source gated out — no title/slug leak)
    const u2back =
      (await wiki({ tenantId: "bl2", userId: "u2" }).getPage("target"))?.backlinks ?? []
    expect(u2back.some((b) => b.fromSlug === "secret-source")).toBe(false)
    expect(u2back.some((b) => b.fromTitle === "Secret Source")).toBe(false)
  })
})

describe("drafts flag on wiki_list_pages (W4a / Option B item 3)", () => {
  test("a page saved with draft:true carries draft in the listing; a normal page does not", async () => {
    const w = wiki({ tenantId: "dr", userId: "u1" })
    await w.savePage({ slug: "published", type: "note", body: "live" })
    await w.savePage({ slug: "wip", type: "note", body: "half-written", draft: true })
    const bySlug = new Map((await w.listPages()).map((e) => [e.slug, e.draft]))
    expect(bySlug.get("published")).toBe(false)
    expect(bySlug.get("wip")).toBe(true)
  })

  test("clearing the draft flag on a later save flips it back to published", async () => {
    const w = wiki({ tenantId: "dr2", userId: "u1" })
    await w.savePage({ slug: "toggle", type: "note", body: "v1", draft: true })
    expect((await w.listPages()).find((e) => e.slug === "toggle")?.draft).toBe(true)
    await w.savePage({ slug: "toggle", type: "note", body: "v2", draft: false })
    expect((await w.listPages()).find((e) => e.slug === "toggle")?.draft).toBe(false)
  })
})

describe("link extraction excludes code + images (W4a fix round, item 3)", () => {
  test("a [[link]] in a code fence / inline code / image target does NOT become a doc edge or red link", async () => {
    const w = wiki({ tenantId: "lx", userId: "u1" })
    const body = [
      "See [[real-target]] here.",
      "",
      "```",
      "example: [[fenced-fake]] should not link",
      "```",
      "",
      "Inline `[[inline-fake]]` too, and an image ![alt](img/pic.png).",
      "Also a normal [doc](/docs/guide) link.",
    ].join("\n")
    await w.savePage({ slug: "notes/links", type: "note", body })
    const got = await w.getPage("notes/links")
    const pending = new Set(got?.links.pending ?? [])
    // real-target + docs/guide are unresolved red links; the code/image ones are NOT extracted.
    expect(pending.has("real-target")).toBe(true)
    expect(pending.has("docs/guide")).toBe(true)
    expect(pending.has("fenced-fake")).toBe(false)
    expect(pending.has("inline-fake")).toBe(false)
    expect(pending.has("img/pic.png")).toBe(false)
    expect(pending.has("img/pic")).toBe(false)
  })
})

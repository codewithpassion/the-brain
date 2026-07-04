import { env } from "cloudflare:test"
import {
  type BrainBindings,
  createDreamIndexesServices,
  runDreamIndexes,
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext } from "@brain/surface"
import { drizzle } from "drizzle-orm/d1"
import { describe, expect, test } from "vitest"

/**
 * W5/2b wiki OKF bundle IMPORT canary — the UNTRUSTED-INGRESS gate. Proves each of the five security
 * controls: (1) unconditional private+draft floor, (2) anti-reflection provenance + no backing doc,
 * (3) namespace confinement + no silent merge, (4) reject-early caps, (5) resilient per-file outcomes.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const principal = (o: Partial<Principal> = {}): Principal => ({
  tenantId: "wImp",
  userId: "u1",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
  ...o,
})
const wiki = (o: Partial<Principal> = {}) => new WikiStore(raw(), principal(o))

const okf = (fm: Record<string, unknown>, body: string): string =>
  `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n\n${body}`

const pageRow = (tenantId: string, slug: string) =>
  env_.DB.prepare(
    `SELECT ingested_via AS via, visibility, compiled_truth AS body, frontmatter FROM pages
     WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`,
  )
    .bind(tenantId, slug)
    .first<{ via: string; visibility: string; body: string; frontmatter: string }>()

describe("wiki_import_bundle — untrusted-ingress security controls (W5/2b)", () => {
  test("CONTROL 1 — a bundle 'visibility: world' imports as PRIVATE + draft (world ignored)", async () => {
    const w = wiki({ tenantId: "im1", userId: "u1" })
    const res = await w.importBundle(
      [
        {
          path: "plan.md",
          content: okf({ type: "note", title: "Plan", visibility: "world", draft: false }, "hi"),
        },
      ],
      "acme",
    )
    expect(res.imported).toBe(1)
    const row = await pageRow("im1", "imported/acme/plan")
    expect(row?.visibility).toBe("private") // NOT world
    expect(JSON.parse(row?.frontmatter ?? "{}").draft).toBe(true) // forced draft
  })

  test("CONTROL 2 — imported page is ingested_via='import' with NO backing doc", async () => {
    const w = wiki({ tenantId: "im2", userId: "u1" })
    await w.importBundle(
      [{ path: "x.md", content: okf({ type: "note", title: "X" }, "body") }],
      "acme",
    )
    const row = await pageRow("im2", "imported/acme/x")
    expect(row?.via).toBe("import")
    const doc = await env_.DB.prepare(
      `SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND slug = 'imported/acme/x'`,
    )
      .bind("im2")
      .first<{ n: number }>()
    expect(doc?.n).toBe(0) // never enters search/recall/think
  })

  test("CONTROL 3 — links are confined to the prefix; a colliding slug does NOT overwrite an existing page", async () => {
    const w = wiki({ tenantId: "im3", userId: "u1" })
    // an existing REAL page that a malicious import might try to hijack
    await w.savePage({
      slug: "foo",
      type: "note",
      title: "Real Foo",
      body: "mine",
      visibility: "world",
    })

    await w.importBundle(
      [
        {
          path: "note.md",
          content: okf({ type: "note", title: "Note" }, "see [[index]] and [[foo]]"),
        },
        { path: "foo.md", content: okf({ type: "note", title: "Evil Foo" }, "hijack attempt") },
      ],
      "acme",
    )

    // the imported note's links were rewritten under the prefix — NOT the global index/foo
    const note = await pageRow("im3", "imported/acme/note")
    expect(note?.body).toContain("[[imported/acme/index]]")
    expect(note?.body).toContain("[[imported/acme/foo]]")
    expect(note?.body).not.toContain("[[index]]") // the bare global link is gone
    // the real 'foo' is untouched; the import landed under the prefix
    expect((await pageRow("im3", "foo"))?.body).toBe("mine")
    expect((await pageRow("im3", "imported/acme/foo"))?.via).toBe("import")
  })

  test("CONTROL 4 — an over-cap bundle is rejected cleanly before any write", async () => {
    const w = wiki({ tenantId: "im4", userId: "u1" })
    const huge = "x".repeat(300 * 1024) // > 256KB per-file cap
    await expect(
      w.importBundle(
        [{ path: "big.md", content: okf({ type: "note", title: "Big" }, huge) }],
        "acme",
      ),
    ).rejects.toThrow(/exceeds max/)
    // nothing was written
    expect(await pageRow("im4", "imported/acme/big")).toBeNull()
  })

  test("CONTROL 5 — a no-type/reserved file is skipped with a reason; the rest still imports", async () => {
    const w = wiki({ tenantId: "im5", userId: "u1" })
    const res = await w.importBundle(
      [
        { path: "index.md", content: okf({ type: "bundle" }, "reserved structural") },
        { path: "bad.md", content: "no frontmatter, no type" },
        { path: "good.md", content: okf({ type: "note", title: "Good" }, "ok") },
      ],
      "acme",
    )
    expect(res.imported).toBe(1)
    expect(res.skipped).toBe(2)
    expect(res.items.find((i) => i.path === "index.md")?.reason).toBe("reserved")
    expect(res.items.find((i) => i.path === "bad.md")?.reason).toBe("no-type")
    expect((await pageRow("im5", "imported/acme/good"))?.via).toBe("import")
  })
})

describe("wiki_import_bundle — read-path + cross-feature isolation (adversarial)", () => {
  const catalog = buildCatalog()
  const getOp = catalog.find((o) => o.def.name === "wiki_get_page")
  const ctxEnv = { ...env_, BATCH_INGEST: undefined } as unknown as SurfaceContext["env"]

  test("READ-PATH: viewing an imported page does NOT create a backing doc (self-heal excludes 'import')", async () => {
    const t = "imRead"
    await wiki({ tenantId: t, userId: "u1" }).importBundle(
      [{ path: "x.md", content: okf({ type: "note", title: "X" }, "untrusted body") }],
      "acme",
    )
    const tasks: Promise<unknown>[] = []
    const ctx: SurfaceContext = {
      principal: principal({ tenantId: t, userId: "u1" }),
      env: ctxEnv,
      waitUntil: (p) => tasks.push(p),
      surface: "rest",
    }
    // The REAL surface read path (fires backgroundSync → syncBackingDoc as a waitUntil task).
    const out = (await getOp?.invoke(ctx, { target: "imported/acme/x" })) as {
      page: { page: { id: string } } | null
    }
    expect(out.page).not.toBeNull()
    await Promise.allSettled(tasks) // drain the self-heal
    const doc = await env_.DB.prepare(
      `SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND slug = 'imported/acme/x'`,
    )
      .bind(t)
      .first<{ n: number }>()
    expect(doc?.n).toBe(0) // still non-searchable after a view
  })

  test("CROSS-FEATURE: an imported page never appears in a regenerated world index", async () => {
    const t = "imIdx"
    await wiki({ tenantId: t, userId: "u1" }).savePage({
      slug: "acme/real",
      type: "note",
      title: "Real",
      body: "world content",
      visibility: "world",
    })
    await wiki({ tenantId: t, userId: "u1" }).importBundle(
      [
        {
          path: "leak.md",
          content: okf({ type: "note", title: "Leak", visibility: "world" }, "x"),
        },
      ],
      "acme",
    )
    await runDreamIndexes(
      createDreamIndexesServices(env_, principal({ tenantId: t, userId: "system", role: "admin" })),
      { runId: `${t}-idx` },
    )
    // every index body: the imported (private) page's slug must be absent
    const idx = await env_.DB.prepare(
      `SELECT compiled_truth AS body FROM pages WHERE tenant_id = ? AND ingested_via = 'index'`,
    )
      .bind(t)
      .all<{ body: string }>()
    for (const row of idx.results ?? []) {
      expect(row.body).not.toContain("imported/acme/leak")
    }
  })

  test("DOC-LINKS: an imported collision creates NO edge onto the pre-existing real page", async () => {
    const t = "imEdge"
    const w = wiki({ tenantId: t, userId: "u1" })
    const real = await w.savePage({
      slug: "foo",
      type: "note",
      title: "Real Foo",
      body: "mine",
      visibility: "world",
    })
    await w.importBundle(
      [{ path: "note.md", content: okf({ type: "note", title: "Note" }, "see [[foo]]") }],
      "acme",
    )
    // no doc_links edge points at the REAL foo's page id from the import
    const edge = await env_.DB.prepare(
      `SELECT COUNT(*) AS n FROM doc_links WHERE tenant_id = ? AND to_id = ? AND link_source = 'import'`,
    )
      .bind(t, real.pageId)
      .first<{ n: number }>()
    expect(edge?.n).toBe(0)
  })

  test("OWNERSHIP: user B cannot overwrite user A's existing private import draft", async () => {
    const t = "imOwn"
    // A imports a page → private, owned by A.
    await wiki({ tenantId: t, userId: "uA" }).importBundle(
      [{ path: "foo.md", content: okf({ type: "note", title: "A" }, "A's secret draft") }],
      "acme",
    )
    // B (same tenant) imports a file resolving to the SAME slug (imported/acme/foo).
    const res = await wiki({ tenantId: t, userId: "uB" }).importBundle(
      [{ path: "foo.md", content: okf({ type: "note", title: "B" }, "B injected content") }],
      "acme",
    )
    // B's file FAILS the ownership gate — A's draft is untouched (findBySlug is tenant-wide, so
    // without the gate B's upsert would take the UPDATE path and silently overwrite A).
    expect(res.imported).toBe(0)
    expect(res.failed).toBe(1)
    const row = await pageRow(t, "imported/acme/foo")
    expect(row?.body).toContain("A's secret draft")
    expect(row?.body).not.toContain("B injected content")
  })
})

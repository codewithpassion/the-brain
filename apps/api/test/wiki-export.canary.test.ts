import { env } from "cloudflare:test"
import {
  type BrainBindings,
  createDreamIndexesServices,
  parseDocument,
  runDreamIndexes,
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { describe, expect, test } from "vitest"

/**
 * W5/2a wiki OKF bundle export canary — read-only, caller-scoped. Proves the bundle shape
 * (index.md + one .md per page + log.md), frontmatter+body round-trip through `parseDocument`, and
 * that the OWNER's own world + private pages both appear in THEIR download (no coercion — correct).
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const principal = (o: Partial<Principal> = {}): Principal => ({
  tenantId: "wExp",
  userId: "u1",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
  ...o,
})
const wiki = (o: Partial<Principal> = {}) => new WikiStore(raw(), principal(o))
const fileByPath = (files: { path: string; content: string }[], p: string) =>
  files.find((f) => f.path === p)

describe("wiki_export_bundle — OKF bundle export (W5/2a)", () => {
  test("exports index.md + one .md per page + log.md; frontmatter+body round-trip", async () => {
    const w = wiki({ tenantId: "ex1", userId: "u1" })
    await w.savePage({
      slug: "guides/onboarding",
      type: "guide",
      title: "Onboarding",
      tags: ["intro"],
      body: "Welcome to the guide.",
      visibility: "world",
    })
    await w.savePage({
      slug: "guides/secrets",
      type: "note",
      title: "Secrets",
      body: "My private notes.",
      visibility: "private",
    })

    const bundle = await w.exportBundle({ namespace: "guides", prefix: true })
    expect(bundle.count).toBe(2) // owner sees BOTH their world + private page
    expect(bundle.okfVersion).toBe("0.1")

    // reserved files present
    const index = fileByPath(bundle.files, "index.md")
    const log = fileByPath(bundle.files, "log.md")
    expect(index).toBeDefined()
    expect(log).toBeDefined()
    expect(parseDocument(index?.content ?? "").frontmatter.type).toBe("bundle")
    expect(parseDocument(index?.content ?? "").frontmatter.count).toBe(2)

    // one .md per page
    const onboarding = fileByPath(bundle.files, "guides/onboarding.md")
    expect(onboarding).toBeDefined()
    const parsed = parseDocument(onboarding?.content ?? "")
    expect(parsed.frontmatter.type).toBe("guide")
    expect(parsed.frontmatter.title).toBe("Onboarding")
    expect(parsed.frontmatter.visibility).toBe("world") // preserved for round-trip
    expect(parsed.body).toBe("Welcome to the guide.")

    // the private page IS in the owner's own export (no coercion) — with its visibility preserved
    const secrets = fileByPath(bundle.files, "guides/secrets.md")
    expect(parseDocument(secrets?.content ?? "").frontmatter.visibility).toBe("private")

    // log.md references each page + a v1 line
    expect(log?.content).toContain("## guides/onboarding")
    expect(log?.content).toContain("v1")
  })

  test("auto-generated index pages are EXCLUDED from the bundle (no reserved index.md collision)", async () => {
    const t = "exIdx"
    const w = wiki({ tenantId: t, userId: "u1" })
    await w.savePage({ slug: "guides/a", type: "note", title: "A", body: "x", visibility: "world" })
    await w.savePage({ slug: "guides/b", type: "note", title: "B", body: "y", visibility: "world" })
    // Generate the root `index` + `guides/index` pages (ingested_via='index').
    await runDreamIndexes(
      createDreamIndexesServices(env_, principal({ tenantId: t, userId: "u1", role: "admin" })),
      { runId: `${t}-idx` },
    )

    const bundle = await w.exportBundle({}) // whole wiki
    // exactly ONE index.md (the bundle's structural one) — the slug='index' index PAGE must not add a
    // second colliding entry, and the namespace index page must not appear either.
    expect(bundle.files.filter((f) => f.path === "index.md").length).toBe(1)
    expect(bundle.files.some((f) => f.path === "guides/index.md")).toBe(false)
    // source pages still present
    expect(bundle.files.some((f) => f.path === "guides/a.md")).toBe(true)
    expect(bundle.files.some((f) => f.path === "guides/b.md")).toBe(true)
  })

  test("another user's PRIVATE page is NOT in a different caller's export (visibility gate)", async () => {
    await wiki({ tenantId: "ex2", userId: "u1" }).savePage({
      slug: "team/private-note",
      type: "note",
      title: "U1 Private",
      body: "u1 only",
      visibility: "private",
    })
    // u2 (same tenant) exports the namespace → must NOT see u1's private page
    const bundle = await wiki({ tenantId: "ex2", userId: "u2" }).exportBundle({ namespace: "team" })
    expect(bundle.files.some((f) => f.path === "team/private-note.md")).toBe(false)
    expect(fileByPath(bundle.files, "index.md")?.content).not.toContain("U1 Private")
  })
})

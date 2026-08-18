import { describe, expect, test } from "bun:test"
import { ancestorsOf, buildTree } from "../src/components/WikiSidebar"
import type { WikiListEntry } from "../src/server/types"

const entry = (slug: string, over: Partial<WikiListEntry> = {}): WikiListEntry => ({
  slug,
  title: slug.split("/").pop() ?? slug,
  type: "note",
  visibility: "world",
  ingestedVia: null,
  updatedAt: "2026-01-01T00:00:00Z",
  childCount: 0,
  draft: false,
  ...over,
})

describe("ancestorsOf", () => {
  test("returns every prefix path including the slug itself", () => {
    expect(ancestorsOf("a/b/c")).toEqual(["a", "a/b", "a/b/c"])
  })
  test("single segment returns itself", () => {
    expect(ancestorsOf("a")).toEqual(["a"])
  })
  test("empty slug returns nothing", () => {
    expect(ancestorsOf("")).toEqual([])
  })
})

describe("buildTree", () => {
  test("nests slugs and assigns an accumulated path to every node", () => {
    const nodes = buildTree([entry("a/b/c")])
    expect(nodes).toHaveLength(1)
    const [a] = nodes
    if (!a) throw new Error("missing root node")
    expect(a.name).toBe("a")
    expect(a.path).toBe("a")
    expect(a.entry).toBeNull()
    const [b] = a.children
    if (!b) throw new Error("missing child node")
    expect(b.path).toBe("a/b")
    const [c] = b.children
    if (!c) throw new Error("missing grandchild node")
    expect(c.path).toBe("a/b/c")
    expect(c.entry?.slug).toBe("a/b/c")
    expect(c.children).toHaveLength(0)
  })

  test("attaches the entry to the exact node and supports a page that also nests", () => {
    const nodes = buildTree([entry("a"), entry("a/b")])
    const [a] = nodes
    if (!a) throw new Error("missing root node")
    expect(a.entry?.slug).toBe("a") // page exists at the namespace itself
    expect(a.children).toHaveLength(1)
    expect(a.children[0]?.entry?.slug).toBe("a/b")
  })

  test("orders namespaces first, then alpha by segment name", () => {
    const nodes = buildTree([
      entry("zebra"), // leaf
      entry("beta/child"), // namespace
      entry("alpha"), // leaf
      entry("gamma/child"), // namespace
    ])
    expect(nodes.map((n) => n.name)).toEqual(["beta", "gamma", "alpha", "zebra"])
  })
})

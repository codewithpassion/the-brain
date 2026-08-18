/**
 * Parity guard: `normalizeLinkTarget` here MUST match `packages/db/src/pages/store.ts` exactly, or a
 * pending (red) link silently renders as a normal link. These cases mirror the store's rules:
 * `|`/`#` split, external/mailto drop, leading `./`|`/` strip, trailing `.md` strip.
 */

import { describe, expect, test } from "bun:test"
import { WIKILINK_SLUG_FIXTURES } from "@brain/shared"
import {
  normalizeLinkTarget,
  remarkWikiLinks,
  resolveWikiHref,
  wikilinkAnchor,
  wikilinkLabel,
} from "../src/lib/wikilink"

// DRIFT GUARD (W4a fix round, item 4): the client PORT must match the SHARED golden fixtures that
// `@brain/db`'s normalizer is also pinned to — so a store-side rule change fails here until synced.
describe("normalizeLinkTarget ↔ shared golden fixtures (dashboard port)", () => {
  for (const { input, slug } of WIKILINK_SLUG_FIXTURES) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(slug)}`, () => {
      expect(normalizeLinkTarget(input)).toBe(slug)
    })
  }
})

// Minimal mdast shapes for the transform test.
interface N {
  type: string
  value?: string
  url?: string
  children?: N[]
}

describe("normalizeLinkTarget (store parity)", () => {
  test("plain slug passes through", () => {
    expect(normalizeLinkTarget("algorithm")).toBe("algorithm")
    expect(normalizeLinkTarget("tables/customers")).toBe("tables/customers")
  })
  test("label after | is dropped from the slug", () => {
    expect(normalizeLinkTarget("Charles Babbage|Babbage")).toBe("Charles Babbage")
    expect(normalizeLinkTarget("a/b|Label")).toBe("a/b")
  })
  test("fragment after # is dropped", () => {
    expect(normalizeLinkTarget("guide#section")).toBe("guide")
    expect(normalizeLinkTarget("x#frag")).toBe("x")
  })
  test("leading ./ or / is stripped", () => {
    expect(normalizeLinkTarget("/tables/customers")).toBe("tables/customers")
    expect(normalizeLinkTarget("./y")).toBe("y")
  })
  test("trailing .md is stripped (case-insensitive)", () => {
    expect(normalizeLinkTarget("./y.md")).toBe("y")
    expect(normalizeLinkTarget("/tables/customers.MD")).toBe("tables/customers")
  })
  test("external and mailto are dropped (null)", () => {
    expect(normalizeLinkTarget("https://example.com")).toBeNull()
    expect(normalizeLinkTarget("HTTP://Example.com")).toBeNull()
    expect(normalizeLinkTarget("mailto:a@b.com")).toBeNull()
  })
  test("empty / fragment-only is null", () => {
    expect(normalizeLinkTarget("")).toBeNull()
    expect(normalizeLinkTarget("   ")).toBeNull()
    expect(normalizeLinkTarget("#section")).toBeNull()
  })
  test("combined: /path/x.md#frag|Label → path/x", () => {
    expect(normalizeLinkTarget("/path/x.md#frag|Label")).toBe("path/x")
  })
})

describe("wikilinkAnchor (heading fragment → rehype-slug id)", () => {
  test("bare fragment passes through as a slug", () => {
    expect(wikilinkAnchor("a#b")).toBe("b")
  })
  test("multi-word fragment is slugified (spaces → dashes, lowercased)", () => {
    expect(wikilinkAnchor("a#Setup Steps")).toBe("setup-steps")
  })
  test("an already-slug fragment is idempotent", () => {
    expect(wikilinkAnchor("a#setup-steps")).toBe("setup-steps")
  })
  test("label is split off BEFORE the fragment (| after # is not part of the anchor)", () => {
    expect(wikilinkAnchor("a#b|Label")).toBe("b")
  })
  test("no fragment → null", () => {
    expect(wikilinkAnchor("a")).toBeNull()
  })
  test("empty fragment (trailing #) → null", () => {
    expect(wikilinkAnchor("a#")).toBeNull()
  })
})

describe("wikilinkLabel", () => {
  test("uses label after | when present", () => {
    expect(wikilinkLabel("Charles Babbage|Babbage")).toBe("Babbage")
  })
  test("falls back to the target when no label", () => {
    expect(wikilinkLabel("algorithm")).toBe("algorithm")
  })
  test("label may contain a pipe", () => {
    expect(wikilinkLabel("t|a|b")).toBe("a|b")
  })
})

describe("remarkWikiLinks (mdast transform — the make-or-break)", () => {
  test("splits [[target]] and [[target|label]] into link nodes; leaves code + plain text", () => {
    const inlineCode: N = { type: "inlineCode", value: "[[not-a-link]]" }
    const tree: N = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "see [[algorithm]] and [[Charles Babbage|Babbage]] end" },
            inlineCode,
          ],
        },
      ],
    }
    remarkWikiLinks()(tree)
    const kids = tree.children?.[0]?.children ?? []
    // text('see '), link(algorithm), text(' and '), link(Charles Babbage→Babbage), text(' end'), inlineCode
    expect(kids.map((k) => k.type)).toEqual(["text", "link", "text", "link", "text", "inlineCode"])
    const first = kids[1] as N
    expect(first.url).toBe("/wiki/algorithm") // normalized `/wiki/<slug>` (survives urlTransform)
    expect(first.children?.[0]?.value).toBe("algorithm")
    const second = kids[3] as N
    expect(second.url).toBe("/wiki/Charles Babbage")
    expect(second.children?.[0]?.value).toBe("Babbage")
    // code node must be untouched (not a `text` node — never visited)
    expect(inlineCode.value).toBe("[[not-a-link]]")
  })

  test("carries a #heading fragment into the /wiki/<slug>#<anchor> url", () => {
    const tree: N = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "jump [[a#b]] and [[a#Setup Steps|Setup]] and plain [[a]] here",
            },
          ],
        },
      ],
    }
    remarkWikiLinks()(tree)
    const kids = tree.children?.[0]?.children ?? []
    // text, link(a#b), text, link(a#setup-steps), text, link(a), text
    const links = kids.filter((k) => k.type === "link")
    expect(links[0]?.url).toBe("/wiki/a#b")
    expect(links[0]?.children?.[0]?.value).toBe("a#b") // label = raw target (no pipe)
    expect(links[1]?.url).toBe("/wiki/a#setup-steps")
    expect(links[1]?.children?.[0]?.value).toBe("Setup") // label after |
    expect(links[2]?.url).toBe("/wiki/a") // no anchor → no trailing '#'
  })

  test("text without [[ is left untouched", () => {
    const tree: N = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "no links here" }] }],
    }
    remarkWikiLinks()(tree)
    const kids = tree.children?.[0]?.children ?? []
    expect(kids.length).toBe(1)
    expect(kids[0]?.type).toBe("text")
  })
})

describe("resolveWikiHref (red-vs-resolved — the make-or-break decision)", () => {
  const pending = new Set(["missing-page", "tables/ghost"])
  test("resolved wikilink → router link to /wiki/<slug>", () => {
    expect(resolveWikiHref("algorithm", pending)).toEqual({ kind: "resolved", slug: "algorithm" })
  })
  test("pending wikilink → RED link", () => {
    expect(resolveWikiHref("missing-page", pending)).toEqual({
      kind: "pending",
      slug: "missing-page",
    })
    expect(resolveWikiHref("/tables/ghost.md", pending)).toEqual({
      kind: "pending",
      slug: "tables/ghost",
    })
  })
  test("explicit /wiki/<slug> href is honored", () => {
    expect(resolveWikiHref("/wiki/guides/onboarding", pending)).toEqual({
      kind: "resolved",
      slug: "guides/onboarding",
    })
  })
  test("external / mailto / anchor stay external", () => {
    expect(resolveWikiHref("https://example.com", pending)).toEqual({
      kind: "external",
      href: "https://example.com",
    })
    expect(resolveWikiHref("mailto:a@b.com", pending)).toEqual({
      kind: "external",
      href: "mailto:a@b.com",
    })
    expect(resolveWikiHref("#section", pending)).toEqual({ kind: "external", href: "#section" })
  })
  test("/wiki/<slug>#<anchor> resolves on the bare slug, carrying the hash", () => {
    expect(resolveWikiHref("/wiki/a#b", pending)).toEqual({
      kind: "resolved",
      slug: "a",
      hash: "b",
    })
  })
  test("REGRESSION: /wiki/a#b detects a pending slug 'a' (hash no longer swallows the slug)", () => {
    expect(resolveWikiHref("/wiki/a#b", new Set(["a"]))).toEqual({
      kind: "pending",
      slug: "a",
      hash: "b",
    })
  })
  test("a bare target with a fragment splits the anchor off the slug", () => {
    expect(resolveWikiHref("a#b", pending)).toEqual({ kind: "resolved", slug: "a", hash: "b" })
  })
  test("an anchor-only href (#b) has no path → stays external", () => {
    expect(resolveWikiHref("#b", pending)).toEqual({ kind: "external", href: "#b" })
  })
})

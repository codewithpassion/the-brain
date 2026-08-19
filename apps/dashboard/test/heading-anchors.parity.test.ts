/**
 * Parity guard (mirrors `wikilink.test.ts`'s store-parity pinning): `extractHeadings` in
 * `@brain/shared` MUST produce the exact heading `id`s that the wiki renderer assigns, or an MCP
 * client rewriting `#anchor` deep links from `wiki_get_page.headings[]` silently produces dead links.
 *
 * The rendered DOM is GROUND TRUTH. This test runs the REAL render pipeline —
 * `remark-parse → remark-gfm → remarkWikiLinks → remark-rehype → rehype-slug`, the exact plugin set
 * `apps/dashboard/src/components/Markdown.tsx` feeds react-markdown (`remarkGfm`, `remarkWikiLinks`
 * then `rehypeSlug`) — walks the resulting hast for heading `id`s, and asserts equality with
 * `extractHeadings(...).map(h => h.id)`. `remarkWikiLinks` is load-bearing: it rewrites a heading's
 * `[[wikilink]]` to its LABEL before `rehype-slug` runs, so `extractHeadings` must reduce it too. If
 * they disagree, `extractHeadings` is what's wrong, not this test.
 */

import { describe, expect, test } from "bun:test"
import { extractHeadings } from "@brain/shared"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { remarkWikiLinks } from "../src/lib/wikilink"

// Minimal hast shapes (same approach as Markdown.tsx) — we only read tagName + properties.id.
interface HastNode {
  type?: string
  tagName?: string
  properties?: { id?: string }
  children?: HastNode[]
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])

/** Run the real render pipeline and collect heading `id`s in document order — the ground truth. */
const renderedHeadingIds = (markdown: string): (string | undefined)[] => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWikiLinks)
    .use(remarkRehype)
    .use(rehypeSlug)
  const hast = processor.runSync(processor.parse(markdown)) as HastNode
  const ids: (string | undefined)[] = []
  const walk = (node: HastNode): void => {
    if (node.type === "element" && node.tagName != null && HEADING_TAGS.has(node.tagName)) {
      ids.push(node.properties?.id)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(hast)
  return ids
}

// Gnarly fixtures — each exercises a place a `^#+` regex extractor would drift from the DOM.
const FIXTURES: Record<string, string> = {
  "gnarly punctuation (double/triple dashes)":
    "## Tue 18 Aug | PM | D0 - THE META POST (launches the series)",
  "duplicate headings dedup": "## Setup Steps\n\ntext\n\n## Setup Steps\n\nmore",
  "heading inside a fenced code block is skipped": "```\n## Not a heading\n```\n\n## Real Heading",
  "setext headings": "Setext Title\n===========\n\nSub Title\n---------",
  "inline formatting + gfm strike stripped":
    "## **Bold** and `code` and [a link](/x)\n\n## ~~strike~~ here",
  "image alt excluded from text": "## Look ![alt text](/img.png) end",
  "raw inline HTML dropped from text": "## Hello <b>world</b>",
  "h1 through h6": "# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6",
  "heading nested in a blockquote": "> ## Quoted Heading\n>\n> body",
  "heading nested in a list item": "- ## Item Heading\n- plain item",
  // `remarkWikiLinks` rewrites `[[…]]` to its label BEFORE rehype-slug, so these slug the label, not
  // the raw brackets — the divergence Task 3 fixes (raw would give `see-guidesalgoalgo`).
  "labeled wikilink heading → label": "## See [[guides/algo|Algo]]",
  "bare wikilink heading → target": "## [[guides/setup]]",
  "wikilink mixed with inline formatting": "## See [[guides/algo|Algo]] and **bold**",
}

describe("extractHeadings ↔ real rehype-slug render pipeline (parity guard)", () => {
  for (const [name, markdown] of Object.entries(FIXTURES)) {
    test(name, () => {
      expect(extractHeadings(markdown).map((h) => h.id)).toEqual(renderedHeadingIds(markdown))
    })
  }

  test("the primary target id is verified against the DOM, not guessed", () => {
    const md = "## Tue 18 Aug | PM | D0 - THE META POST (launches the series)"
    expect(extractHeadings(md).map((h) => h.id)).toEqual([
      "tue-18-aug--pm--d0---the-meta-post-launches-the-series",
    ])
    expect(renderedHeadingIds(md)).toEqual([
      "tue-18-aug--pm--d0---the-meta-post-launches-the-series",
    ])
  })
})

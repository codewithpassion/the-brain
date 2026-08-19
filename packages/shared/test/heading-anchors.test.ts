import { describe, expect, test } from "bun:test"
import { extractHeadings, headingAnchor } from "../src/index"

/**
 * Pins the shared heading-anchor rule. The rendered-DOM parity is proven separately in
 * `apps/dashboard/test/heading-anchors.parity.test.ts` (which runs the real rehype-slug pipeline);
 * these cases lock in the rule itself + the deliberate `extractHeadings` (per-doc slugger) vs
 * `headingAnchor` (fresh slugger) asymmetry that the module header documents.
 */
describe("headingAnchor (fragment → rehype-slug id)", () => {
  test("the gnarly real heading — punctuation stripped WITHOUT collapsing whitespace", () => {
    expect(headingAnchor("Tue 18 Aug | PM | D0 - THE META POST (launches the series)")).toBe(
      "tue-18-aug--pm--d0---the-meta-post-launches-the-series",
    )
  })
  test("multi-word fragment is slugified (spaces → dashes, lowercased)", () => {
    expect(headingAnchor("Setup Steps")).toBe("setup-steps")
  })
  test("idempotent on an already-correct id", () => {
    expect(headingAnchor("setup-steps")).toBe("setup-steps")
    expect(headingAnchor("setup-steps-1")).toBe("setup-steps-1")
  })
  test("a fresh slugger per call — no cross-call dedup", () => {
    expect(headingAnchor("Setup Steps")).toBe("setup-steps")
    expect(headingAnchor("Setup Steps")).toBe("setup-steps")
  })
})

describe("extractHeadings", () => {
  test("returns every heading in document order with level/text/id", () => {
    const md = "# One\n\ntext\n\n## Two Words\n\n### Three"
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "One", id: "one" },
      { level: 2, text: "Two Words", id: "two-words" },
      { level: 3, text: "Three", id: "three" },
    ])
  })

  test("the gnarly real heading yields the verified id", () => {
    const md = "## Tue 18 Aug | PM | D0 - THE META POST (launches the series)"
    expect(extractHeadings(md)).toEqual([
      {
        level: 2,
        text: "Tue 18 Aug | PM | D0 - THE META POST (launches the series)",
        id: "tue-18-aug--pm--d0---the-meta-post-launches-the-series",
      },
    ])
  })

  test("duplicate headings dedup with -1 (one slugger per document)", () => {
    const md = "## Setup Steps\n\na\n\n## Setup Steps\n\nb"
    expect(extractHeadings(md).map((h) => h.id)).toEqual(["setup-steps", "setup-steps-1"])
  })

  test("headings inside a fenced code block are NOT headings", () => {
    const md = "```\n## Not a heading\n```\n\n## Real Heading"
    expect(extractHeadings(md)).toEqual([{ level: 2, text: "Real Heading", id: "real-heading" }])
  })

  test("setext headings (=== / ---) are included", () => {
    const md = "Setext Title\n===========\n\nSub Title\n---------"
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "Setext Title", id: "setext-title" },
      { level: 2, text: "Sub Title", id: "sub-title" },
    ])
  })

  test("inline formatting is stripped from the slugged text (bold / code / link / gfm strike)", () => {
    const md = "## **Bold** and `code` and [a link](/x)\n\n## ~~strike~~ here"
    expect(extractHeadings(md)).toEqual([
      { level: 2, text: "Bold and code and a link", id: "bold-and-code-and-a-link" },
      { level: 2, text: "strike here", id: "strike-here" },
    ])
  })

  test("image alt is EXCLUDED (hast text content omits it) — a known divergence", () => {
    const md = "## Look ![alt text](/img.png) end"
    expect(extractHeadings(md)).toEqual([{ level: 2, text: "Look  end", id: "look--end" }])
  })

  test("raw inline HTML is EXCLUDED (remark-rehype drops it by default) — the other divergence", () => {
    const md = "## Hello <b>world</b>"
    expect(extractHeadings(md)).toEqual([{ level: 2, text: "Hello world", id: "hello-world" }])
  })

  test("empty / no-heading input returns []", () => {
    expect(extractHeadings("")).toEqual([])
    expect(extractHeadings("just a paragraph, no headings here")).toEqual([])
  })
})

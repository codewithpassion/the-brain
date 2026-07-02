import { describe, expect, test } from "bun:test"
import {
  blocksToMarkdown,
  extractPageTags,
  type NotionBlock,
  pageTitle,
  richTextToMarkdown,
} from "../src/sources/notion-blocks"

/**
 * Golden-file suite for the Notion block → Markdown converter (plan §4). Fidelity here drives
 * search/extraction quality, so each block type asserts an exact expected rendering.
 */

/** Terse rich-text builder: a single unannotated run. */
const rt = (text: string, extra: Record<string, unknown> = {}) => [
  { plain_text: text, annotations: {}, ...extra },
]

/** A typed block literal (the per-type payload sits under `[type]`). */
const block = (
  type: string,
  body: Record<string, unknown>,
  extra: Partial<NotionBlock> = {},
): NotionBlock => ({
  type,
  [type]: body,
  ...extra,
})

describe("richTextToMarkdown — inline annotations + links", () => {
  test("applies bold / italic / strike / code and links", () => {
    expect(richTextToMarkdown(rt("plain"))).toBe("plain")
    expect(richTextToMarkdown([{ plain_text: "b", annotations: { bold: true } }])).toBe("**b**")
    expect(richTextToMarkdown([{ plain_text: "i", annotations: { italic: true } }])).toBe("_i_")
    expect(richTextToMarkdown([{ plain_text: "s", annotations: { strikethrough: true } }])).toBe(
      "~~s~~",
    )
    expect(richTextToMarkdown([{ plain_text: "c", annotations: { code: true } }])).toBe("`c`")
    expect(
      richTextToMarkdown([{ plain_text: "link", annotations: {}, href: "https://x.dev" }]),
    ).toBe("[link](https://x.dev)")
  })

  test("concatenates multiple runs and skips empty runs", () => {
    expect(
      richTextToMarkdown([
        { plain_text: "Hello ", annotations: {} },
        { plain_text: "world", annotations: { bold: true } },
      ]),
    ).toBe("Hello **world**")
  })
})

describe("blocksToMarkdown — block types", () => {
  test("headings", () => {
    expect(
      blocksToMarkdown([
        block("heading_1", { rich_text: rt("H1") }),
        block("heading_2", { rich_text: rt("H2") }),
        block("heading_3", { rich_text: rt("H3") }),
      ]),
    ).toBe("# H1\n\n## H2\n\n### H3")
  })

  test("paragraphs are separated by blank lines", () => {
    expect(
      blocksToMarkdown([
        block("paragraph", { rich_text: rt("First.") }),
        block("paragraph", { rich_text: rt("Second.") }),
      ]),
    ).toBe("First.\n\nSecond.")
  })

  test("bulleted list", () => {
    expect(
      blocksToMarkdown([
        block("bulleted_list_item", { rich_text: rt("a") }),
        block("bulleted_list_item", { rich_text: rt("b") }),
      ]),
    ).toBe("- a\n\n- b")
  })

  test("numbered list increments sequentially and resets after a break", () => {
    expect(
      blocksToMarkdown([
        block("numbered_list_item", { rich_text: rt("one") }),
        block("numbered_list_item", { rich_text: rt("two") }),
        block("paragraph", { rich_text: rt("break") }),
        block("numbered_list_item", { rich_text: rt("reset") }),
      ]),
    ).toBe("1. one\n\n2. two\n\nbreak\n\n1. reset")
  })

  test("to-do items reflect checked state", () => {
    expect(
      blocksToMarkdown([
        block("to_do", { rich_text: rt("done"), checked: true }),
        block("to_do", { rich_text: rt("todo"), checked: false }),
      ]),
    ).toBe("- [x] done\n\n- [ ] todo")
  })

  test("quote and callout become blockquotes (callout keeps its emoji)", () => {
    expect(blocksToMarkdown([block("quote", { rich_text: rt("wise words") })])).toBe("> wise words")
    expect(
      blocksToMarkdown([block("callout", { rich_text: rt("heads up"), icon: { emoji: "💡" } })]),
    ).toBe("> 💡 heads up")
  })

  test("code fence carries the language", () => {
    expect(
      blocksToMarkdown([block("code", { rich_text: rt("const x = 1"), language: "typescript" })]),
    ).toBe("```typescript\nconst x = 1\n```")
  })

  test("divider and child page link", () => {
    expect(blocksToMarkdown([block("divider", {})])).toBe("---")
    expect(blocksToMarkdown([block("child_page", { title: "Sub Page" }, { id: "pg-123" })])).toBe(
      "[Sub Page](notion://pg-123)",
    )
  })

  test("toggle becomes a bold summary + nested body", () => {
    const toggle = block(
      "toggle",
      { rich_text: rt("Details") },
      { children: [block("paragraph", { rich_text: rt("hidden") })] },
    )
    expect(blocksToMarkdown([toggle])).toBe("**Details**\n\nhidden")
  })

  test("nested bulleted list indents children", () => {
    const parent = block(
      "bulleted_list_item",
      { rich_text: rt("parent") },
      { children: [block("bulleted_list_item", { rich_text: rt("child") })] },
    )
    expect(blocksToMarkdown([parent])).toBe("- parent\n  - child")
  })

  test("table renders a Markdown table with a header separator", () => {
    const table = block(
      "table",
      { table_width: 2 },
      {
        children: [
          block("table_row", { cells: [rt("Name"), rt("Role")] }),
          block("table_row", { cells: [rt("Ada"), rt("Eng")] }),
        ],
      },
    )
    expect(blocksToMarkdown([table])).toBe("| Name | Role |\n| --- | --- |\n| Ada | Eng |")
  })

  test("image/embed is links-only with its caption", () => {
    expect(
      blocksToMarkdown([
        block("image", { external: { url: "https://img.dev/a.png" }, caption: rt("Diagram") }),
      ]),
    ).toBe("[Diagram](https://img.dev/a.png)")
  })

  test("unknown block types render their rich_text rather than throwing", () => {
    expect(blocksToMarkdown([block("some_future_type", { rich_text: rt("still text") })])).toBe(
      "still text",
    )
  })

  test("empty / textless blocks are dropped from the output", () => {
    expect(blocksToMarkdown([block("paragraph", { rich_text: [] })])).toBe("")
  })
})

describe("page property helpers", () => {
  const properties = {
    Name: { type: "title", title: rt("Quarterly Plan") },
    Stage: { type: "select", select: { name: "Active" } },
    Areas: { type: "multi_select", multi_select: [{ name: "sales" }, { name: "revenue" }] },
    State: { type: "status", status: { name: "In progress" } },
    Note: { type: "rich_text", rich_text: rt("ignored") },
  }

  test("pageTitle reads the title-typed property", () => {
    expect(pageTitle(properties)).toBe("Quarterly Plan")
    expect(pageTitle(undefined)).toBe("")
  })

  test("extractPageTags collects select / multi_select / status values", () => {
    expect(extractPageTags(properties)).toEqual(["Active", "sales", "revenue", "In progress"])
    expect(extractPageTags(undefined)).toEqual([])
  })
})

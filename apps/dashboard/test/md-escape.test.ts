import { describe, expect, test } from "bun:test"
import { unescapeWikilinks } from "../src/lib/md-escape"

describe("unescapeWikilinks — @tiptap/markdown bracket-escape repair", () => {
  test("restores an escaped wikilink", () => {
    expect(unescapeWikilinks("see \\[\\[algorithm\\]\\] end")).toBe("see [[algorithm]] end")
  })
  test("restores a labeled wikilink (pipe untouched)", () => {
    expect(unescapeWikilinks("\\[\\[Charles Babbage|Babbage\\]\\]")).toBe(
      "[[Charles Babbage|Babbage]]",
    )
  })
  test("restores an anchored + labeled wikilink (# and | untouched)", () => {
    expect(unescapeWikilinks("\\[\\[a#b|Label\\]\\]")).toBe("[[a#b|Label]]")
  })
  test("an anchored wikilink inside a fenced code block stays verbatim", () => {
    const md = "before \\[\\[a#b|Label\\]\\] after\n```\n\\[\\[a#b\\]\\]\n```"
    expect(unescapeWikilinks(md)).toBe("before [[a#b|Label]] after\n```\n\\[\\[a#b\\]\\]\n```")
  })
  test("already-clean wikilinks are idempotent", () => {
    expect(unescapeWikilinks("[[x]] and [[y|Y]]")).toBe("[[x]] and [[y|Y]]")
  })
  test("a single escaped bracket (ordinary markdown-link escape) is left intact", () => {
    expect(unescapeWikilinks("a \\[not a wikilink\\] b")).toBe("a \\[not a wikilink\\] b")
  })
  test("literal \\[\\[ inside a fenced code block is NOT un-escaped (user's code preserved)", () => {
    const md = "before \\[\\[x\\]\\] after\n```\nconst re = /\\[\\[/\n```\ntail \\[\\[y\\]\\]"
    // prose brackets repaired; the regex inside the fence keeps its backslashes verbatim
    expect(unescapeWikilinks(md)).toBe(
      "before [[x]] after\n```\nconst re = /\\[\\[/\n```\ntail [[y]]",
    )
  })
  test("literal \\[\\[ inside an inline code span is left verbatim", () => {
    expect(unescapeWikilinks("use `\\[\\[` here but [[real]] outside")).toBe(
      "use `\\[\\[` here but [[real]] outside",
    )
  })
})

import { describe, expect, test } from "bun:test"
import { MARKDOWN_PREVIEW_MAX } from "@brain/shared"
import { markdownPreview, toMarkdown, UnsupportedContentTypeError } from "../src/markdown"

describe("toMarkdown", () => {
  test("passes through + normalizes text/markdown", () => {
    expect(toMarkdown("# Title\r\n\r\n\r\nBody  ", "text/markdown")).toBe("# Title\n\nBody")
  })

  test("passes through + normalizes text/plain", () => {
    expect(toMarkdown("plain  \r\ntext", "text/plain")).toBe("plain\ntext")
  })

  test("ignores charset parameters on the content type", () => {
    expect(toMarkdown("hello", "text/markdown; charset=utf-8")).toBe("hello")
  })

  test("throws UnsupportedContentTypeError for binary/HTML (handled in the workflow)", () => {
    expect(() => toMarkdown("<html></html>", "text/html")).toThrow(UnsupportedContentTypeError)
    expect(() => toMarkdown("%PDF-1.7", "application/pdf")).toThrow(UnsupportedContentTypeError)
  })

  test("the error carries the offending content type", () => {
    try {
      toMarkdown("x", "application/pdf")
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedContentTypeError)
      expect((err as UnsupportedContentTypeError).contentType).toBe("application/pdf")
      expect((err as UnsupportedContentTypeError).name).toBe("UnsupportedContentTypeError")
    }
  })
})

describe("markdownPreview", () => {
  test("returns short markdown unchanged", () => {
    expect(markdownPreview("# Tiny")).toBe("# Tiny")
  })

  test("caps at MARKDOWN_PREVIEW_MAX characters", () => {
    const long = "x".repeat(MARKDOWN_PREVIEW_MAX + 500)
    const preview = markdownPreview(long)
    expect(preview.length).toBe(MARKDOWN_PREVIEW_MAX)
  })
})

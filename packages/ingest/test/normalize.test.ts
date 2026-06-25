import { describe, expect, test } from "bun:test"
import { normalize } from "../src/normalize"

describe("normalize", () => {
  test("converts CRLF and lone CR to LF", () => {
    expect(normalize("a\r\nb\rc")).toBe("a\nb\nc")
  })

  test("strips a leading UTF-8 BOM", () => {
    expect(normalize("﻿hello")).toBe("hello")
  })

  test("drops per-line trailing whitespace", () => {
    expect(normalize("a   \nb\t\nc")).toBe("a\nb\nc")
  })

  test("collapses 3+ blank lines to a single blank line", () => {
    expect(normalize("a\n\n\n\nb")).toBe("a\n\nb")
  })

  test("trims leading/trailing whitespace of the whole body", () => {
    expect(normalize("\n\n  hello  \n\n")).toBe("hello")
  })

  test("PRESERVES case and inline spacing (unlike the fingerprint normalization)", () => {
    expect(normalize("Hello  World")).toBe("Hello  World")
  })

  test("is idempotent", () => {
    const messy = "﻿ Title \r\n\r\n\r\n  Body line  \t\r\n"
    const once = normalize(messy)
    expect(normalize(once)).toBe(once)
  })
})

import { describe, expect, test } from "bun:test"
import { diffLines } from "../src/lib/linediff"

describe("diffLines", () => {
  test("identical → all eq", () => {
    const d = diffLines("a\nb", "a\nb")
    expect(d.every((l) => l.type === "eq")).toBe(true)
  })
  test("one line changed → del + add, shared lines eq", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc")
    expect(d.filter((l) => l.type === "eq").map((l) => l.text)).toEqual(["a", "c"])
    expect(d.some((l) => l.type === "del" && l.text === "b")).toBe(true)
    expect(d.some((l) => l.type === "add" && l.text === "B")).toBe(true)
  })
  test("appended line → trailing add", () => {
    const d = diffLines("a", "a\nb")
    expect(d).toEqual([
      { type: "eq", text: "a" },
      { type: "add", text: "b" },
    ])
  })
})

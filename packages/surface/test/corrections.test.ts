import { describe, expect, test } from "bun:test"
import {
  applyAnchoredChanges,
  countOccurrences,
  parseProposedChanges,
  validateProposedChanges,
} from "../src/corrections"

describe("parseProposedChanges", () => {
  test("parses a clean JSON object", () => {
    const raw = JSON.stringify({
      changes: [{ before: "Cloud", after: "Claude", reason: "stt" }],
    })
    expect(parseProposedChanges(raw)).toEqual([{ before: "Cloud", after: "Claude", reason: "stt" }])
  })

  test("salvages JSON wrapped in prose / fences", () => {
    const raw = 'Here you go:\n```json\n{"changes":[{"before":"a","after":"b"}]}\n```'
    expect(parseProposedChanges(raw)).toEqual([{ before: "a", after: "b", reason: "" }])
  })

  test("null / garbage / non-array → []", () => {
    expect(parseProposedChanges(null)).toEqual([])
    expect(parseProposedChanges("not json")).toEqual([])
    expect(parseProposedChanges('{"changes":"nope"}')).toEqual([])
  })

  test("drops entries with an empty before anchor", () => {
    const raw = JSON.stringify({
      changes: [
        { before: "", after: "x" },
        { before: "y", after: "z" },
      ],
    })
    expect(parseProposedChanges(raw)).toEqual([{ before: "y", after: "z", reason: "" }])
  })
})

describe("validateProposedChanges", () => {
  const body = "Cloud for everyone, and Cloud Con, and Cloudflare. Fix Entropic once."

  test("unique anchor → applicable; ambiguous → skipped; not-found → skipped; no-op → skipped", () => {
    const { changes, skipped } = validateProposedChanges(body, [
      { before: "Cloud for everyone", after: "Claude for everyone", reason: "stt" }, // unique
      { before: "Cloud", after: "Claude", reason: "stt" }, // ambiguous (many)
      { before: "Anthropic", after: "Anthropic Inc", reason: "x" }, // not found
      { before: "Entropic", after: "Entropic", reason: "x" }, // no-op
    ])
    expect(changes.map((c) => c.before)).toEqual(["Cloud for everyone"])
    expect(changes[0]?.id).toBe(1)
    expect(changes[0]?.preview).toContain("Cloud for everyone → Claude for everyone")
    expect(skipped.map((s) => s.why)).toEqual([
      "ambiguous — anchor matches 3 times",
      "anchor not found in body",
      "no-op (before === after)",
    ])
  })
})

describe("applyAnchoredChanges", () => {
  test("applies a unique change", () => {
    const { body, applied } = applyAnchoredChanges("hello Cloud world", [
      { before: "Cloud", after: "Claude" },
    ])
    expect(body).toBe("hello Claude world")
    expect(applied).toBe(1)
  })

  test("treats $ in replacement literally (indexOf-splice, not String.replace)", () => {
    const { body } = applyAnchoredChanges("price is X", [{ before: "X", after: "$5 (was $$)" }])
    expect(body).toBe("price is $5 (was $$)")
  })

  test("fails closed and applies NOTHING when any anchor is ambiguous", () => {
    expect(() =>
      applyAnchoredChanges("Cloud and Cloud", [{ before: "Cloud", after: "Claude" }]),
    ).toThrow(/matched 2 time/)
  })

  test("fails closed when an anchor is not found", () => {
    expect(() => applyAnchoredChanges("nothing here", [{ before: "X", after: "Y" }])).toThrow(
      /matched 0 time/,
    )
  })

  test("sequential changes each re-validated against the evolving body", () => {
    const { body, applied } = applyAnchoredChanges("a b c", [
      { before: "a", after: "A" },
      { before: "c", after: "C" },
    ])
    expect(body).toBe("A b C")
    expect(applied).toBe(2)
  })
})

describe("countOccurrences", () => {
  test("counts non-overlapping; empty needle → 0", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2)
    expect(countOccurrences("abc", "")).toBe(0)
  })
})

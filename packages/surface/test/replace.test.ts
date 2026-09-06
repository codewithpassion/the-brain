import { describe, expect, test } from "bun:test"
import { planReplacements } from "../src/replace"

const transcript = [
  "# Transcript: plaud-abc.mp3",
  "",
  "### [00:00]",
  "**Speaker 0**: hello there",
  "**Speaker 1**: hi",
  "**Speaker 0**: Speaker 0 says Speaker 10 is late",
  "**Speaker 10**: sorry",
].join("\n")

describe("planReplacements", () => {
  test("relabels every occurrence of each literal rule in one pass", () => {
    const plan = planReplacements(transcript, [
      { find: "**Speaker 0**:", replaceWith: "**Zoe Smith**:", expectedCount: 2 },
      { find: "**Speaker 1**:", replaceWith: "**Dominik Fretz**:", expectedCount: 1 },
    ])
    expect(plan.results).toEqual([
      { find: "**Speaker 0**:", count: 2 },
      { find: "**Speaker 1**:", count: 1 },
    ])
    expect(plan.body).not.toContain("**Speaker 0**:")
    expect(plan.body).toContain("**Zoe Smith**: hello there")
    expect(plan.body).toContain("**Dominik Fretz**: hi")
    // Untouched: the unbolded mention inside a line and the `Speaker 10` label.
    expect(plan.body).toContain("Speaker 0 says Speaker 10 is late")
    expect(plan.body).toContain("**Speaker 10**: sorry")
    expect(plan.body.split("\n").length).toBe(transcript.split("\n").length)
  })

  test("single pass: a later rule cannot match text an earlier rule wrote", () => {
    const plan = planReplacements("a b", [
      { find: "a", replaceWith: "b" },
      { find: "b", replaceWith: "c" },
    ])
    expect(plan.body).toBe("b c")
    expect(plan.results.map((r) => r.count)).toEqual([1, 1])
  })

  test("aborts with actual counts when expectedCount disagrees", () => {
    expect(() =>
      planReplacements(transcript, [
        { find: "**Speaker 0**:", replaceWith: "x", expectedCount: 791 },
        { find: "**Speaker 1**:", replaceWith: "y", expectedCount: 1 },
      ]),
    ).toThrow(/rule 1 expected 791 matches but found 2.*Actual counts.*"\*\*Speaker 0\*\*:": 2/)
  })

  test("aborts when any rule matches zero times", () => {
    expect(() =>
      planReplacements(transcript, [
        { find: "**Speaker 0**:", replaceWith: "x" },
        { find: "**Speaker 7**:", replaceWith: "y" },
      ]),
    ).toThrow(/rule 2 matched 0 times/)
  })

  test("aborts on overlapping matches from different rules", () => {
    expect(() =>
      planReplacements("hello world", [
        { find: "hello w", replaceWith: "a" },
        { find: "world", replaceWith: "b" },
      ]),
    ).toThrow(/overlap/)
  })

  test("regex rules expand $1 / $<name> templates and force the g flag", () => {
    const plan = planReplacements(transcript, [
      { find: "\\*\\*Speaker (\\d+)\\*\\*:", replaceWith: "[S$1]:", isRegex: true, flags: "" },
    ])
    expect(plan.results[0]?.count).toBe(4)
    expect(plan.body).toContain("[S0]: hello there")
    expect(plan.body).toContain("[S10]: sorry")
    const named = planReplacements("x=1", [
      { find: "(?<k>\\w)=(?<v>\\d)", replaceWith: "$<v>=$<k> $$", isRegex: true },
    ])
    expect(named.body).toBe("1=x $")
  })

  test("rejects invalid regex, bad flags, and empty-string matches", () => {
    expect(() => planReplacements("a", [{ find: "(", replaceWith: "", isRegex: true }])).toThrow(
      /not a valid regex/,
    )
    expect(() =>
      planReplacements("a", [{ find: "a", replaceWith: "", isRegex: true, flags: "gx" }]),
    ).toThrow(/invalid regex flags/)
    expect(() => planReplacements("a", [{ find: "b*", replaceWith: "", isRegex: true }])).toThrow(
      /empty string/,
    )
    expect(() => planReplacements("a", [{ find: "", replaceWith: "" }])).toThrow(/empty find/)
    expect(() => planReplacements("a", [])).toThrow(/no replacements/)
  })

  test("diff shows one hunk per run of touched lines, capped", () => {
    const plan = planReplacements(transcript, [{ find: "**Speaker 0**:", replaceWith: "**T**:" }])
    expect(plan.diff).toContain("@@ -4,1 +4,1 @@")
    expect(plan.diff).toContain("-**Speaker 0**: hello there")
    expect(plan.diff).toContain("+**T**: hello there")
    expect(plan.diff).toContain("@@ -6,1 +6,1 @@")
    const capped = planReplacements(
      transcript,
      [{ find: "**Speaker 0**:", replaceWith: "**T**:" }],
      { maxDiffLines: 3 },
    )
    expect(capped.diff.split("\n").length).toBe(4)
    expect(capped.diff).toMatch(/3 more diff line\(s\) omitted$/)
  })

  test("a replacement containing newlines changes the line count and the diff says so", () => {
    const plan = planReplacements("a\nb", [{ find: "a", replaceWith: "x\ny" }])
    expect(plan.body).toBe("x\ny\nb")
    expect(plan.diff).toContain("@@ -1,1 +1,2 @@")
  })
})

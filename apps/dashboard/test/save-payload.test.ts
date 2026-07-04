import { describe, expect, test } from "bun:test"
import { buildWikiSavePayload, type WikiEditState } from "../src/lib/save-payload"

const base: WikiEditState = {
  slug: "guides/intro",
  type: "guide",
  body: "hello",
  title: "Intro",
  tags: ["a", " b ", ""],
  draft: false,
  visibilityTouched: false,
  visibility: "world",
}

describe("buildWikiSavePayload — visibility-preserve invariant", () => {
  test("visibility is OMITTED when untouched (edit keeps tier / new page defaults private)", () => {
    const p = buildWikiSavePayload(base)
    expect("visibility" in p).toBe(false)
  })
  test("visibility is SENT only when the user touched the control", () => {
    const p = buildWikiSavePayload({ ...base, visibilityTouched: true, visibility: "team" })
    expect(p.visibility).toBe("team")
  })
  test("touched but empty visibility is still omitted", () => {
    const p = buildWikiSavePayload({ ...base, visibilityTouched: true, visibility: "" })
    expect("visibility" in p).toBe(false)
  })
  test("tags are trimmed and empties dropped; slug/type/title trimmed", () => {
    const p = buildWikiSavePayload({ ...base, slug: " s ", type: " ", title: " T " })
    expect(p.tags).toEqual(["a", "b"])
    expect(p.slug).toBe("s")
    expect(p.type).toBe("note") // empty type falls back to 'note'
    expect(p.title).toBe("T")
  })
  test("draft flag passes through", () => {
    expect(buildWikiSavePayload({ ...base, draft: true }).draft).toBe(true)
  })
})

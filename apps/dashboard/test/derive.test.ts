import { describe, expect, test } from "bun:test"
import { foldDocuments } from "../src/server/derive"
import type { SearchHit } from "../src/server/types"

const hit = (documentId: string, slug: string, score: number, snippet: string): SearchHit => ({
  id: `${documentId}-${score}`,
  documentId,
  slug,
  score,
  snippet,
})

describe("foldDocuments", () => {
  test("collapses hits into distinct documents, keeping the best snippet", () => {
    const docs = foldDocuments([
      hit("d1", "alpha", 0.4, "low"),
      hit("d1", "alpha", 0.9, "high"),
      hit("d2", "beta", 0.5, "beta-snip"),
    ])
    expect(docs).toHaveLength(2)
    const d1 = docs.find((d) => d.documentId === "d1")
    expect(d1?.hitCount).toBe(2)
    expect(d1?.topScore).toBe(0.9)
    expect(d1?.snippet).toBe("high")
  })

  test("sorts documents by top score descending", () => {
    const docs = foldDocuments([hit("a", "a", 0.2, "a"), hit("b", "b", 0.8, "b")])
    expect(docs.map((d) => d.documentId)).toEqual(["b", "a"])
  })

  test("returns an empty list for no hits", () => {
    expect(foldDocuments([])).toEqual([])
  })
})

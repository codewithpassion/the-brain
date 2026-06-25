import { describe, expect, test } from "bun:test"
import { TITLE_BOOST } from "@brain/shared"
import { isTitlePhraseMatch, rrfFusion } from "../src/search/fusion"
import type { Candidate } from "../src/search/types"
import { toCandidate } from "../src/search/types"

/**
 * RRF fusion + boost ranking (PRD §5.3.3). Pure unit tests over hand-built candidates —
 * assertions are on RELATIVE ordering and boost RATIOS, never absolute RRF constants, so the
 * exact `1/(K+rank)` base is an implementation detail the tests don't pin.
 */

const cand = (id: string, over: Partial<Candidate> = {}): Candidate =>
  toCandidate(
    {
      id,
      documentId: "d",
      content: `content of ${id}`,
      headingPath: null,
      chunkSource: null,
      embeddedAt: null,
      embeddingModel: "@cf/baai/bge-m3",
      updatedAt: "2026-06-25T00:00:00.000Z",
      slug: id,
      title: over.title ?? null,
      sourceId: null,
      trustGrade: over.trustGrade ?? "evidence",
    },
    0,
  )

const score = (fused: ReturnType<typeof rrfFusion>, id: string): number =>
  fused.find((f) => f.candidate.chunkId === id)?.score ?? 0

describe("rrfFusion ordering (invariant: position-based reciprocal rank)", () => {
  test("a chunk in BOTH arms outranks chunks in only one arm", () => {
    const armA = [cand("c1"), cand("c2"), cand("c3")]
    const armB = [cand("c2"), cand("c4")]
    const fused = rrfFusion([armA, armB], "no title match here")
    // c2 is fused across both arms → top.
    expect(fused[0]?.candidate.chunkId).toBe("c2")
    // higher position in a single arm beats lower position (c1 rank0 > c3 rank2).
    expect(score(fused, "c1")).toBeGreaterThan(score(fused, "c3"))
  })

  test("normalize-by-max puts the top fused score at 1.0 before boosts", () => {
    const fused = rrfFusion([[cand("only")]], "nomatch")
    // single evidence candidate, no title match → normalized 1.0 × 1.0 × 1.0.
    expect(score(fused, "only")).toBeCloseTo(1.0, 10)
  })

  test("empty arms fuse to an empty list", () => {
    expect(rrfFusion([[], []], "q")).toEqual([])
  })
})

describe("trust-grade boost (PRD §5.3.3, TRUST_BOOST)", () => {
  test("an instruction chunk at a LOWER position overtakes an evidence chunk above it", () => {
    // Same arm: evidence at rank0, instruction at rank1. Without the 2.0 trust boost the
    // evidence chunk (better position) would win; the boost flips it.
    const arm = [cand("ev", { trustGrade: "evidence" }), cand("ins", { trustGrade: "instruction" })]
    const fused = rrfFusion([arm], "nomatch")
    expect(fused[0]?.candidate.chunkId).toBe("ins")
    expect(score(fused, "ins")).toBeGreaterThan(score(fused, "ev"))
  })

  test("a draft chunk is demoted below an equal-position evidence chunk", () => {
    const armA = [cand("ev", { trustGrade: "evidence" })]
    const armB = [cand("dr", { trustGrade: "draft" })]
    const fused = rrfFusion([armA, armB], "nomatch")
    // equal raw (both rank0 in their own arm) → draft's 0.6 factor demotes it.
    expect(score(fused, "ev")).toBeGreaterThan(score(fused, "dr"))
    expect(score(fused, "dr") / score(fused, "ev")).toBeCloseTo(0.6, 5)
  })
})

describe("title boost (×TITLE_BOOST)", () => {
  test("a title-phrase match multiplies the normalized score by TITLE_BOOST", () => {
    const armA = [cand("titled", { title: "alpha beta gamma" })]
    const armB = [cand("plain", { title: "unrelated heading" })]
    const fused = rrfFusion([armA, armB], "alpha beta")
    expect(fused[0]?.candidate.chunkId).toBe("titled")
    expect(score(fused, "titled") / score(fused, "plain")).toBeCloseTo(TITLE_BOOST, 5)
  })
})

describe("isTitlePhraseMatch (contiguous run, ≥2 content-token floor)", () => {
  test("matches a contiguous multi-token run inside the title", () => {
    expect(isTitlePhraseMatch("alpha beta", "the alpha beta protocol")).toBe(true)
  })
  test("rejects a single-token query (too weak to boost)", () => {
    expect(isTitlePhraseMatch("alpha", "the alpha beta protocol")).toBe(false)
  })
  test("rejects a non-contiguous match", () => {
    expect(isTitlePhraseMatch("alpha gamma", "alpha beta gamma")).toBe(false)
  })
  test("rejects when the title is null", () => {
    expect(isTitlePhraseMatch("alpha beta", null)).toBe(false)
  })
})

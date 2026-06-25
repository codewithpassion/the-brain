import { describe, expect, test } from "bun:test"
import { OpRegistry, type Principal } from "@brain/shared"
import type { ScopedChunk } from "../src/scoped/db"
import { ScopedDB } from "../src/scoped/db"
import { ScopedVectorize } from "../src/scoped/vectorize"
import { registerSearchOps, searchOp, thinkOp } from "../src/search/ops"
import { rerankStage } from "../src/search/rerank-stage"
import { buildSynthesisPrompt } from "../src/search/synthesis"
import type {
  AiPort,
  AiRerankHit,
  BudgetPort,
  FusedCandidate,
  RecallTraceBatch,
  SearchDeps,
} from "../src/search/types"
import { toCandidate } from "../src/search/types"
import { insertChunk, insertDoc, makeDb, principal } from "./helpers"

/**
 * The composed pipeline over a REAL bun:sqlite D1 with deterministic stub seams (no Workers
 * AI locally). Proves: the `think` envelope shape, evidence/citations sourced ONLY from
 * re-checked hydrated rows, rerank degrade-to-RRF (scores preserved, not zeroed), token-budget
 * truncation, off-read-path recall, and the 429 budget pre-check.
 */

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

/** A configurable AI stub. embed→one 1024-vec; gen/rerank overridable. */
const stubAi = (over: Partial<AiPort> = {}): AiPort => ({
  embed: async () => [vec1024()],
  gen: async () => "stub synthesized answer",
  rerank: async (_q, candidates, topK) =>
    candidates.map((_c, index) => ({ index, score: 0 })).slice(0, topK), // identity = degrade
  ...over,
})

const okBudget = (): BudgetPort => ({ check: async () => {} })

const recorder = (): {
  sink: { append: (b: RecallTraceBatch) => Promise<void> }
  seen: RecallTraceBatch[]
} => {
  const seen: RecallTraceBatch[] = []
  return {
    sink: {
      append: async (b) => {
        seen.push(b)
      },
    },
    seen,
  }
}

/** A fake Vectorize binding returning a fixed match list (ids the re-check then vets). */
const fakeIndex = (matches: { id: string; score: number }[]) =>
  ({
    query: async () => ({ count: matches.length, matches }),
  }) as unknown as Vectorize

// ── rerankStage: order/selection only, fusion score preserved on degrade ─────────

const scopedChunk = (id: string): ScopedChunk => ({
  id,
  documentId: "d",
  content: `c-${id}`,
  headingPath: null,
  chunkSource: null,
  embeddedAt: null,
  embeddingModel: "@cf/baai/bge-m3",
  updatedAt: "t",
  slug: id,
  title: null,
  sourceId: null,
  trustGrade: "evidence",
})

const fc = (id: string, score: number): FusedCandidate => ({
  candidate: toCandidate(scopedChunk(id), 0),
  score,
})

describe("rerankStage (invariants 14, 20)", () => {
  test("degrade (identity hits, score 0) preserves RRF order AND the fusion scores", async () => {
    const ai = stubAi() // identity rerank = degrade path
    const input = [fc("a", 0.9), fc("b", 0.5), fc("c", 0.1)]
    const out = await rerankStage(ai, "q", input, 3)
    expect(out.map((f) => f.candidate.chunkId)).toEqual(["a", "b", "c"]) // RRF order kept
    // CRITICAL: scores are the fusion scores, NOT the reranker's zeros.
    expect(out.map((f) => f.score)).toEqual([0.9, 0.5, 0.1])
  })

  test("a real rerank reorders by the model's index order but keeps fusion scores", async () => {
    const hits: AiRerankHit[] = [
      { index: 2, score: 0.99 },
      { index: 0, score: 0.98 },
    ]
    const ai = stubAi({ rerank: async () => hits })
    const input = [fc("a", 0.9), fc("b", 0.5), fc("c", 0.1)]
    const out = await rerankStage(ai, "q", input, 2)
    expect(out.map((f) => f.candidate.chunkId)).toEqual(["c", "a"]) // reordered by reranker
    expect(out.map((f) => f.score)).toEqual([0.1, 0.9]) // but scores stay the fusion scores
  })
})

// ── buildSynthesisPrompt: token-budget guard ─────────────────────────────────────

describe("buildSynthesisPrompt token-budget guard (PRD §5.5)", () => {
  test("packs highest-first and SURFACES eviction in warnings + gaps", () => {
    const big = "x".repeat(400) // ~100 tokens each
    const ranked = [fc("a", 0.9), fc("b", 0.8), fc("c", 0.7)].map((f) => ({
      ...f,
      candidate: { ...f.candidate, content: big },
    }))
    const built = buildSynthesisPrompt("q", ranked, 150) // budget fits ~1 block
    expect(built.used.length).toBeLessThan(ranked.length)
    expect(built.warnings.some((w) => w.startsWith("evidence_evicted:"))).toBe(true)
    expect(built.gaps.length).toBeGreaterThan(0)
  })

  test("a single oversized top hit is truncated-to-fit and surfaced (never silent)", () => {
    const huge = "y".repeat(10_000)
    const ranked = [{ ...fc("solo", 1), candidate: { ...fc("solo", 1).candidate, content: huge } }]
    const built = buildSynthesisPrompt("q", ranked, 100)
    expect(built.used.length).toBe(1)
    expect(built.warnings).toContain("evidence_truncated:solo")
    expect(built.used[0]?.candidate.content.length).toBeLessThan(huge.length)
  })

  test("everything fits → no warnings", () => {
    const ranked = [fc("a", 0.9), fc("b", 0.8)]
    const built = buildSynthesisPrompt("q", ranked, 20_000)
    expect(built.used.length).toBe(2)
    expect(built.warnings).toEqual([])
  })
})

// ── think handler end-to-end over real bun:sqlite ────────────────────────────────

const seedOne = (
  p: Principal,
  opts: { matches: { id: string; score: number }[]; ai?: AiPort; budget?: BudgetPort },
) => {
  const { sqlite, db } = makeDb()
  insertDoc(sqlite, { id: "doc-1", tenantId: p.tenantId, slug: "needle-doc" })
  insertChunk(sqlite, {
    id: "chunk-1",
    tenantId: p.tenantId,
    documentId: "doc-1",
    content: "the kryptonite needle lives here",
  })
  const rec = recorder()
  const deps: SearchDeps = {
    db: new ScopedDB(db, p),
    vectors: new ScopedVectorize(fakeIndex(opts.matches), p),
    ai: opts.ai ?? stubAi(),
    budget: opts.budget ?? okBudget(),
    recall: rec.sink,
  }
  return { deps, rec }
}

describe("think handler (PRD §5.5 envelope)", () => {
  const p = principal({ tenantId: "t1", userId: "userA" })

  test("returns the full envelope with a synthesized answer and slug citations", async () => {
    const { deps, rec } = seedOne(p, { matches: [{ id: "chunk-1", score: 0.9 }] })
    const out = await thinkOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })

    expect(out.answer).toBe("stub synthesized answer")
    expect(Object.keys(out).sort()).toEqual(["answer", "citations", "evidence", "gaps", "warnings"])
    expect(out.evidence.map((e) => e.slug)).toEqual(["needle-doc"])
    expect(out.evidence[0]?.id).toBe("chunk-1")
    expect(out.evidence[0]?.score).toBeGreaterThan(0) // fusion score, not the reranker's 0
    expect(out.citations).toEqual([{ slug: "needle-doc", chunkId: "chunk-1" }])
    // recall written off the read path, keyed by the HYDRATED chunk id.
    expect(rec.seen).toHaveLength(1)
    expect(rec.seen[0]?.hits).toEqual([{ chunkId: "chunk-1", score: out.evidence[0]?.score ?? -1 }])
  })

  test("evidence/citations are built ONLY from re-checked rows — a ghost vector id is dropped", async () => {
    // The fake vector arm leaks an id with no D1 row; the re-check drops it.
    const { deps } = seedOne(p, {
      matches: [
        { id: "ghost-not-in-db", score: 0.95 },
        { id: "chunk-1", score: 0.9 },
      ],
    })
    const out = await thinkOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })
    const ids = out.evidence.map((e) => e.id)
    expect(ids).toContain("chunk-1")
    expect(ids).not.toContain("ghost-not-in-db")
    expect(out.citations.every((c) => c.chunkId !== "ghost-not-in-db")).toBe(true)
  })

  test("gen() degrade → evidence-without-synthesis (answer '' + llm_unavailable)", async () => {
    const { deps } = seedOne(p, {
      matches: [{ id: "chunk-1", score: 0.9 }],
      ai: stubAi({ gen: async () => null }),
    })
    const out = await thinkOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })
    expect(out.answer).toBe("")
    expect(out.warnings).toContain("llm_unavailable")
    expect(out.evidence.length).toBeGreaterThan(0) // evidence still returned
  })

  test("no evidence → no_evidence warning, no recall rows", async () => {
    const { deps, rec } = seedOne(p, { matches: [] }) // empty vector arm; query won't FTS-match
    const out = await thinkOp.handler({ deps, principal: p }, { query: "zzzznomatch", topK: 12 })
    expect(out.evidence).toEqual([])
    expect(out.warnings).toContain("no_evidence")
    expect(out.answer).toBe("")
    // zero hits write zero traces (invariant 10 / s05 §5.7) — append is NOT called.
    expect(rec.seen).toHaveLength(0)
  })

  test("budget.check() throwing 429 propagates BEFORE any AI work (invariant 16)", async () => {
    let embedCalled = false
    const { deps } = seedOne(p, {
      matches: [{ id: "chunk-1", score: 0.9 }],
      budget: {
        check: async () => {
          throw new Error("429 token_spend cap exceeded")
        },
      },
      ai: stubAi({
        embed: async () => {
          embedCalled = true
          return [vec1024()]
        },
      }),
    })
    await expect(
      thinkOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 }),
    ).rejects.toThrow(/429/)
    expect(embedCalled).toBe(false) // the cap fired before embed()
  })
})

describe("search handler (rerank OFF, no synthesis)", () => {
  test("returns hits only", async () => {
    const p = principal({ tenantId: "t1" })
    const { deps } = seedOne(p, { matches: [{ id: "chunk-1", score: 0.9 }] })
    const out = await searchOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })
    expect(out.hits.map((h) => h.slug)).toEqual(["needle-doc"])
  })
})

describe("registerSearchOps (build-item 6: op-registry registration)", () => {
  test("registers search / query / think contracts into an OpRegistry", () => {
    const registry = registerSearchOps(new OpRegistry())
    expect(
      registry
        .list()
        .map((op) => op.name)
        .sort(),
    ).toEqual(["query", "search", "think"])
    expect(registry.get("think")?.capability).toBe("read")
    expect(registry.get("query")?.readOnly).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { CANDIDATE_TOP, OpRegistry, type Principal, VECTORIZE_TOPK_MAX } from "@brain/shared"
import type { ScopedChunk } from "../src/scoped/db"
import { ScopedDB } from "../src/scoped/db"
import { ScopedVectorize } from "../src/scoped/vectorize"
import { expandQuery } from "../src/search/expand"
import { registerSearchOps, searchOp, thinkOp } from "../src/search/ops"
import { hybridSearch } from "../src/search/pipeline"
import { rerankStage } from "../src/search/rerank-stage"
import { buildSynthesisPrompt, partitionForMap, synthesizeAnswer } from "../src/search/synthesis"
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

// ── Namespace-scoped search (path + tag filter) ─────────────────────────────────

/**
 * Seed two docs for the SAME tenant: one under /project/x, one under /other.
 * The fake Vectorize arm surfaces BOTH chunk ids, proving the re-check is the gate.
 */
const seedTwoDocs = (p: Parameters<typeof principal>[0] & { tenantId: string }) => {
  const { sqlite, db } = makeDb()
  const tid = p.tenantId
  // /project/x doc + chunk
  sqlite.run(
    `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, path, tags)
     VALUES ('doc-px', ?, 'userA', 'slug-px', 'indexed', 'fp-px', '/project/x', '["proj"]')`,
    [tid],
  )
  sqlite.run(
    `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content,
                         embedding_model, embedding_dims, updated_at, path)
     VALUES ('chunk-px', ?, 'doc-px', 'world', 0, 'project x content',
             '@cf/baai/bge-m3', 1024, '2026-06-25T00:00:00.000Z', '/project/x')`,
    [tid],
  )
  // /other doc + chunk
  sqlite.run(
    `INSERT INTO documents (id, tenant_id, user_id, slug, status, fingerprint, path, tags)
     VALUES ('doc-other', ?, 'userA', 'slug-other', 'indexed', 'fp-other', '/other', '["other"]')`,
    [tid],
  )
  sqlite.run(
    `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content,
                         embedding_model, embedding_dims, updated_at, path)
     VALUES ('chunk-other', ?, 'doc-other', 'world', 0, 'other content',
             '@cf/baai/bge-m3', 1024, '2026-06-25T00:00:00.000Z', '/other')`,
    [tid],
  )
  const rec = recorder()
  const deps: SearchDeps = {
    db: new ScopedDB(db, principal(p)),
    // Adversarial Vectorize: surfaces BOTH chunks for any query.
    vectors: new ScopedVectorize(
      fakeIndex([
        { id: "chunk-px", score: 0.95 },
        { id: "chunk-other", score: 0.91 },
      ]),
      principal(p),
    ),
    ai: stubAi(),
    budget: okBudget(),
    recall: rec.sink,
  }
  return { deps, rec }
}

describe("namespace-scoped search: path + tag filter via D1 re-check (non-vacuous)", () => {
  const p = { tenantId: "t1" }

  test("non-vacuity: no filter returns BOTH chunks (adversarial arm surfaces both)", async () => {
    const { deps } = seedTwoDocs(p)
    const out = await searchOp.handler(
      { deps, principal: principal(p) },
      { query: "content", topK: 12 },
    )
    const slugs = out.hits.map((h) => h.slug).sort()
    expect(slugs).toContain("slug-px")
    expect(slugs).toContain("slug-other")
  })

  test("path filter: /project returns only /project/x, drops /other (non-vacuous)", async () => {
    const { deps } = seedTwoDocs(p)
    const out = await searchOp.handler(
      { deps, principal: principal(p) },
      { query: "content", topK: 12, path: "/project" },
    )
    expect(out.hits.map((h) => h.slug)).toEqual(["slug-px"])
    expect(out.hits.map((h) => h.slug)).not.toContain("slug-other")
  })

  test("tag filter: 'proj' tag returns only slug-px, drops slug-other", async () => {
    const { deps } = seedTwoDocs(p)
    const out = await searchOp.handler(
      { deps, principal: principal(p) },
      { query: "content", topK: 12, tag: "proj" },
    )
    expect(out.hits.map((h) => h.slug)).toEqual(["slug-px"])
    expect(out.hits.map((h) => h.slug)).not.toContain("slug-other")
  })

  test("no-arg search is byte-identical to before (existing tests unaffected)", async () => {
    // Proves path/tag are truly optional with no side-effect when absent.
    const p2 = principal({ tenantId: "t1" })
    const { deps } = seedOne(p2, { matches: [{ id: "chunk-1", score: 0.9 }] })
    const out = await searchOp.handler({ deps, principal: p2 }, { query: "kryptonite", topK: 12 })
    expect(out.hits.map((h) => h.slug)).toEqual(["needle-doc"])
  })
})

// ── W4.2 filtered-query breadth widening ─────────────────────────────────────────

describe("W4.2 breadth widening (armTopK→VECTORIZE_TOPK_MAX when a filter is active)", () => {
  const recordingDeps = (): { deps: SearchDeps; topKs: number[] } => {
    const topKs: number[] = []
    const { db } = makeDb()
    const p = principal({ tenantId: "t1" })
    const index = {
      query: async (_values: number[], opts: { topK: number }) => {
        topKs.push(opts.topK)
        return { count: 0, matches: [] }
      },
    } as unknown as Vectorize
    const deps: SearchDeps = {
      db: new ScopedDB(db, p),
      vectors: new ScopedVectorize(index, p),
      ai: stubAi(),
      budget: okBudget(),
      recall: recorder().sink,
    }
    return { deps, topKs }
  }

  test("no filter → the vector arm fetches only candidateTop (CANDIDATE_TOP)", async () => {
    const { deps, topKs } = recordingDeps()
    await hybridSearch(deps, "q", { topK: 12, rerank: false })
    expect(topKs).toContain(CANDIDATE_TOP)
    expect(topKs).not.toContain(VECTORIZE_TOPK_MAX)
  })

  test("path filter → the vector arm fetches VECTORIZE_TOPK_MAX (post-hoc re-check gets the max pool)", async () => {
    const { deps, topKs } = recordingDeps()
    await hybridSearch(deps, "q", { topK: 12, rerank: false, filter: { path: "/project/x" } })
    expect(topKs).toContain(VECTORIZE_TOPK_MAX)
    expect(topKs).not.toContain(CANDIDATE_TOP)
  })

  test("tag filter → same breadth widening", async () => {
    const { deps, topKs } = recordingDeps()
    await hybridSearch(deps, "q", { topK: 12, rerank: false, filter: { tag: "important" } })
    expect(topKs).toContain(VECTORIZE_TOPK_MAX)
  })
})

// ── W4.3 synthesis map/refine ──────────────────────────────────────────────────────

describe("synthesizeAnswer map/refine (W4.3)", () => {
  const budgetOk = async () => {}
  const bigCandidates = () =>
    [fc("a", 0.9), fc("b", 0.8), fc("c", 0.7)].map((f) => ({
      ...f,
      candidate: { ...f.candidate, content: "z".repeat(400) }, // ~100 tokens each
    }))

  test("fits budget → a single gen(), no map/refine", async () => {
    let calls = 0
    const ai = {
      gen: async () => {
        calls++
        return "answer"
      },
    }
    const out = await synthesizeAnswer(ai, budgetOk, "q", [fc("a", 0.9), fc("b", 0.8)], 20_000)
    expect(calls).toBe(1)
    expect(out.answer).toBe("answer")
    expect(out.warnings).not.toContain("map_refine")
  })

  test("over budget → map each group then refine; answer from refine, budget-checked per gen", async () => {
    const prompts: string[] = []
    let budgetChecks = 0
    const ai = {
      gen: async (p: string) => {
        prompts.push(p)
        return p.includes("Evidence summaries") ? "final answer" : "group summary"
      },
    }
    const out = await synthesizeAnswer(
      ai,
      async () => {
        budgetChecks++
      },
      "q",
      bigCandidates(),
      150, // tiny budget → one 1-chunk group per candidate → 3 map + 1 refine
    )
    const mapCalls = prompts.filter((p) => !p.includes("Evidence summaries")).length
    const refineCalls = prompts.filter((p) => p.includes("Evidence summaries")).length
    expect(mapCalls).toBe(3)
    expect(refineCalls).toBe(1)
    expect(out.answer).toBe("final answer")
    expect(out.warnings).toContain("map_refine")
    expect(budgetChecks).toBe(4) // invariant 16: one cost-cap check before each gen()
  })

  test("a failed map gen() degrades to the truncate path (marked, never worse than before)", async () => {
    const ai = {
      gen: async (p: string) => (p.includes("Summarize the evidence") ? null : "truncated answer"),
    }
    const out = await synthesizeAnswer(ai, budgetOk, "q", bigCandidates(), 150)
    expect(out.warnings).toContain("map_refine_degraded")
    expect(out.answer).toBe("truncated answer")
  })

  test("a failed refine gen() → answer null (caller emits llm_unavailable)", async () => {
    const ai = {
      gen: async (p: string) => (p.includes("Evidence summaries") ? null : "summary"),
    }
    const out = await synthesizeAnswer(ai, budgetOk, "q", bigCandidates(), 150)
    expect(out.answer).toBeNull()
    expect(out.warnings).toContain("map_refine")
  })

  test("partitionForMap splits on the token budget, preserving rank order", () => {
    const groups = partitionForMap(bigCandidates(), 150)
    expect(groups.length).toBe(3)
    expect(groups.flat().map((g) => g.candidate.chunkId)).toEqual(["a", "b", "c"])
  })
})

// ── W4.1 query expansion ─────────────────────────────────────────────────────────

describe("expandQuery (W4.1)", () => {
  test("returns [query, ...variants], cleaning bullets/numbering and deduping", async () => {
    const ai = stubAi({
      gen: async () => "1. red widget cost\n- widget pricing\nRED WIDGET COST\n\nwidget price list",
    })
    const out = await expandQuery(ai, "red widget cost")
    expect(out[0]).toBe("red widget cost") // original first, untouched
    // numbering/bullets stripped; the case-insensitive dup of the original dropped
    expect(out).toContain("widget pricing")
    expect(out).toContain("widget price list")
    expect(out).not.toContain("RED WIDGET COST")
    expect(new Set(out.map((s) => s.toLowerCase())).size).toBe(out.length) // deduped
  })

  test("caps variants at the requested count", async () => {
    const ai = stubAi({ gen: async () => "a\nb\nc\nd\ne" })
    const out = await expandQuery(ai, "q", 2)
    expect(out).toEqual(["q", "a", "b"]) // original + 2 variants
  })

  test("gen() degrade (null) → [query] only (never narrower than the plain path)", async () => {
    const ai = stubAi({ gen: async () => null })
    expect(await expandQuery(ai, "q")).toEqual(["q"])
  })
})

describe("think handler query expansion wiring", () => {
  const p = principal({ tenantId: "t1", userId: "userA" })

  test("expansion ON by default: an extra gen() call precedes synthesis, envelope intact", async () => {
    const genPrompts: string[] = []
    const { deps } = seedOne(p, {
      matches: [{ id: "chunk-1", score: 0.9 }],
      ai: stubAi({
        gen: async (prompt) => {
          genPrompts.push(prompt)
          return "alt phrasing"
        },
      }),
    })
    const out = await thinkOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })
    // two gen() calls: one expansion (default ON for think) + one synthesis.
    expect(genPrompts.length).toBe(2)
    expect(genPrompts.some((pr) => pr.includes("alternative phrasings"))).toBe(true)
    expect(out.evidence.map((e) => e.slug)).toEqual(["needle-doc"]) // retrieval still works
  })

  test("expandQuery:false → NO expansion gen(); only the synthesis call runs", async () => {
    const genPrompts: string[] = []
    const { deps } = seedOne(p, {
      matches: [{ id: "chunk-1", score: 0.9 }],
      ai: stubAi({
        gen: async (prompt) => {
          genPrompts.push(prompt)
          return "answer"
        },
      }),
    })
    const out = await thinkOp.handler(
      { deps, principal: p },
      { query: "kryptonite", topK: 12, expandQuery: false },
    )
    expect(genPrompts.length).toBe(1) // synthesis only
    expect(genPrompts[0]?.includes("alternative phrasings")).toBe(false)
    expect(out.answer).toBe("answer")
  })

  test("expansion gen() degrade does not break think (still cites the original-query evidence)", async () => {
    // gen returns null → expansion degrades to [query] AND synthesis degrades to no-answer.
    const { deps } = seedOne(p, {
      matches: [{ id: "chunk-1", score: 0.9 }],
      ai: stubAi({ gen: async () => null }),
    })
    const out = await thinkOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })
    expect(out.evidence.map((e) => e.id)).toContain("chunk-1")
    expect(out.warnings).toContain("llm_unavailable")
  })
})

describe("search handler leaves expansion OFF by default", () => {
  test("no expansion gen() call on the cheap search path", async () => {
    const p = principal({ tenantId: "t1" })
    let genCalled = false
    const { deps } = seedOne(p, {
      matches: [{ id: "chunk-1", score: 0.9 }],
      ai: stubAi({
        gen: async () => {
          genCalled = true
          return "x"
        },
      }),
    })
    await searchOp.handler({ deps, principal: p }, { query: "kryptonite", topK: 12 })
    expect(genCalled).toBe(false)
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

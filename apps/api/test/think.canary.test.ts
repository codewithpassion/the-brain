import { env } from "cloudflare:test"
import {
  type AiPort,
  type BrainBindings,
  type RecallTraceBatch,
  ScopedDB,
  ScopedVectorize,
  type SearchDeps,
  thinkOp,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { seedChunk, seedDoc, seedMembership, seedOrg } from "./seed"

/**
 * THE Phase-2 security canary — the full `think` pipeline composed over REAL local D1 in
 * workerd, run as tenant A against an ADVERSARIAL vector arm (a fake Vectorize that surfaces
 * tenant B's chunk id) AND an FTS arm whose colliding "needle" term matches BOTH tenants.
 *
 * The single property under test (invariant 3, the leak trap): tenant A's returned evidence,
 * citations, the synthesis prompt, AND the recall traces reference ONLY tenant-A content —
 * tenant B's colliding chunk is NEVER cited, surfaced, or fed to the model, across the vector
 * arm, the FTS arm, and the synthesis context. Non-vacuous: the adversarial arms are shown to
 * actually emit B's id/content BEFORE the chokepoints drop it.
 *
 * B's content carries a UNIQUE marker (`bravoonlymarker`) absent from A, so "B did not leak"
 * is a real substring assertion over the prompt/evidence/citations/traces — not merely "the
 * ids differ" (A and B share the needle term by construction).
 */

const env_ = env as unknown as BrainBindings

const B_MARKER = "bravoonlymarker"
const CHUNK_A = "think-chunk-A"
const CHUNK_B = "think-chunk-B"

const principalA: Principal = {
  tenantId: "thinkA",
  userId: "ownerA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read"],
  readOnly: false,
}

/**
 * Adversarial fake Vectorize: returns BOTH chunk ids (incl. tenant B's) for ANY query. The
 * real `ScopedVectorize` wraps it (namespace is stamped but is NOT the security boundary —
 * invariant 3), so this models a hostile/buggy index leaking a cross-tenant id into the arm.
 */
const adversarialIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: CHUNK_B, score: 0.95 }, // B ranked FIRST — strongest possible leak pressure
      { id: CHUNK_A, score: 0.91 },
    ],
  }),
} as unknown as Vectorize

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

beforeAll(async () => {
  await seedOrg("thinkA", "think-a")
  await seedMembership({ tenantId: "thinkA", userId: "ownerA" })
  await seedDoc({ id: "think-doc-A", tenantId: "thinkA", slug: "needle-doc-a" })
  await seedChunk({
    id: CHUNK_A,
    tenantId: "thinkA",
    documentId: "think-doc-A",
    content: "the needle is here in alpha territory",
  })

  await seedOrg("thinkB", "think-b")
  await seedMembership({ tenantId: "thinkB", userId: "ownerB" })
  await seedDoc({ id: "think-doc-B", tenantId: "thinkB", slug: "needle-doc-b" })
  await seedChunk({
    id: CHUNK_B,
    tenantId: "thinkB",
    documentId: "think-doc-B",
    content: `the needle is here but only in ${B_MARKER} content`,
  })
})

describe("think pipeline isolation canary (invariant 3) — real local D1 in workerd", () => {
  test("tenant A's think NEVER surfaces tenant B across vector, FTS, synthesis, and recall", async () => {
    const sdb = new ScopedDB(drizzle(env_.DB), principalA)
    const vectors = new ScopedVectorize(adversarialIndex, principalA)

    // ── Non-vacuity 1: the vector arm REALLY emits B's id (B ranked first). ──────────
    const rawMatches = await vectors.query({ values: vec1024(), topK: 10 })
    expect(rawMatches.map((m) => m.id)).toContain(CHUNK_B)
    expect(rawMatches[0]?.id).toBe(CHUNK_B)

    // ── Non-vacuity 2: the colliding term REALLY matches B in B's own tenant. ────────
    const sdbB = new ScopedDB(drizzle(env_.DB), { ...principalA, tenantId: "thinkB" })
    expect(await sdbB.ftsChunkIds("needle", 10)).toContain(CHUNK_B)
    // …but tenant A's FTS arm JOIN-scopes B out, surfacing only A.
    expect(await sdb.ftsChunkIds("needle", 10)).toEqual([CHUNK_A])

    // ── Run the FULL think pipeline as tenant A with deterministic seams. ────────────
    let capturedPrompt = ""
    const ai: AiPort = {
      embed: async () => [vec1024()],
      gen: async (prompt) => {
        capturedPrompt = prompt
        return "Synthesis grounded in the provided evidence."
      },
      rerank: async (_q, candidates, topK) =>
        candidates.map((_c, index) => ({ index, score: 0 })).slice(0, topK),
    }
    const traces: RecallTraceBatch[] = []
    const deps: SearchDeps = {
      db: sdb,
      vectors,
      ai,
      budget: { check: async () => {} },
      recall: {
        append: async (b) => {
          traces.push(b)
        },
      },
    }

    const out = await thinkOp.handler(
      { deps, principal: principalA },
      { query: "needle", topK: 12 },
    )

    // Synthesis ran over tenant-A evidence.
    expect(out.answer.length).toBeGreaterThan(0)

    // Evidence + citations reference ONLY tenant-A content.
    expect(out.evidence.map((e) => e.id)).toEqual([CHUNK_A])
    expect(out.evidence.every((e) => e.id !== CHUNK_B)).toBe(true)
    expect(out.citations).toEqual([{ slug: "needle-doc-a", chunkId: CHUNK_A }])
    expect(out.citations.every((c) => c.slug !== "needle-doc-b")).toBe(true)

    // B's unique marker leaked NOWHERE: not evidence, not citations, not the synthesis prompt.
    const evidenceText = JSON.stringify(out.evidence)
    expect(evidenceText).not.toContain(B_MARKER)
    expect(capturedPrompt).not.toContain(B_MARKER)
    expect(capturedPrompt).not.toContain(CHUNK_B)

    // Recall traces are keyed by hydrated ids — tenant-A only, B never recorded.
    expect(traces).toHaveLength(1)
    expect(traces[0]?.hits.map((h) => h.chunkId)).toEqual([CHUNK_A])
  })
})

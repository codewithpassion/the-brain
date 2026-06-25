import { env } from "cloudflare:test"
import { remapRerank } from "@brain/db"
import { RERANK_MODEL } from "@brain/shared"
import { describe, expect, test } from "vitest"

/**
 * Reranker live-shape STAGING GATE (invariant 20, PRD §5.4 / top risk "Reranker output shape").
 *
 * The bge-reranker-base output shape is NOT pinned by the rendered CF docs. `remapRerank`
 * ASSUMES `{ response: Array<{ id, score }> }` where `id` is the 0-based index into the input
 * `contexts`. A silently-wrong remap mis-attributes citations (a correctness bug). So the live
 * shape must be locked against the real model BEFORE the remap is trusted in prod; until green,
 * prod degrades to RRF order (invariant 14).
 *
 * HONESTY: this gate is SKIPPED by default and shows as a VISIBLE skip in normal CI — the team
 * can see the live shape is not yet locked. It opts in ONLY when `RUN_AI_GATES=1`, and is
 * MEANINGFUL ONLY where `env.AI` is actually bound — i.e. a DEPLOYED / remote run. Workers AI
 * has no local miniflare emulation (see wrangler.jsonc: AI is a deploy-only binding), so this
 * gate deliberately does NOT call real AI in the default local harness.
 */

const RUN_AI_GATES = (env as unknown as { RUN_AI_GATES?: string }).RUN_AI_GATES === "1"

interface LiveAiBinding {
  run: (model: string, input: unknown) => Promise<unknown>
}

describe.skipIf(!RUN_AI_GATES)(
  "reranker live-shape gate (RUN_AI_GATES=1, AI must be bound)",
  () => {
    test("bge-reranker-base returns {response:[{id,score}]} and remapRerank maps index→chunk", async () => {
      const ai = (env as unknown as { AI?: LiveAiBinding }).AI
      if (!ai) {
        throw new Error(
          "RUN_AI_GATES=1 but env.AI is unbound — run this gate where Workers AI is bound (deployed/remote), not the local harness",
        )
      }

      // Two clearly-distinct candidates; the query is unambiguously about the SECOND one.
      const candidates = [
        { text: "Bananas are a yellow tropical fruit rich in potassium." },
        { text: "The mandatory D1 re-check drops cross-tenant ids after every vector hit." },
      ]
      const query = "How does tenant isolation work in the search re-check?"

      const res = (await ai.run(RERANK_MODEL, {
        query,
        contexts: candidates.map((c) => ({ text: c.text })),
        top_k: candidates.length,
      })) as { response?: unknown }

      // 1. The assumed envelope shape holds.
      expect(Array.isArray(res.response)).toBe(true)
      const response = res.response as { id?: unknown; score?: unknown }[]
      expect(response.length).toBeGreaterThan(0)
      for (const row of response) {
        expect(typeof row.id).toBe("number")
        expect(typeof row.score).toBe("number")
      }

      // 2. remapRerank accepts the live output and maps to valid candidate indices.
      const hits = remapRerank(
        candidates.length,
        res as { response?: { id?: number; score?: number }[] },
      )
      expect(hits).not.toBeNull()
      for (const hit of hits ?? []) {
        expect(hit.index).toBeGreaterThanOrEqual(0)
        expect(hit.index).toBeLessThan(candidates.length)
      }

      // 3. The top-ranked candidate is the relevant one (index 1) — proves index→chunk fidelity.
      expect(hits?.[0]?.index).toBe(1)
    })
  },
)

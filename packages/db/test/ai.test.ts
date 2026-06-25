import { describe, expect, test } from "bun:test"
import { embed, embedForIndex } from "../src/ai/embed"
import type { AiDeps } from "../src/ai/gateway"
import { remapRerank, rerank } from "../src/ai/rerank"

/** Build `AiDeps` around a fake `run` implementation. */
const deps = (run: AiDeps["ai"]["run"]): AiDeps => ({
  ai: { run },
  gatewayId: "gw",
  tenantId: "t1",
})

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

describe("embed() (invariants 12, 14)", () => {
  test("READ path returns vectors on a valid 1024-dim response", async () => {
    const d = deps(() => Promise.resolve({ data: [vec1024()] }))
    const out = await embed(d, ["hello"])
    expect(out).not.toBeNull()
    expect(out?.[0]).toHaveLength(1024)
  })

  test("READ path returns null when the binding throws (degrade to keyword-only)", async () => {
    const d = deps(() => Promise.reject(new Error("AI down")))
    expect(await embed(d, ["hello"])).toBeNull()
  })

  test("READ path REFUSES a wrong-dimension vector (returns null, invariant 12)", async () => {
    const d = deps(() => Promise.resolve({ data: [[1, 2, 3]] }))
    expect(await embed(d, ["hello"])).toBeNull()
  })

  test("WRITE path THROWS on failure / wrong dim (triggers Workflow retry, invariant 14)", async () => {
    const down = deps(() => Promise.reject(new Error("AI down")))
    await expect(embedForIndex(down, ["hello"])).rejects.toThrow()

    const wrongDim = deps(() => Promise.resolve({ data: [[1, 2, 3]] }))
    await expect(embedForIndex(wrongDim, ["hello"])).rejects.toThrow()
  })

  test("WRITE path returns vectors on a valid 1024-dim response", async () => {
    const d = deps(() => Promise.resolve({ data: [vec1024()] }))
    expect(await embedForIndex(d, ["hello"])).toHaveLength(1)
  })
})

describe("rerank() + remapRerank (invariants 14, 20)", () => {
  test("remaps candidates by the model's index order", async () => {
    const d = deps(() =>
      Promise.resolve({
        response: [
          { id: 1, score: 0.9 },
          { id: 0, score: 0.8 },
        ],
      }),
    )
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }], 2)
    expect(hits).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.8 },
    ])
  })

  test("degrades to identity (RRF) order on malformed output — never throws", async () => {
    const d = deps(() => Promise.resolve({ garbage: true }))
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }], 2)
    expect(hits).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 },
    ])
  })

  test("degrades to identity order when the binding throws", async () => {
    const d = deps(() => Promise.reject(new Error("AI down")))
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }, { text: "c" }], 2)
    expect(hits).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 },
    ])
  })

  test("remapRerank drops rows whose id is out of range", () => {
    const remapped = remapRerank(2, {
      response: [
        { id: 5, score: 0.9 }, // out of range → dropped
        { id: 0, score: 0.8 },
      ],
    })
    expect(remapped).toEqual([{ index: 0, score: 0.8 }])
  })
})

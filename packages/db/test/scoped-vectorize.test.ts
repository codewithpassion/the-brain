import { describe, expect, test } from "bun:test"
import { ScopedVectorize } from "../src/scoped/vectorize"
import { principal } from "./helpers"

interface QueryCall {
  values: number[]
  options: {
    topK?: number
    namespace?: string
    filter?: unknown
    returnValues?: boolean
    returnMetadata?: unknown
  }
}
interface UpsertCall {
  id: string
  namespace?: string
  metadata?: Record<string, unknown>
}

/** A fake Vectorize V2 binding that records every call. */
const fakeIndex = () => {
  const queries: QueryCall[] = []
  const upserts: UpsertCall[] = []
  const index = {
    query(values: number[], options: QueryCall["options"]) {
      queries.push({ values, options })
      return Promise.resolve({
        matches: [
          { id: "v1", score: 0.9 },
          { id: "v2", score: 0.7 },
        ],
        count: 2,
      })
    },
    upsert(vectors: UpsertCall[]) {
      upserts.push(...vectors)
      return Promise.resolve({ mutationId: "m1" })
    },
  }
  return { index, queries, upserts }
}

describe("ScopedVectorize (invariants 1, 3)", () => {
  test("query stamps namespace=tenantId and caps topK at 100; returns {id,score} only", async () => {
    const { index, queries } = fakeIndex()
    const sv = new ScopedVectorize(
      index as unknown as Vectorize,
      principal({ tenantId: "tenant-7" }),
    )

    const out = await sv.query({ values: [0.1, 0.2], topK: 500 })
    expect(queries[0]?.options.namespace).toBe("tenant-7")
    expect(queries[0]?.options.topK).toBe(100)
    expect(queries[0]?.options.returnValues).toBe(false)
    expect(out).toEqual([
      { id: "v1", score: 0.9 },
      { id: "v2", score: 0.7 },
    ])
  })

  test("a query can never be issued without a namespace", async () => {
    const { index, queries } = fakeIndex()
    const sv = new ScopedVectorize(
      index as unknown as Vectorize,
      principal({ tenantId: "tenant-9" }),
    )
    await sv.query({ values: [0], topK: 10 })
    expect(queries.every((q) => q.options.namespace === "tenant-9")).toBe(true)
  })

  test("foldPartitionFilter folds a restricted grant into {scope:{$in}}; '*' passes through", () => {
    const { index } = fakeIndex()
    const restricted = new ScopedVectorize(
      index as unknown as Vectorize,
      principal({ allowedScopes: ["a", "b"] }),
    )
    expect(restricted.foldPartitionFilter()).toEqual({ scope: { $in: ["a", "b"] } })

    const wildcard = new ScopedVectorize(
      index as unknown as Vectorize,
      principal({ allowedScopes: "*" }),
    )
    expect(wildcard.foldPartitionFilter({ team_id: "teamX" })).toEqual({ team_id: "teamX" })
  })

  test("an explicit out-of-grant scope filter is rejected", async () => {
    const { index } = fakeIndex()
    const sv = new ScopedVectorize(
      index as unknown as Vectorize,
      principal({ allowedScopes: ["clientA"] }),
    )
    await expect(sv.query({ values: [0], topK: 5, filter: { scope: "clientB" } })).rejects.toThrow()
    // a folded filter self-derived from the grant passes.
    await expect(
      sv.query({ values: [0], topK: 5, filter: { scope: { $in: ["clientA"] } } }),
    ).resolves.toBeDefined()
  })

  test("upsert hard-wires namespace=tenantId and carries embedding_model metadata", async () => {
    const { index, upserts } = fakeIndex()
    const sv = new ScopedVectorize(
      index as unknown as Vectorize,
      principal({ tenantId: "tenant-3" }),
    )
    await sv.upsert({
      id: "chunk-1",
      values: [0.1],
      scope: "clientA",
      teamId: null,
      visibility: "world",
      embeddingModel: "@cf/baai/bge-m3",
    })
    expect(upserts[0]?.namespace).toBe("tenant-3")
    expect(upserts[0]?.metadata?.tenant_id).toBe("tenant-3")
    expect(upserts[0]?.metadata?.embedding_model).toBe("@cf/baai/bge-m3")
    expect(upserts[0]?.metadata?.scope).toBe("clientA")
    // null team_id is omitted, not stamped.
    expect(upserts[0]?.metadata && "team_id" in upserts[0].metadata).toBe(false)
  })
})

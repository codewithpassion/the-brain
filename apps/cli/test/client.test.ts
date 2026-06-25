import { describe, expect, test } from "bun:test"
import { createBrainClient } from "../src/client"

interface Capture {
  url: string
  method: string
  headers: Headers
}

/** A mock fetch that records each request and returns a tRPC-batch-shaped success envelope. */
const recordingFetch = (
  captures: Capture[],
  data: unknown = { ok: true },
  statuses: number[] = [],
): typeof fetch => {
  let call = 0
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    captures.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase(), headers })
    const status = statuses[call++] ?? 200
    if (status === 401) return new Response("unauthorized", { status: 401 })
    return new Response(JSON.stringify([{ result: { data } }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

describe("tRPC client request shape", () => {
  test("a read op is a GET to /trpc/<op> with Bearer + X-Brain-Tenant headers", async () => {
    const captures: Capture[] = []
    const client = createBrainClient({
      apiUrl: "https://api.test/",
      token: "bk_token_1234",
      tenant: "org_x",
      fetchImpl: recordingFetch(captures, { echo: true }),
    })
    const out = await client.call("search", true, { query: "hi", topK: 5 })
    expect(out).toEqual({ echo: true })
    const capture = captures[0]
    expect(capture).toBeDefined()
    expect(capture?.url).toContain("/trpc/search")
    expect(capture?.method).toBe("GET")
    expect(capture?.headers.get("authorization")).toBe("Bearer bk_token_1234")
    expect(capture?.headers.get("x-brain-tenant")).toBe("org_x")
  })

  test("a write op is a POST", async () => {
    const captures: Capture[] = []
    const client = createBrainClient({
      apiUrl: "https://api.test",
      token: "bk_token_1234",
      fetchImpl: recordingFetch(captures),
    })
    await client.call("capture_turn", false, {
      sessionId: "s1",
      role: "user",
      content: "hi",
      client: "cli",
    })
    expect(captures[0]?.method).toBe("POST")
    expect(captures[0]?.url).toContain("/trpc/capture_turn")
  })

  test("on a 401, the bearer is refreshed once and the request retried", async () => {
    const captures: Capture[] = []
    let refreshed = 0
    const client = createBrainClient({
      apiUrl: "https://api.test",
      token: "bk_stale_0000",
      tenant: "org_x",
      fetchImpl: recordingFetch(captures, { ok: true }, [401, 200]),
      refresh: async () => {
        refreshed += 1
        return "bk_fresh_9999"
      },
    })
    await client.call("search", true, { query: "hi", topK: 5 })
    expect(refreshed).toBe(1)
    expect(captures).toHaveLength(2)
    expect(captures[0]?.headers.get("authorization")).toBe("Bearer bk_stale_0000")
    expect(captures[1]?.headers.get("authorization")).toBe("Bearer bk_fresh_9999")
  })
})

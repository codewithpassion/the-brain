import { afterEach, describe, expect, test } from "vitest"
import { beat, withBeat } from "./beat"

const realFetch = globalThis.fetch
const env = { HB_TOKEN: "t", HB_URL: "https://hb.example/" }

function makeCtx() {
  const pending: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    settle: () => Promise.all(pending),
  }
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { init: RequestInit; url: string }[] = []
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ init, url })
    return impl(url, init)
  }) as unknown as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("beat", () => {
  test("posts to /hb/:id/:phase with a bearer token", async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))
    const { ctx, settle } = makeCtx()
    beat(env, ctx, "my-job", "start")
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://hb.example/hb/my-job/start")
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer t")
  })

  test("uses the HB_SERVICE binding instead of global fetch when present", async () => {
    const globalCalls = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))
    const requests: Request[] = []
    const HB_SERVICE = {
      fetch: (request: Request) => {
        requests.push(request)
        return Promise.resolve(new Response(null, { status: 202 }))
      },
    }
    const { ctx, settle } = makeCtx()
    beat({ ...env, HB_SERVICE }, ctx, "my-job", "success")
    await settle()
    expect(globalCalls).toHaveLength(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://hb.example/hb/my-job/success")
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer t")
  })

  test("is off without HB_URL or HB_TOKEN", async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))
    const { ctx, settle } = makeCtx()
    beat({ HB_URL: "https://hb.example" }, ctx, "my-job", "start")
    beat({ HB_TOKEN: "t" }, ctx, "my-job", "start")
    await settle()
    expect(calls).toHaveLength(0)
  })

  test("never throws when fetch rejects or waitUntil throws", async () => {
    stubFetch(() => Promise.reject(new Error("boom")))
    const { ctx, settle } = makeCtx()
    beat(env, ctx, "my-job", "fail", "x")
    await settle()
    expect(() =>
      beat(
        env,
        {
          waitUntil: () => {
            throw new Error("closed")
          },
        },
        "my-job",
        "start",
      ),
    ).not.toThrow()
  })
})

describe("withBeat", () => {
  test("sends start then success and returns the result", async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))
    const { ctx, settle } = makeCtx()
    expect(await withBeat(env, ctx, "my-job", () => Promise.resolve(7))).toBe(7)
    await settle()
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["start", "success"])
  })

  test("sends fail and rethrows the original error", async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))
    const { ctx, settle } = makeCtx()
    const failure = new TypeError("bad")
    await expect(withBeat(env, ctx, "my-job", () => Promise.reject(failure))).rejects.toBe(failure)
    await settle()
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["start", "fail"])
  })
})

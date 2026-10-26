import { env } from "cloudflare:test"
import { afterEach, describe, expect, test, vi } from "vitest"
import worker from "../src/index"

// Wiring check: the cron handler sends control-plane beats around its work.
// The sweeps run against the empty miniflare D1, so they finish without side effects.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

async function runCron(cron: string, extra: Record<string, string>) {
  const urls: string[] = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    return Promise.resolve(new Response("ok"))
  }) as unknown as typeof fetch
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
  const run = worker.scheduled as unknown as (
    c: { cron: string },
    e: unknown,
    x: ExecutionContext,
  ) => Promise<void>
  await run({ cron }, { ...env, ...extra }, ctx)
  await Promise.allSettled(pending)
  return urls.filter((u) => u.includes("/hb/"))
}

const hb = { HB_URL: "https://hb.example", HB_TOKEN: "t" }

describe("cron heartbeats", () => {
  test("nightly dream sends start and a closing beat", async () => {
    const urls = await runCron("0 3 * * *", hb)
    expect(urls[0]).toBe("https://hb.example/hb/brain-dream-nightly/start")
    expect(urls[1]).toMatch(/\/hb\/brain-dream-nightly\/(success|fail)$/)
  })

  test("5 minute sweep sends start and a closing beat", async () => {
    const urls = await runCron("*/5 * * * *", hb)
    expect(urls[0]).toBe("https://hb.example/hb/brain-sweep/start")
    expect(urls[1]).toMatch(/\/hb\/brain-sweep\/(success|fail)$/)
  })

  test("no beats without HB_URL and HB_TOKEN", async () => {
    expect(await runCron("*/5 * * * *", { HB_URL: "", HB_TOKEN: "" })).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { ScopedR2 } from "../src/scoped/r2"
import { principal } from "./helpers"

interface PutCall {
  key: string
}
interface ListCall {
  prefix?: string
}

const fakeBucket = () => {
  const puts: PutCall[] = []
  const gets: string[] = []
  const lists: ListCall[] = []
  const bucket = {
    put(key: string) {
      puts.push({ key })
      return Promise.resolve(null)
    },
    get(key: string) {
      gets.push(key)
      return Promise.resolve(null)
    },
    head() {
      return Promise.resolve(null)
    },
    delete() {
      return Promise.resolve()
    },
    list(options: ListCall) {
      lists.push(options)
      return Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] })
    },
  }
  return { bucket, puts, gets, lists }
}

describe("ScopedR2 (invariant 1)", () => {
  test("every key is prefixed with the tenant id", async () => {
    const { bucket, puts, gets } = fakeBucket()
    const r2 = new ScopedR2(bucket as unknown as R2Bucket, principal({ tenantId: "tenant-5" }))
    await r2.put("docs/doc-1", "body")
    await r2.get("docs/doc-1")
    expect(puts[0]?.key).toBe("tenant-5/docs/doc-1")
    expect(gets[0]).toBe("tenant-5/docs/doc-1")
  })

  test("list is pinned to the tenant prefix", async () => {
    const { bucket, lists } = fakeBucket()
    const r2 = new ScopedR2(bucket as unknown as R2Bucket, principal({ tenantId: "tenant-5" }))
    await r2.list({ prefix: "sessions/" })
    expect(lists[0]?.prefix).toBe("tenant-5/sessions/")
  })

  test("an absolute (leading-slash) key is rejected — no namespace escape", () => {
    const { bucket } = fakeBucket()
    const r2 = new ScopedR2(bucket as unknown as R2Bucket, principal({ tenantId: "tenant-5" }))
    expect(() => r2.get("/etc/secret")).toThrow()
    expect(() => r2.get("")).toThrow()
  })
})

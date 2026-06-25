import { describe, expect, test } from "bun:test"
import { dedupGate } from "../src/dedup"
import { fingerprint } from "../src/fingerprint"

describe("dedupGate", () => {
  test("returns the (tenantId, scope, fingerprint) key tuple", async () => {
    const key = await dedupGate({ tenantId: "t1", scope: "proj-a", content: "# Doc\n\nbody" })
    expect(key.tenantId).toBe("t1")
    expect(key.scope).toBe("proj-a")
    expect(key.fingerprint).toBe(await fingerprint("# Doc\n\nbody"))
  })

  test("defaults scope to null when absent (matches the nullable UNIQUE index column)", async () => {
    const key = await dedupGate({ tenantId: "t1", content: "x" })
    expect(key.scope).toBeNull()
  })

  test("the fingerprint is formatting-insensitive (re-capture with whitespace drift dedups)", async () => {
    const a = await dedupGate({ tenantId: "t1", content: "Hello World" })
    const b = await dedupGate({ tenantId: "t1", content: "  hello   world  " })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  test("different tenants with identical content share a fingerprint but differ in key", async () => {
    const a = await dedupGate({ tenantId: "t1", content: "same" })
    const b = await dedupGate({ tenantId: "t2", content: "same" })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.tenantId).not.toBe(b.tenantId)
  })
})

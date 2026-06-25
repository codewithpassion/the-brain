import { describe, expect, test } from "bun:test"
import { tenantPinFor } from "../src/server/tenant"

describe("tenantPinFor (invariant 17)", () => {
  test("derives the org id deterministically from the Clerk subject", () => {
    expect(tenantPinFor("user_abc123")).toBe("org_user_abc123")
  })

  test("is a pure function of the userId (same in → same out)", () => {
    expect(tenantPinFor("u1")).toBe(tenantPinFor("u1"))
    expect(tenantPinFor("u1")).not.toBe(tenantPinFor("u2"))
  })
})

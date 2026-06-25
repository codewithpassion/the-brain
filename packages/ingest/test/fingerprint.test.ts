import { describe, expect, test } from "bun:test"
import { fingerprint, normalizeForFingerprint } from "../src/fingerprint"

describe("normalizeForFingerprint", () => {
  test("collapses whitespace, trims, lowercases", () => {
    expect(normalizeForFingerprint("  Hello   World\n\tFoo  ")).toBe("hello world foo")
  })

  test("is idempotent", () => {
    const once = normalizeForFingerprint("# Hello\n\n  World ")
    expect(normalizeForFingerprint(once)).toBe(once)
  })
})

describe("fingerprint", () => {
  test("is a 64-char lowercase hex SHA-256 digest", async () => {
    const fp = await fingerprint("hello world")
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })

  test("is deterministic — identical content yields identical fingerprint", async () => {
    const a = await fingerprint("# Title\n\nSome body text.")
    const b = await fingerprint("# Title\n\nSome body text.")
    expect(a).toBe(b)
  })

  test("is sensitive — different content yields different fingerprint", async () => {
    const a = await fingerprint("# Title\n\nSome body text.")
    const b = await fingerprint("# Title\n\nDifferent body text.")
    expect(a).not.toBe(b)
  })

  test("is formatting-INSENSITIVE — whitespace/case drift still dedups (§4.0/§4.2)", async () => {
    const a = await fingerprint("# Hello World")
    const b = await fingerprint("#  hello   world\n  ")
    expect(a).toBe(b)
  })

  test("matches a known SHA-256 vector for the normalized input", async () => {
    // sha256("hello world") — input already normalizeForFingerprint-stable.
    const fp = await fingerprint("hello world")
    expect(fp).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
  })
})

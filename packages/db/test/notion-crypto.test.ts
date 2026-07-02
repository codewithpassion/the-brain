import { describe, expect, test } from "bun:test"
import { decryptToken, encryptToken } from "../src/notion/crypto"

/**
 * AES-GCM token-crypto unit gate (Phase 8, Notion). The stored Notion bot token must be
 * REVERSIBLY encrypted (unlike the vault credential's one-way SHA-256), so this proves the
 * round-trip, that a fresh IV makes each ciphertext unique, and that a wrong key / tampered
 * blob fails closed (AES-GCM authentication) rather than returning garbage plaintext.
 */
describe("notion token crypto (AES-GCM)", () => {
  const KEY = "test-notion-enc-key-value"
  const SECRET = "secret_notion_bot_token_ntn_abc123"

  test("encrypt → decrypt round-trips the plaintext", async () => {
    const blob = await encryptToken(KEY, SECRET)
    expect(blob).not.toContain(SECRET) // ciphertext never leaks the plaintext
    expect(await decryptToken(KEY, blob)).toBe(SECRET)
  })

  test("each encryption uses a fresh IV (ciphertexts differ, both decrypt)", async () => {
    const a = await encryptToken(KEY, SECRET)
    const b = await encryptToken(KEY, SECRET)
    expect(a).not.toBe(b)
    expect(await decryptToken(KEY, a)).toBe(SECRET)
    expect(await decryptToken(KEY, b)).toBe(SECRET)
  })

  test("a wrong key fails closed (throws, never returns garbage)", async () => {
    const blob = await encryptToken(KEY, SECRET)
    await expect(decryptToken("a-different-key", blob)).rejects.toThrow()
  })

  test("a tampered ciphertext fails closed", async () => {
    const blob = await encryptToken(KEY, SECRET)
    // Flip a byte deep in the ciphertext region (past the 12-byte IV in the base64 payload).
    const flipped = `${blob.slice(0, -4)}${blob.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`
    await expect(decryptToken(KEY, flipped)).rejects.toThrow()
  })
})

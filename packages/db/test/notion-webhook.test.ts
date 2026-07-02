import { describe, expect, test } from "bun:test"
import {
  notionHandshakeToken,
  parseNotionEvent,
  verifyNotionSignature,
} from "../src/notion/webhook"

/**
 * Notion webhook signature + event-parse gate. The signature MUST be verified (constant-time, over
 * the raw body) before any tenant work — a forged/tampered event fails closed.
 */

const encoder = new TextEncoder()

/** Compute a valid `sha256=<hex>` header the same way Notion signs (for the positive case). */
const signHeader = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")
  return `sha256=${hex}`
}

const SECRET = "verification-token-abc"
const BODY = JSON.stringify({
  type: "page.content_updated",
  entity: { id: "pg1" },
  workspace_id: "ws1",
})

describe("verifyNotionSignature", () => {
  test("accepts a correctly-signed body", async () => {
    const header = await signHeader(SECRET, BODY)
    expect(await verifyNotionSignature(SECRET, BODY, header)).toBe(true)
  })

  test("rejects a wrong secret", async () => {
    const header = await signHeader("other-secret", BODY)
    expect(await verifyNotionSignature(SECRET, BODY, header)).toBe(false)
  })

  test("rejects a tampered body", async () => {
    const header = await signHeader(SECRET, BODY)
    expect(await verifyNotionSignature(SECRET, `${BODY} `, header)).toBe(false)
  })

  test("rejects a missing header", async () => {
    expect(await verifyNotionSignature(SECRET, BODY, null)).toBe(false)
  })

  test("fails closed on a malformed header (no prefix / bad hex), never throws", async () => {
    expect(await verifyNotionSignature(SECRET, BODY, "deadbeef")).toBe(false) // no sha256= prefix
    expect(await verifyNotionSignature(SECRET, BODY, "sha256=")).toBe(false) // empty hex
    expect(await verifyNotionSignature(SECRET, BODY, "sha256=abc")).toBe(false) // odd length
    expect(await verifyNotionSignature(SECRET, BODY, "sha256=zzzz")).toBe(false) // non-hex
  })
})

describe("event parsing", () => {
  test("detects the one-time handshake token", () => {
    expect(notionHandshakeToken({ verification_token: "vt" })).toBe("vt")
    expect(notionHandshakeToken({ type: "page.created" })).toBeNull()
  })

  test("maps page events to upsert/delete actions", () => {
    expect(
      parseNotionEvent({ type: "page.created", entity: { id: "p" }, workspace_id: "w" }),
    ).toEqual({
      workspaceId: "w",
      pageId: "p",
      action: "upsert",
    })
    expect(
      parseNotionEvent({ type: "page.content_updated", entity: { id: "p" }, workspace_id: "w" }),
    ).toEqual({ workspaceId: "w", pageId: "p", action: "upsert" })
    expect(
      parseNotionEvent({ type: "page.deleted", entity: { id: "p" }, workspace_id: "w" }),
    ).toEqual({
      workspaceId: "w",
      pageId: "p",
      action: "delete",
    })
    // Restore-from-trash re-ingests (resurrects the soft-deleted doc via the upsert path).
    expect(
      parseNotionEvent({ type: "page.undeleted", entity: { id: "p" }, workspace_id: "w" }),
    ).toEqual({ workspaceId: "w", pageId: "p", action: "upsert" })
  })

  test("ignores non-page events and events missing ids", () => {
    expect(
      parseNotionEvent({ type: "comment.created", entity: { id: "c" }, workspace_id: "w" }),
    ).toBeNull()
    expect(parseNotionEvent({ type: "page.created", workspace_id: "w" })).toBeNull()
    expect(parseNotionEvent({ type: "page.created", entity: { id: "p" } })).toBeNull()
  })
})

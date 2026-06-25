import { describe, expect, test } from "vitest"
import { buildRegistry, createApp } from "../src/index"

/**
 * Integration smoke: proves the single Worker WIRES every phase's surface together —
 *   - the op registry carries all four phases' op contracts (search + graph + session +
 *     governance) with no duplicate-name collision (the registry throws on dup, so a clean
 *     `buildRegistry()` is itself the assertion);
 *   - `/health` is reachable WITHOUT auth (the edge middleware skips it).
 * It does NOT re-test any phase's logic — that is each phase's own canary.
 */

const EXPECTED_OPS = [
  // search (P2)
  "search",
  "query",
  "think",
  // graph (P4)
  "traverse_graph",
  "get_links",
  "get_backlinks",
  "get_tags",
  "get_timeline",
  "list_entities",
  "find_orphans",
  "search_entities",
  // sessions (P5)
  "capture_turn",
  "finalize_session",
  "get_session_context",
  "recall",
  "forget_fact",
  // governance (P5)
  "memory_review",
  "break_glass_read",
  "audit_export",
  // admin (P6)
  "mint_api_key",
  "get_token_spend",
  "memberships",
] as const

describe("apps/api integration smoke", () => {
  test("the worker registry exposes every phase's surface op (no dup collision)", () => {
    const names = new Set(
      buildRegistry()
        .list()
        .map((op) => op.name),
    )
    for (const op of EXPECTED_OPS) expect(names.has(op)).toBe(true)
  })

  test("/health is reachable without auth", async () => {
    const res = await createApp().request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

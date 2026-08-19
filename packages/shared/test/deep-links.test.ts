import { describe, expect, test } from "bun:test"
import { brainDeepLinks, entityPageSlug } from "../src/index"

/**
 * `brainDeepLinks` — pure dashboard-URL builders. The two properties that matter: (1) base
 * normalization (trailing slashes stripped, no double-slash) and (2) an empty/undefined base
 * disables every builder (returns undefined) so a decorated output stays byte-identical to an
 * undecorated one in local dev.
 */
describe("brainDeepLinks", () => {
  test("undefined base → every builder returns undefined", () => {
    const l = brainDeepLinks(undefined)
    expect(l.wikiPage("a")).toBeUndefined()
    expect(l.wikiHeading("a", "intro")).toBeUndefined()
    expect(l.document("d")).toBeUndefined()
    expect(l.memory("m")).toBeUndefined()
    expect(l.session("s")).toBeUndefined()
    expect(l.entity("person", "Ada")).toBeUndefined()
  })

  test("empty-string base → undefined (local dev without DASHBOARD_URL)", () => {
    expect(brainDeepLinks("").document("d")).toBeUndefined()
  })

  test("builds the frontend routes from a normalized base", () => {
    const l = brainDeepLinks("https://brain.example.dev")
    expect(l.wikiPage("guides/intro")).toBe("https://brain.example.dev/wiki/guides/intro")
    expect(l.wikiHeading("guides/intro", "setup-steps-1")).toBe(
      "https://brain.example.dev/wiki/guides/intro#setup-steps-1",
    )
    expect(l.document("doc-123")).toBe("https://brain.example.dev/documents/doc-123")
    expect(l.memory("agent/planner/prefs")).toBe(
      "https://brain.example.dev/memory/agent/planner/prefs",
    )
    expect(l.session("sess-9")).toBe("https://brain.example.dev/sessions/sess-9")
  })

  test("strips one or more trailing slashes from the base (no double slash)", () => {
    expect(brainDeepLinks("https://x.dev/").document("d")).toBe("https://x.dev/documents/d")
    expect(brainDeepLinks("https://x.dev///").document("d")).toBe("https://x.dev/documents/d")
  })

  test("entity() routes through entityPageSlug (kind/name → canonical page slug)", () => {
    const l = brainDeepLinks("https://x.dev")
    expect(l.entity("person", "Ada Lovelace")).toBe(
      `https://x.dev/wiki/${entityPageSlug("person", "Ada Lovelace")}`,
    )
    // Concretely, that is the entities/<kind>/<slug> lane the dashboard splat route serves.
    expect(l.entity("person", "Ada Lovelace")).toBe(
      "https://x.dev/wiki/entities/person/ada-lovelace",
    )
  })
})

import { describe, expect, test } from "bun:test"
import { WIKILINK_SLUG_FIXTURES } from "@brain/shared"
import { normalizeLinkTarget } from "../src/pages/store"

/**
 * Pins `@brain/db`'s `normalizeLinkTarget` to the SHARED golden fixtures. The dashboard's client
 * PORT asserts the SAME fixtures — so a change here forces updating the fixtures, which then fails
 * the dashboard test until its port is synced (W4a fix round, item 4: no silent normalizer drift).
 */
describe("normalizeLinkTarget ↔ shared golden fixtures (store side)", () => {
  for (const { input, slug } of WIKILINK_SLUG_FIXTURES) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(slug)}`, () => {
      expect(normalizeLinkTarget(input)).toBe(slug)
    })
  }
})

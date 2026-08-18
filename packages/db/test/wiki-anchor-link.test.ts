import { describe, expect, test } from "bun:test"
import { WikiStore } from "../src/wiki/store"
import { makeDb, principal, withBatch } from "./helpers"

/**
 * Store-parity for anchored wikilinks: the backend records the link/red-link on the BARE slug — the
 * `#heading` fragment is stripped by `normalizeLinkTarget` before resolution. So `[[a#b]]` in a wiki
 * body yields a `pending_links` row keyed on `a` (never `a#b`), matching what the client renderer
 * computes when it deep-links to the heading.
 */
describe("wiki savePage — anchored wikilink records on the bare slug", () => {
  test("[[a#b]] yields a pending (red) link targeting 'a', not 'a#b'", async () => {
    const { sqlite, db } = makeDb()
    const wiki = new WikiStore(withBatch(db), principal())

    await wiki.savePage({ slug: "src", type: "note", body: "see [[a#b]] here" })

    const rows = sqlite.query("SELECT target_slug FROM pending_links").all() as {
      target_slug: string
    }[]
    expect(rows.map((r) => r.target_slug)).toEqual(["a"])
  })
})

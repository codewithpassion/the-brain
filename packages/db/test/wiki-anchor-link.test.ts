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

/**
 * `wiki_get_page` hands back the AUTHORITATIVE heading ids so an MCP client rewriting `#anchor` deep
 * links never has to guess the slug rule (a wrong guess fails silently). These pin the two cases the
 * plan calls out as unguessable: a pipe/punctuation-laden heading, and the `-1` dedup suffix.
 */
describe("wiki getPage — headings carry the rehype-slug ids", () => {
  test("pipe/punctuation heading → the exact rendered id", async () => {
    const { db } = makeDb()
    const wiki = new WikiStore(withBatch(db), principal())

    const body = "## Tue 18 Aug | PM | D0 - THE META POST (launches the series)\n\nbody"
    await wiki.savePage({ slug: "launch", type: "note", body })

    const detail = await wiki.getPage("launch")
    expect(detail?.headings).toEqual([
      {
        level: 2,
        text: "Tue 18 Aug | PM | D0 - THE META POST (launches the series)",
        id: "tue-18-aug--pm--d0---the-meta-post-launches-the-series",
      },
    ])
  })

  test("duplicate headings dedup to setup-steps / setup-steps-1", async () => {
    const { db } = makeDb()
    const wiki = new WikiStore(withBatch(db), principal())

    await wiki.savePage({
      slug: "guides/dup",
      type: "note",
      body: "## Setup Steps\n\none\n\n## Setup Steps\n\ntwo",
    })

    const detail = await wiki.getPage("guides/dup")
    expect(detail?.headings.map((h) => h.id)).toEqual(["setup-steps", "setup-steps-1"])
  })

  test("a heading-free body yields headings: [] (never undefined)", async () => {
    const { db } = makeDb()
    const wiki = new WikiStore(withBatch(db), principal())

    await wiki.savePage({ slug: "plain", type: "note", body: "just prose, no headings" })

    const detail = await wiki.getPage("plain")
    expect(detail?.headings).toEqual([])
  })
})

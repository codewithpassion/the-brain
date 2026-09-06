import { describe, expect, test } from "bun:test"
import {
  applySpeakerMap,
  meetingSlugIn,
  speakerMapKey,
  speakerMapSlug,
  speakersBlock,
} from "../src/speakers"

const plaud = [
  "# Transcript: plaud-5d8448fd6c0453b2d982e55066e51364.mp3",
  "",
  "**Language**: en | **Duration**: 114:57 | **Diarization**: enabled",
  "",
  "---",
  "",
  "### [00:00]",
  "**Speaker 0**: hello",
  "**Speaker 1**: hi",
  "**Speaker 0**: bye",
].join("\n")

const speakers = {
  "Speaker 0": { name: "Zoe Smith", note: "majority owner, Acme" },
  "Speaker 1": { name: "Dominik Fretz" },
}

describe("speaker map helpers", () => {
  test("keys by the Plaud file id when the header carries one, else the document id", () => {
    expect(speakerMapKey(plaud, "doc-1")).toBe("plaud-5d8448fd6c0453b2d982e55066e51364")
    expect(speakerMapKey("# Something else\n**Speaker 0**: x", "doc-1")).toBe("doc-1")
    expect(speakerMapSlug("plaud-abc")).toBe("agent/meetings/speaker-map/plaud-abc")
  })

  test("finds the meeting wikilink in a resolved header", () => {
    expect(meetingSlugIn("See [[meetings/2026-09/2026-09-02-onboarding]].")).toBe(
      "meetings/2026-09/2026-09-02-onboarding",
    )
    expect(meetingSlugIn("See [[meetings/2026-09/x#heading|label]]")).toBe("meetings/2026-09/x")
    expect(meetingSlugIn("no link")).toBeNull()
  })

  test("renders the established table block", () => {
    const block = speakersBlock(speakers, "2026-09-07")
    expect(block).toContain("## Speakers")
    expect(block).toContain("| Speaker 0 | Zoe Smith - majority owner, Acme |")
    expect(block).toContain("| Speaker 1 | Dominik Fretz |")
  })

  test("relabels bold labels, inserts the block under the header line, reports skips", () => {
    const out = applySpeakerMap(
      plaud,
      { ...speakers, "Speaker 9": { name: "Nobody" } },
      "2026-09-07",
    )
    expect(out.results).toEqual([
      { find: "**Speaker 0**", count: 2 },
      { find: "**Speaker 1**", count: 1 },
    ])
    expect(out.skippedLabels).toEqual(["Speaker 9"])
    expect(out.blockInserted).toBe(true)
    expect(out.body).not.toContain("**Speaker 0**")
    expect(out.body).toContain("**Zoe Smith**: hello")
    expect(out.body).toContain("**Dominik Fretz**: hi")
    const lines = out.body.split("\n")
    expect(lines[2]).toMatch(/^\*\*Language\*\*/)
    expect(lines[4]).toBe("## Speakers")
    // The table (unbolded labels) survives the bold-label relabel.
    expect(out.body).toContain("| Speaker 0 | Zoe Smith - majority owner, Acme |")
    expect(out.body).toContain("| Speaker 9 | Nobody |")
  })

  test("never inserts a second block when one already exists", () => {
    const withBlock = plaud.replace(
      "---",
      "## Speakers\n\n| Label | Person |\n| --- | --- |\n| Speaker 0 | Zoe |\n\n---",
    )
    const out = applySpeakerMap(withBlock, speakers, "2026-09-07")
    expect(out.blockInserted).toBe(false)
    expect(out.body.match(/^## Speakers/gm)?.length).toBe(1)
    expect(out.body).toContain("| Speaker 0 | Zoe |")
  })

  test("a body with no header line gets the block after the title, or at the top", () => {
    const titled = applySpeakerMap("# Notes\n**Speaker 0**: x", speakers, "d")
    expect(titled.body.startsWith("# Notes\n\n## Speakers")).toBe(true)
    const bare = applySpeakerMap("**Speaker 0**: x", speakers, "d")
    expect(bare.body.startsWith("## Speakers")).toBe(true)
    expect(bare.body.endsWith("**Zoe Smith**: x")).toBe(true)
  })

  test("no label present: body gets only the block, no relabel results", () => {
    const out = applySpeakerMap("# T\nplain", speakers, "d")
    expect(out.results).toEqual([])
    expect(out.skippedLabels).toEqual(["Speaker 0", "Speaker 1"])
    expect(out.blockInserted).toBe(true)
  })
})

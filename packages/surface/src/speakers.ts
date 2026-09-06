/**
 * Pure helpers for `set_speaker_map` — turn a `{ "Speaker 0": { name, note } }` map into the
 * bulk relabel rules `replace_in_document` runs, and the `## Speakers` header block a resolved
 * transcript carries (the established format: a table between the `**Diarization**` line and the
 * first timestamp). No I/O; unit-tested in isolation.
 */
import { planReplacements, type ReplaceResult } from "./replace"

export interface SpeakerEntry {
  name: string
  note?: string
}

export type SpeakerMap = Record<string, SpeakerEntry>

/** `# Transcript: plaud-<32hex>.mp3` — the stable per-recording key the Plaud stage writes. */
const PLAUD_FILE_ID = /^# Transcript: (plaud-[0-9a-f]{32})\.mp3/m
/** The `[[meetings/...]]` wikilink a resolved transcript's header points at. */
const MEETING_LINK = /\[\[(meetings\/[^\]#|]+)/
const SPEAKERS_HEADING = /^## Speakers\b/m
/** The `**Language**: … | **Diarization**: …` line the block sits under. */
const HEADER_LINE = /^\*\*Language\*\*:.*$/m
const TITLE_LINE = /^# .*$/m

/** The memory slug for a transcript's map: keyed by Plaud file id when present, else document id. */
export const speakerMapKey = (body: string, documentId: string): string =>
  PLAUD_FILE_ID.exec(body)?.[1] ?? documentId

export const speakerMapSlug = (key: string): string => `agent/meetings/speaker-map/${key}`

export const meetingSlugIn = (body: string): string | null => MEETING_LINK.exec(body)?.[1] ?? null

/** The `## Speakers` block in the established table format. */
export const speakersBlock = (speakers: SpeakerMap, resolvedOn: string): string =>
  [
    "## Speakers",
    "",
    `Labels resolved ${resolvedOn} via set_speaker_map.`,
    "",
    "| Label | Person |",
    "| --- | --- |",
    ...Object.entries(speakers).map(
      ([label, entry]) => `| ${label} | ${entry.name}${entry.note ? ` - ${entry.note}` : ""} |`,
    ),
  ].join("\n")

export interface ApplySpeakerMapResult {
  body: string
  results: ReplaceResult[]
  /** Labels in the map that do not occur (as `**Label**`) in the body — reported, not fatal. */
  skippedLabels: string[]
  blockInserted: boolean
}

/**
 * Rewrite `**Label**` → `**Name**` for every mapped label present in the body (a label absent
 * from the body is skipped, not fatal), and insert the `## Speakers` block once — an existing
 * block (hand-written on the 2026-09-06 cleanup) is left exactly as it is.
 */
export const applySpeakerMap = (
  body: string,
  speakers: SpeakerMap,
  resolvedOn: string,
): ApplySpeakerMapResult => {
  const present = Object.entries(speakers).filter(([label]) => body.includes(`**${label}**`))
  const skippedLabels = Object.keys(speakers).filter((label) => !body.includes(`**${label}**`))
  let out = body
  let results: ReplaceResult[] = []
  if (present.length > 0) {
    const plan = planReplacements(
      body,
      present.map(([label, entry]) => ({ find: `**${label}**`, replaceWith: `**${entry.name}**` })),
    )
    out = plan.body
    results = plan.results
  }

  let blockInserted = false
  if (!SPEAKERS_HEADING.test(out)) {
    const block = `\n\n${speakersBlock(speakers, resolvedOn)}`
    const anchor = HEADER_LINE.exec(out) ?? TITLE_LINE.exec(out)
    if (anchor !== null && anchor.index !== undefined) {
      const at = anchor.index + anchor[0].length
      out = out.slice(0, at) + block + out.slice(at)
    } else {
      out = `${speakersBlock(speakers, resolvedOn)}\n\n${out}`
    }
    blockInserted = true
  }
  return { body: out, results, skippedLabels, blockInserted }
}

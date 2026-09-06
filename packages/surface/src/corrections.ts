/**
 * Pure helpers for `propose_corrections` / `apply_corrections` — the prompt, the salvage-parse of the
 * model's JSON, anchor validation (a change is applicable only when its `before` matches EXACTLY ONCE),
 * and the atomic apply. No I/O and no bindings, so this is unit-tested in isolation; the surface op
 * only wires these to `services.ai.genExtract` + the body load/save.
 */
import { extractJsonCandidates } from "@brain/shared"

export interface AnchoredChange {
  before: string
  after: string
  reason?: string
}

export interface ValidatedChange {
  id: number
  before: string
  after: string
  reason: string
  preview: string
}

export interface SkippedChange {
  before: string
  after: string
  reason: string
  why: string
}

/** System prompt — demands JSON-only output with VERBATIM anchors (no `response_format`; see gen.ts). */
export const PROPOSE_CORRECTIONS_SYSTEM = [
  "You correct text. Return ONLY a JSON object — no prose, no code fences.",
  'Shape: {"changes":[{"before":"<verbatim snippet>","after":"<replacement>","reason":"<short why>"}]}.',
  "Rules:",
  "- 'before' MUST be copied VERBATIM from the provided text (exact characters, case and punctuation) and long enough to occur EXACTLY ONCE.",
  "- If the snippet to change repeats elsewhere, extend 'before' with the surrounding words of that one occurrence until it is unique.",
  "- Only include a change you are confident matches the instruction. When unsure, omit it.",
  "- Never invent text absent from the source. 'after' is the corrected replacement for 'before'.",
  "- Do not change anything the instruction says to leave alone.",
  '- If nothing should change, return {"changes":[]}.',
].join("\n")

/** The user message: the instruction + the full body (fenced so the model can copy anchors verbatim). */
export const buildProposePrompt = (instruction: string, body: string): string =>
  `Instruction:\n${instruction}\n\nText:\n"""\n${body}\n"""`

/** Non-overlapping occurrences of `needle` (non-empty) in `haystack`. */
export const countOccurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : haystack.split(needle).length - 1

/** Salvage-parse the model JSON into raw {before,after,reason} changes. Never throws; [] on failure. */
export const parseProposedChanges = (raw: string | null): AnchoredChange[] => {
  if (raw === null) return []
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const list = (JSON.parse(candidate) as { changes?: unknown }).changes
      if (!Array.isArray(list)) continue
      const out: AnchoredChange[] = []
      for (const item of list) {
        const before = String((item as { before?: unknown }).before ?? "")
        const after = String((item as { after?: unknown }).after ?? "")
        const reason = String((item as { reason?: unknown }).reason ?? "")
        if (before.length > 0) out.push({ before, after, reason })
      }
      return out
    } catch {
      // try the next salvage candidate
    }
  }
  return []
}

/** A single-line window (~40 chars either side) around the first match, showing before → after. */
const previewFor = (body: string, change: AnchoredChange): string => {
  const i = body.indexOf(change.before)
  if (i < 0) return `${change.before} → ${change.after}`
  const lead = body.slice(Math.max(0, i - 40), i)
  const trail = body.slice(i + change.before.length, i + change.before.length + 40)
  return `…${lead}[${change.before} → ${change.after}]${trail}…`.replace(/\s+/g, " ")
}

/** Split raw changes into applicable (unique anchor, real change) vs skipped (ambiguous/not-found/no-op). */
export const validateProposedChanges = (
  body: string,
  changes: AnchoredChange[],
): { changes: ValidatedChange[]; skipped: SkippedChange[] } => {
  const applicable: ValidatedChange[] = []
  const skipped: SkippedChange[] = []
  let id = 1
  for (const c of changes) {
    const base = { before: c.before, after: c.after, reason: c.reason ?? "" }
    if (c.before === c.after) {
      skipped.push({ ...base, why: "no-op (before === after)" })
      continue
    }
    const occ = countOccurrences(body, c.before)
    if (occ === 0) skipped.push({ ...base, why: "anchor not found in body" })
    else if (occ > 1) skipped.push({ ...base, why: `ambiguous — anchor matches ${occ} times` })
    else applicable.push({ id: id++, ...base, preview: previewFor(body, c) })
  }
  return { changes: applicable, skipped }
}

/**
 * Apply anchored changes ATOMICALLY: each `before` must match EXACTLY ONCE against the EVOLVING body,
 * else throw before any partial write. Uses indexOf-splice (not String.replace) so `$`/regex chars in
 * `after` are inserted literally. Returns the new body + count.
 */
export const applyAnchoredChanges = (
  body: string,
  changes: readonly AnchoredChange[],
): { body: string; applied: number } => {
  let work = body
  let applied = 0
  for (const c of changes) {
    if (c.before.length === 0) throw new Error("apply_corrections: empty anchor")
    const occ = countOccurrences(work, c.before)
    if (occ !== 1) {
      throw new Error(
        `apply_corrections: anchor ${JSON.stringify(c.before.slice(0, 60))} matched ${occ} time(s) (need exactly 1) — no changes applied`,
      )
    }
    const i = work.indexOf(c.before)
    work = work.slice(0, i) + c.after + work.slice(i + c.before.length)
    applied++
  }
  return { body: work, applied }
}

/** Does `raw` (or its salvage slice) parse as a `{changes: [...]}` object at all? */
const parsesAsChangesObject = (raw: string): boolean =>
  extractJsonCandidates(raw).some((candidate) => {
    try {
      return Array.isArray((JSON.parse(candidate) as { changes?: unknown }).changes)
    } catch {
      return false
    }
  })

/**
 * Why a proposal came back EMPTY — `null` when it legitimately has changes/skips. An empty result
 * used to be silent; a caller could not tell "nothing to change" from "the model's JSON was cut off
 * by the output cap" (35 anchored changes on a 9 KB page plausibly overrun it).
 */
export const emptyProposalNote = (
  raw: string | null,
  proposed: readonly AnchoredChange[],
  validated: { changes: readonly unknown[]; skipped: readonly unknown[] },
): string | null => {
  if (validated.changes.length > 0 || validated.skipped.length > 0) return null
  if (raw === null)
    return "the model call failed or returned nothing — retry, or narrow the instruction"
  if (proposed.length === 0 && !parsesAsChangesObject(raw)) {
    return (
      `the model returned ${raw.length} chars that could not be parsed as a changes JSON object ` +
      "(likely truncated by the output cap) — narrow the instruction to fewer changes, or for text that " +
      "repeats many times use replace_in_document"
    )
  }
  return "the model proposed no changes it was confident in"
}

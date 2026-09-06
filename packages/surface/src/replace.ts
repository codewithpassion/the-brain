/**
 * Pure planner for `replace_in_document` — bulk find/replace with the same fail-closed contract as
 * `apply_corrections`, but for rules that match MANY times (relabelling `**Speaker 0**:` 791 times
 * in one transcript). Every rule is matched against the ORIGINAL body in one pass, so rule 2 can
 * never match text rule 1 just wrote; overlapping matches abort. No I/O, unit-tested in isolation.
 */

export interface ReplaceRule {
  find: string
  replaceWith: string
  /** Treat `find` as a JavaScript regular expression (default: literal). */
  isRegex?: boolean | undefined
  /** Regex flags (default `g`; `g` is always forced so every occurrence counts). */
  flags?: string | undefined
  /** Abort the whole call unless the rule matches exactly this many times. */
  expectedCount?: number | undefined
}

export interface ReplaceResult {
  find: string
  count: number
}

export interface ReplacePlan {
  body: string
  results: ReplaceResult[]
  /** Unified-ish diff of the changed lines, capped at `maxDiffLines`. */
  diff: string
}

/** A resolved match on the original body. */
interface Span {
  rule: number
  start: number
  end: number
  replacement: string
}

const MAX_PATTERN_LENGTH = 500
const ALLOWED_FLAGS = /^[gimsuy]*$/

/** Expand `$&`, `$1`…`$99`, `$<name>` and `$$` in a regex replacement template. */
const expandTemplate = (template: string, match: RegExpMatchArray): string =>
  template.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (whole, token: string, name?: string) => {
    if (token === "$") return "$"
    if (token === "&") return match[0]
    if (name !== undefined) return match.groups?.[name] ?? ""
    const group = match[Number(token)]
    return group === undefined ? whole : group
  })

const compileRegex = (rule: ReplaceRule, index: number): RegExp => {
  const flags = rule.flags ?? "g"
  if (!ALLOWED_FLAGS.test(flags)) {
    throw new Error(`replace_in_document: rule ${index + 1} has invalid regex flags "${flags}"`)
  }
  const withGlobal = flags.includes("g") ? flags : `${flags}g`
  try {
    return new RegExp(rule.find, withGlobal)
  } catch (err) {
    throw new Error(
      `replace_in_document: rule ${index + 1} is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const spansFor = (body: string, rule: ReplaceRule, index: number): Span[] => {
  if (rule.find.length === 0)
    throw new Error(`replace_in_document: rule ${index + 1} has an empty find`)
  if (rule.find.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `replace_in_document: rule ${index + 1} pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
    )
  }
  const spans: Span[] = []
  if (rule.isRegex === true) {
    const re = compileRegex(rule, index)
    for (const match of body.matchAll(re)) {
      const start = match.index ?? 0
      if (match[0].length === 0) {
        throw new Error(`replace_in_document: rule ${index + 1} matches the empty string`)
      }
      spans.push({
        rule: index,
        start,
        end: start + match[0].length,
        replacement: expandTemplate(rule.replaceWith, match),
      })
    }
    return spans
  }
  let from = 0
  for (;;) {
    const at = body.indexOf(rule.find, from)
    if (at < 0) break
    spans.push({
      rule: index,
      start: at,
      end: at + rule.find.length,
      replacement: rule.replaceWith,
    })
    from = at + rule.find.length
  }
  return spans
}

/** Line-number index: offset → 0-based line, via binary search over line starts. */
const lineStarts = (text: string): number[] => {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1)
  return starts
}
const lineOf = (starts: number[], offset: number): number => {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Apply ordered, non-overlapping spans to `text` (spans are absolute offsets into `text`). */
const splice = (text: string, spans: readonly Span[]): string => {
  let out = ""
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.replacement
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** A compact line diff: one hunk per run of touched original lines, `-` old then `+` new. */
const buildDiff = (body: string, spans: readonly Span[], maxLines: number): string => {
  if (spans.length === 0) return ""
  const starts = lineStarts(body)
  const lines = body.split("\n")
  // Group spans into runs of adjacent touched lines.
  const groups: { first: number; last: number; spans: Span[] }[] = []
  for (const span of spans) {
    const first = lineOf(starts, span.start)
    const last = lineOf(starts, Math.max(span.start, span.end - 1))
    const prev = groups[groups.length - 1]
    if (prev !== undefined && first <= prev.last + 1) {
      prev.last = Math.max(prev.last, last)
      prev.spans.push(span)
    } else {
      groups.push({ first, last, spans: [span] })
    }
  }
  const out: string[] = []
  let emitted = 0
  let omitted = 0
  for (const group of groups) {
    const regionStart = starts[group.first] ?? 0
    const regionEnd =
      group.last + 1 < starts.length ? (starts[group.last + 1] ?? body.length) - 1 : body.length
    const oldLines = lines.slice(group.first, group.last + 1)
    const shifted = group.spans.map((s) => ({
      ...s,
      start: s.start - regionStart,
      end: s.end - regionStart,
    }))
    const newLines = splice(body.slice(regionStart, regionEnd), shifted).split("\n")
    const hunk = [
      `@@ -${group.first + 1},${oldLines.length} +${group.first + 1},${newLines.length} @@`,
      ...oldLines.map((l) => `-${l}`),
      ...newLines.map((l) => `+${l}`),
    ]
    if (emitted + hunk.length > maxLines) {
      omitted += hunk.length
      continue
    }
    out.push(...hunk)
    emitted += hunk.length
  }
  if (omitted > 0) out.push(`… ${omitted} more diff line(s) omitted`)
  return out.join("\n")
}

/**
 * Plan every rule against `body` in ONE pass. Throws (nothing to write) when a rule matches zero
 * times, an `expectedCount` disagrees with reality, or two rules' matches overlap. The error
 * message carries the actual per-rule counts so a caller can correct `expectedCount` and retry.
 */
export const planReplacements = (
  body: string,
  rules: readonly ReplaceRule[],
  opts: { maxDiffLines?: number } = {},
): ReplacePlan => {
  if (rules.length === 0) throw new Error("replace_in_document: no replacements supplied")
  const perRule = rules.map((rule, i) => spansFor(body, rule, i))
  const results: ReplaceResult[] = rules.map((rule, i) => ({
    find: rule.find,
    count: perRule[i]?.length ?? 0,
  }))
  const counts = results.map((r) => `${JSON.stringify(r.find.slice(0, 60))}: ${r.count}`).join(", ")

  const problems: string[] = []
  rules.forEach((rule, i) => {
    const count = results[i]?.count ?? 0
    if (count === 0) problems.push(`rule ${i + 1} matched 0 times`)
    else if (rule.expectedCount !== undefined && rule.expectedCount !== count) {
      problems.push(`rule ${i + 1} expected ${rule.expectedCount} matches but found ${count}`)
    }
  })
  if (problems.length > 0) {
    throw new Error(
      `replace_in_document: ${problems.join("; ")} — no changes applied. Actual counts: ${counts}`,
    )
  }

  const spans = perRule.flat().sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]
    const cur = spans[i]
    if (prev !== undefined && cur !== undefined && cur.start < prev.end) {
      throw new Error(
        `replace_in_document: rules ${prev.rule + 1} and ${cur.rule + 1} overlap at offset ${cur.start} — no changes applied`,
      )
    }
  }

  return {
    body: splice(body, spans),
    results,
    diff: buildDiff(body, spans, opts.maxDiffLines ?? 200),
  }
}

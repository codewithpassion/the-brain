/**
 * Placeholder speaker labels that must NEVER become knowledge-graph entities. Diarised
 * transcripts carry `Speaker 0` / `Speaker A` (Deepgram, AssemblyAI) and Granola carries
 * `Me` / `Them`; without this gate the nightly extraction promotes every one of them to a
 * "person" and the graph fills with fake people. Pure, so both the extractor and any cleanup
 * tooling agree on exactly what counts as a placeholder.
 */

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^speaker\s*\d+$/i,
  /^speaker\s*[a-z]$/i,
  /^(them|me|you|unknown|guest|participant|attendee|presenter|host)$/i,
  /^me\s*\(.*\)$/i,
  /^(participant|attendee|speaker)\s*\d+$/i,
]

/** True when `name` (trimmed) is a diarisation/role placeholder rather than a real name. */
export const isPlaceholderEntityName = (name: string): boolean => {
  const trimmed = name.trim()
  if (trimmed.length === 0) return true
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))
}

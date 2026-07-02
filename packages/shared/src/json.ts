/**
 * Truncation-salvage JSON candidates (shared): given possibly-noisy LLM output, return the
 * strings worth attempting `JSON.parse` on — the raw text, then the first-brace…last-brace slice
 * (recovers a JSON object wrapped in prose or truncated mid-trailer). The caller `JSON.parse`es
 * each in order and takes the first that succeeds. Mirrors the cf-graph `extractJsonFromText`
 * heuristic; used by the KG extractor and the Dream judge so the salvage logic has one home.
 */
export const extractJsonCandidates = (text: string): string[] => {
  const candidates = [text]
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  return candidates
}

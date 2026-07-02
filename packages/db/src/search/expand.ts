/**
 * Query expansion (W4.1, PRD §5 retrieval polish).
 *
 * Generates a few alternative phrasings of the query via the `gen()` chokepoint BEFORE
 * retrieval, so the hybrid arms search over `[original, ...variants]` and fuse the union —
 * widening recall for under-specified questions. It is a strict widening: on any degrade
 * (`gen()` returns `null`) or no usable variants it returns `[query]`, so retrieval proceeds
 * EXACTLY as the un-expanded path (never worse than today, invariant 14). The single `gen()`
 * call rides the same budget window the pipeline pre-checks (invariant 16) — the caller runs
 * `budget.check()` before this — and the same tenant-attributed AI Gateway route as synthesis.
 */
import type { AiPort } from "./types"

/** Default number of variant phrasings requested (excludes the original). */
export const QUERY_EXPANSION_COUNT = 3

const EXPAND_SYSTEM =
  "You rewrite a search query into alternative phrasings that capture the SAME intent with " +
  "different vocabulary (synonyms, related terms, a broader and a narrower form). Output ONLY " +
  "the alternatives, one per line — no numbering, no bullets, no commentary, no blank lines."

/** Strip any leading bullet / numbering the model may emit despite the instruction. */
const clean = (line: string): string => line.replace(/^[\s*\-•\d.)]+/, "").trim()

/**
 * Expand `query` into `[query, ...variants]` (variants deduped case-insensitively against each
 * other and the original, capped at `count`). Returns `[query]` unchanged when `gen()` degrades
 * to `null` or yields nothing usable — the callers treat that as the plain single-query path.
 */
export const expandQuery = async (
  ai: Pick<AiPort, "gen">,
  query: string,
  count: number = QUERY_EXPANSION_COUNT,
): Promise<string[]> => {
  const prompt = `Query: ${query}\n\nGive up to ${count} alternative phrasings of this query.`
  const raw = await ai.gen(prompt, EXPAND_SYSTEM)
  if (raw === null) return [query] // degrade: retrieval uses the original query only

  const seen = new Set([query.toLowerCase()])
  const variants: string[] = []
  for (const line of raw.split("\n")) {
    const v = clean(line)
    if (v.length === 0) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    variants.push(v)
    if (variants.length >= count) break
  }
  return [query, ...variants]
}

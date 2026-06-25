/**
 * Token-budget-guarded synthesis prompt builder (PRD §5.5, NET-NEW guard).
 *
 * Packs reranked evidence highest-score-first into a numbered-evidence prompt until the
 * `SYNTHESIS_TOKEN_BUDGET` is hit. Eviction is SURFACED in `warnings`/`gaps` — never a silent
 * mid-document truncation. A single oversized top hit is truncated-to-fit with an explicit
 * warning (the map/summarize step is a deferred refinement — see notes). `gen()` itself is a
 * separate chokepoint that degrades to `null`; this module only builds the prompt.
 */
import { SYNTHESIS_TOKEN_BUDGET } from "@brain/shared"
import type { FusedCandidate } from "./types"

const CHARS_PER_TOKEN = 4
const est = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/** The strict evidence-only system prompt (gbrain `SYNTH_SYSTEM`, verbatim intent). */
export const SYNTH_SYSTEM =
  "You answer questions using ONLY the provided evidence chunks. Cite the slug of each " +
  "page you draw from. If the evidence is insufficient, say so plainly and list what is missing."

const blockText = (index: number, c: FusedCandidate): string =>
  `[${index + 1}] (${c.candidate.slug} — ${c.candidate.title ?? ""})\n${c.candidate.content}\n\n`

export interface BuiltPrompt {
  prompt: string
  used: FusedCandidate[]
  warnings: string[]
  gaps: string[]
}

/**
 * Build the synthesis prompt under the token budget. Returns the packed prompt, the evidence
 * actually used, and any eviction/truncation surfaced in `warnings`/`gaps`.
 */
export const buildSynthesisPrompt = (
  question: string,
  ranked: FusedCandidate[],
  budgetTokens: number = SYNTHESIS_TOKEN_BUDGET,
): BuiltPrompt => {
  const budget = budgetTokens - est(question)
  const used: FusedCandidate[] = []
  const warnings: string[] = []
  const gaps: string[] = []
  let spent = 0

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]
    if (r === undefined) continue
    const cost = est(blockText(used.length, r))

    if (used.length === 0 && cost > budget) {
      // Single oversized top hit → truncate-to-fit and surface it (never silently dropped).
      const room = Math.max(
        0,
        budget - est(`[1] (${r.candidate.slug} — ${r.candidate.title ?? ""})\n\n`),
      )
      const truncated: FusedCandidate = {
        ...r,
        candidate: {
          ...r.candidate,
          content: r.candidate.content.slice(0, room * CHARS_PER_TOKEN),
        },
      }
      used.push(truncated)
      warnings.push(`evidence_truncated:${r.candidate.slug}`)
      gaps.push(
        `The top evidence chunk (${r.candidate.slug}) was truncated to fit the context window.`,
      )
      break
    }

    if (spent + cost > budget) {
      const evicted = ranked.length - used.length
      warnings.push(`evidence_evicted:${evicted}`)
      gaps.push(
        `${evicted} lower-ranked evidence chunk(s) omitted to fit the model context window.`,
      )
      break
    }
    used.push(r)
    spent += cost
  }

  const blocks = used
    .map(
      (r, i) =>
        `[${i + 1}] (${r.candidate.slug} — ${r.candidate.title ?? ""})\n${r.candidate.content}`,
    )
    .join("\n\n")
  const prompt = `Question: ${question}\n\nEvidence:\n${blocks}\n\nAnswer the question, citing the page slugs you used.`
  return { prompt, used, warnings, gaps }
}

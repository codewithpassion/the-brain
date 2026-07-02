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
import type { AiPort, FusedCandidate } from "./types"

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

// ── Map/refine over-budget synthesis (W4.3) ───────────────────────────────────────
//
// When the full evidence set OVERFLOWS the context budget, truncate-to-fit silently drops the
// tail. Map/refine instead summarizes the evidence in fitting groups (the MAP step), then
// synthesizes the answer over those summaries (the REFINE step) — so nothing is evicted. A failed
// map gen() degrades to the original truncate path (never worse than before).

/** Map-step system prompt: compress a slice of evidence to what's relevant, preserving slugs. */
export const MAP_SYSTEM =
  "You compress evidence for a downstream answerer. Given a question and numbered evidence " +
  "chunks, write a concise summary of ONLY the facts relevant to the question, and keep the " +
  "slug of every source you draw from in parentheses. Do NOT answer the question yourself."

const groupBlocks = (group: FusedCandidate[]): string =>
  group
    .map(
      (r, i) =>
        `[${i + 1}] (${r.candidate.slug} — ${r.candidate.title ?? ""})\n${r.candidate.content}`,
    )
    .join("\n\n")

/** Token estimate for the full evidence set packed as one synthesis prompt. */
const totalEvidenceTokens = (question: string, ranked: FusedCandidate[]): number =>
  est(question) + ranked.reduce((sum, r) => sum + est(blockText(0, r)), 0)

/**
 * Partition ranked evidence (highest-first, order preserved) into groups that each fit
 * `budgetTokens`. A single chunk larger than the budget occupies its own group (the map step
 * summarizes it rather than dropping it).
 */
export const partitionForMap = (
  ranked: FusedCandidate[],
  budgetTokens: number,
): FusedCandidate[][] => {
  const groups: FusedCandidate[][] = []
  let current: FusedCandidate[] = []
  let spent = 0
  for (const r of ranked) {
    const cost = est(blockText(current.length, r))
    if (current.length > 0 && spent + cost > budgetTokens) {
      groups.push(current)
      current = []
      spent = 0
    }
    current.push(r)
    spent += cost
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** One map-step summary + the slugs it covered (for the refine prompt + citation continuity). */
interface GroupSummary {
  text: string
  slugs: string[]
}

const buildMapPrompt = (question: string, group: FusedCandidate[]): string =>
  `Question: ${question}\n\nEvidence:\n${groupBlocks(group)}\n\nSummarize the evidence relevant to the question, citing the slugs you used.`

const buildRefinePrompt = (question: string, summaries: GroupSummary[]): string => {
  const blocks = summaries
    .map((s, i) => `[Summary ${i + 1}] (sources: ${s.slugs.join(", ")})\n${s.text}`)
    .join("\n\n")
  return `Question: ${question}\n\nEvidence summaries:\n${blocks}\n\nAnswer the question using ONLY these summaries, citing the source slugs you rely on.`
}

export interface SynthOutcome {
  /** The synthesized answer, or `null` when the final gen() degraded (→ llm_unavailable). */
  answer: string | null
  warnings: string[]
  gaps: string[]
}

/**
 * Produce the cited answer. When the full evidence fits the budget, this is the single-gen
 * truncate-aware path (`buildSynthesisPrompt`). When it OVERFLOWS, it runs map/refine so no
 * evidence is silently evicted. A failed map gen() degrades to the truncate path (never worse
 * than before). `budgetCheck` runs before EACH gen() (invariant 16 cost-cap re-check); the
 * gen() chokepoint itself degrades to `null` → `answer: null` (the caller emits llm_unavailable).
 */
export const synthesizeAnswer = async (
  ai: Pick<AiPort, "gen">,
  budgetCheck: () => Promise<void>,
  question: string,
  ranked: FusedCandidate[],
  budgetTokens: number = SYNTHESIS_TOKEN_BUDGET,
): Promise<SynthOutcome> => {
  // The single-gen path (evidence fits, or a single oversized hit truncate handles + surfaces).
  const single = async (): Promise<SynthOutcome> => {
    const { prompt, warnings, gaps } = buildSynthesisPrompt(question, ranked, budgetTokens)
    await budgetCheck()
    const answer = await ai.gen(prompt, SYNTH_SYSTEM)
    return { answer, warnings, gaps }
  }

  const overBudget = ranked.length > 1 && totalEvidenceTokens(question, ranked) > budgetTokens
  if (!overBudget) return single()

  // MAP: summarize each fitting group. A single failed map gen() → degrade to the truncate path.
  const groups = partitionForMap(ranked, budgetTokens)
  const summaries: GroupSummary[] = []
  for (const group of groups) {
    await budgetCheck()
    const text = await ai.gen(buildMapPrompt(question, group), MAP_SYSTEM)
    if (text === null) {
      const degraded = await single()
      return { ...degraded, warnings: [...degraded.warnings, "map_refine_degraded"] }
    }
    summaries.push({ text: text.trim(), slugs: group.map((r) => r.candidate.slug) })
  }

  // REFINE: synthesize the answer over the summaries (nothing evicted).
  await budgetCheck()
  const answer = await ai.gen(buildRefinePrompt(question, summaries), SYNTH_SYSTEM)
  return {
    answer,
    warnings: ["map_refine"],
    gaps: [`Evidence was summarized in ${groups.length} group(s) to fit the model context.`],
  }
}

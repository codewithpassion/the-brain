/**
 * Reciprocal Rank Fusion + trust/title boosts (PRD §5.3.3).
 *
 * RRF fuses the per-arm RANKED candidate lists by summing `1/(K + rank)` across arms
 * (rank 1-based), then NORMALIZES by the max fused score, THEN applies the boosts — trust
 * grade (`instruction` > `evidence` > `draft`) and a title-phrase boost (×TITLE_BOOST). The
 * order matters: boosting a normalized score keeps the multipliers comparable across queries
 * (gbrain `rrfFusion` discipline; do NOT double-normalize).
 *
 * Same chunk appearing in both arms fuses by `chunkId` (a stable nanoid uniquely identifies
 * the chunk, so it also subsumes gbrain's `${source_id}:${slug}:${chunk_id}` key).
 */
import { NOTABILITY_BOOST, RRF_K, TITLE_BOOST, TRUST_BOOST } from "@brain/shared"
import type { Candidate, FusedCandidate } from "./types"

/** Trust multiplier from the hydrated row's sidecar trust grade (default `evidence` = 1.0). */
const trustBoost = (trustGrade: string): number =>
  TRUST_BOOST[trustGrade as keyof typeof TRUST_BOOST] ?? 1.0

/**
 * Notability multiplier (Dream hygiene D5). A candidate WITHOUT notability (every chunk candidate
 * today) → 1.0, so this is inert for content search until a fact-bearing arm supplies notability;
 * `medium` is also 1.0. Exported for a direct unit test of the flagged/tunable weight.
 */
export const notabilityBoost = (notability: string | undefined): number =>
  notability === undefined
    ? 1.0
    : (NOTABILITY_BOOST[notability as keyof typeof NOTABILITY_BOOST] ?? 1.0)

/** Lowercase content tokens (≥1 char) — the unit both title matching and fusion compare. */
const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)

/**
 * Title-phrase match (gbrain `isTitlePhraseMatch`): the query's content tokens appear as a
 * CONTIGUOUS run inside the title, with a ≥2-content-token floor (a single shared word is
 * too weak to boost). Returns false when the title is absent or the query is too short.
 */
export const isTitlePhraseMatch = (query: string, title: string | null): boolean => {
  if (!title) return false
  const q = tokens(query)
  if (q.length < 2) return false
  const t = tokens(title)
  if (t.length < q.length) return false
  for (let i = 0; i + q.length <= t.length; i++) {
    let hit = true
    for (let j = 0; j < q.length; j++) {
      if (t[i + j] !== q[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/** Fusion knobs. `weighNotability` (default OFF) opts a surface into the D5 notability boost — the
 *  future fact-bearing arm must set it explicitly; content search leaves it off (the plan's "flagged"). */
export interface FusionOptions {
  weighNotability?: boolean
}

/**
 * Fuse the per-arm ranked candidate lists. Each arm is consumed in its given order (the arm
 * is responsible for ranking); position `r` (0-based) contributes `1/(K + r + 1)`. The
 * fused score is then normalized by its max and multiplied by the trust + title boosts (and, when
 * `opts.weighNotability`, the notability boost). Output is sorted by final score, descending.
 */
export const rrfFusion = (
  arms: Candidate[][],
  query: string,
  k: number = RRF_K,
  opts: FusionOptions = {},
): FusedCandidate[] => {
  const fused = new Map<string, { candidate: Candidate; raw: number }>()
  for (const arm of arms) {
    for (let rank = 0; rank < arm.length; rank++) {
      const candidate = arm[rank]
      if (candidate === undefined) continue
      const contribution = 1 / (k + rank + 1)
      const existing = fused.get(candidate.chunkId)
      if (existing) {
        existing.raw += contribution
      } else {
        fused.set(candidate.chunkId, { candidate, raw: contribution })
      }
    }
  }
  if (fused.size === 0) return []

  let maxRaw = 0
  for (const entry of fused.values()) {
    if (entry.raw > maxRaw) maxRaw = entry.raw
  }

  const out: FusedCandidate[] = []
  for (const { candidate, raw } of fused.values()) {
    const normalized = maxRaw > 0 ? raw / maxRaw : 0
    const titleFactor = isTitlePhraseMatch(query, candidate.title) ? TITLE_BOOST : 1.0
    const notabilityFactor = opts.weighNotability ? notabilityBoost(candidate.notability) : 1.0
    out.push({
      candidate,
      score: normalized * trustBoost(candidate.trustGrade) * titleFactor * notabilityFactor,
    })
  }
  return out.sort((a, b) => b.score - a.score)
}

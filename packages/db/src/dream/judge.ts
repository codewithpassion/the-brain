/**
 * Dream cluster judging (v2 W1/D1 step 2). For each candidate cluster, ask `genExtract` for a
 * typed-JSON verdict — merge / supersede / contradict / keep — with the SAME truncation-salvage
 * parsing the KG extractor uses (shared `extractJsonCandidates`). Non-fatal degrade (invariant 14):
 * a null model output or unparseable JSON → a `keep` verdict counted as `skipped`, never a throw.
 *
 * The auto-merge confidence floor is applied by the CALLER (apply.ts / run.ts), not here: a
 * merge/supersede verdict below the floor is downgraded to a `contradict` (filed for human review)
 * rather than applied automatically (the plan's dream-quality risk mitigation).
 */
import { extractJsonCandidates } from "@brain/shared"
import type { DreamCluster } from "./select"

/** The AI slice this step needs (genExtract only). */
export interface JudgeAi {
  genExtract: (prompt: string, system?: string) => Promise<string | null>
}

export type DreamAction = "merge" | "supersede" | "contradict" | "keep"

/** A judge verdict over one cluster. */
export interface DreamVerdict {
  action: DreamAction
  /** Present for `merge`: the single consolidated fact text. */
  mergedText: string | null
  /** Present for `supersede`: the fact ids the winner replaces. */
  supersededIds: number[]
  /** Present for `supersede`: the surviving fact id. */
  winnerId: number | null
  confidence: number
  rationale: string
  /** True when the verdict is a degrade (null/unparseable model output) counted as skipped. */
  skipped: boolean
}

const DREAM_JUDGE_SYSTEM =
  "You are a memory-consolidation judge. You are given a small cluster of hot-memory facts that " +
  "are about the same subject. Decide the single best action and reply with ONE JSON object, no " +
  'prose. Schema: {"action":"merge|supersede|contradict|keep","mergedText":string?,' +
  '"supersededIds":number[]?,"winnerId":number?,"confidence":0..1,"rationale":string}. ' +
  "merge = the facts say the same thing and should become one clean fact (set mergedText). " +
  "supersede = one fact is a newer/corrected version of the others (set winnerId + supersededIds). " +
  "contradict = the facts genuinely disagree and a human must decide (do not invent a merge). " +
  "keep = they are distinct facts that should all stay. Use the exact integer ids given."

/** Render a cluster's facts as a compact numbered list for the prompt. */
const renderCluster = (cluster: DreamCluster): string => {
  const lines = cluster.facts.map(
    (f) => `- id=${f.id} (kind=${f.kind}, confidence=${f.confidence}): ${f.fact}`,
  )
  const subject = cluster.entitySlug ? `entity "${cluster.entitySlug}"` : "a related group"
  return `Facts about ${subject}:\n${lines.join("\n")}`
}

/** The valid ids in this cluster — clamp the model's id references so apply can trust them. */
const clusterIds = (cluster: DreamCluster): Set<number> => new Set(cluster.facts.map((f) => f.id))

/** Salvage-parse a verdict; returns null when nothing parses (caller degrades to keep+skipped). */
const parseVerdict = (text: string, cluster: DreamCluster): DreamVerdict | null => {
  const ids = clusterIds(cluster)
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (!parsed || typeof parsed !== "object") continue
      const rawAction = String(parsed.action ?? "keep").trim()
      const action: DreamAction =
        rawAction === "merge" ||
        rawAction === "supersede" ||
        rawAction === "contradict" ||
        rawAction === "keep"
          ? rawAction
          : "keep"
      const supersededIds = Array.isArray(parsed.supersededIds)
        ? parsed.supersededIds
            .map((v) => Number(v))
            .filter((n) => Number.isInteger(n) && ids.has(n))
        : []
      const winnerRaw = Number(parsed.winnerId)
      const winnerId = Number.isInteger(winnerRaw) && ids.has(winnerRaw) ? winnerRaw : null
      return {
        action,
        mergedText:
          typeof parsed.mergedText === "string" && parsed.mergedText.trim().length > 0
            ? parsed.mergedText.trim()
            : null,
        supersededIds,
        winnerId,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        skipped: false,
      }
    } catch {
      // try the next salvage strategy
    }
  }
  return null
}

/** The degrade verdict: keep everything, counted as skipped. */
const KEEP_SKIPPED: DreamVerdict = {
  action: "keep",
  mergedText: null,
  supersededIds: [],
  winnerId: null,
  confidence: 0,
  rationale: "judge unavailable",
  skipped: true,
}

/** Judge one cluster. Never throws; a null/unparseable model output → keep + skipped. */
export const judgeCluster = async (ai: JudgeAi, cluster: DreamCluster): Promise<DreamVerdict> => {
  const raw = await ai.genExtract(renderCluster(cluster), DREAM_JUDGE_SYSTEM)
  if (raw === null) return { ...KEEP_SKIPPED }
  const parsed = parseVerdict(raw, cluster)
  return parsed ?? { ...KEEP_SKIPPED }
}

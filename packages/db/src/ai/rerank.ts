/**
 * `rerank()` chokepoint over bge-reranker-base (PRD §5.4, invariants 14, 20).
 *
 * Encapsulates the reranker output→candidate **index remap** behind ONE auditable
 * function (`remapRerank`, invariant 20). A silently-wrong remap attributes the WRONG
 * chunk to a citation — a correctness bug, not merely degraded ranking — so the remap is
 * isolated here and degrades to RRF (input) order on any malformed output.
 *
 * ASSUMED bge-reranker-base output shape (matches `@cloudflare/workers-types`):
 *   `{ response: Array<{ id: number; score: number }> }`
 * where `id` is the 0-based index into the input `contexts` array and `score` is the
 * rerank score. The exact field names are NOT pinned by the rendered CF docs — a STAGING
 * INTEGRATION GATE (Phase 1e) must lock the real shape against the live model before this
 * remap is trusted in prod; until green, prod degrades to RRF order. `remapRerank` parses
 * defensively (drops rows whose `id` is not a valid candidate index).
 *
 * Provider routing: when `deps.openaiConfig` is set, routes to the openai-compatible
 * `/v1/rerank` endpoint (Cohere-style response). The response is normalized into the same
 * `BgeRerankOutput` shape so the SINGLE `remapRerank` handles both paths (invariant 20).
 */
import { RERANK_MODEL } from "@brain/shared"
import { type AiDeps, aiGateway, type OpenAiCompatConfig } from "./gateway"

export interface RerankCandidate {
  text: string
}

/** A rerank result: which input candidate (`index`) and its rerank `score`. */
export interface RerankHit {
  index: number
  score: number
}

interface BgeRerankOutput {
  response?: { id?: number; score?: number }[]
}

interface OpenAiRerankResponse {
  results?: { index: number; relevance_score: number }[]
}

/** RRF/identity order over the first `topK` candidates — the degrade target. */
const identityOrder = (count: number, topK: number): RerankHit[] =>
  Array.from({ length: Math.min(count, topK) }, (_unused, index) => ({ index, score: 0 }))

/**
 * The SINGLE index→candidate remap (invariant 20). Returns `null` when the output is
 * malformed/empty (caller degrades to identity order); otherwise the surviving hits in
 * the model's order, dropping any row whose `id` is not a valid candidate index.
 */
export const remapRerank = (
  candidateCount: number,
  output: BgeRerankOutput,
): RerankHit[] | null => {
  const response = output.response
  if (!response || response.length === 0) return null
  const hits: RerankHit[] = []
  for (const row of response) {
    const index = row.id
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= candidateCount
    ) {
      continue
    }
    hits.push({ index, score: typeof row.score === "number" ? row.score : 0 })
  }
  return hits.length > 0 ? hits : null
}

/**
 * openai-compatible rerank via POST /v1/rerank (Cohere-style).
 * Normalizes `{ results: [{ index, relevance_score }] }` → `BgeRerankOutput` so
 * `remapRerank` handles both paths (invariant 20: single auditable remap).
 */
const runRerankOpenAi = async (
  cfg: OpenAiCompatConfig,
  query: string,
  candidates: RerankCandidate[],
  topK: number,
): Promise<BgeRerankOutput | null> => {
  const model = cfg.rerankModel ?? RERANK_MODEL
  const fetchFn = cfg.fetch ?? globalThis.fetch
  const res = await fetchFn(`${cfg.baseUrl}/v1/rerank`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      query,
      documents: candidates.map((c) => c.text),
      top_n: topK,
    }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as OpenAiRerankResponse
  const results = json.results
  if (!results) return null
  // Normalize to BgeRerankOutput — remapRerank handles it (invariant 20: single remap)
  return {
    response: results.map((r) => ({ id: r.index, score: r.relevance_score })),
  }
}

/**
 * READ path. Never throws; on missing binding, malformed output, or a thrown AI error,
 * returns identity (RRF) order over the first `topK` candidates (invariant 14).
 */
export const rerank = async (
  deps: AiDeps,
  query: string,
  candidates: RerankCandidate[],
  topK: number,
): Promise<RerankHit[]> => {
  if (candidates.length === 0) return []
  try {
    let res: BgeRerankOutput
    if (deps.openaiConfig) {
      const raw = await runRerankOpenAi(deps.openaiConfig, query, candidates, topK)
      if (!raw) return identityOrder(candidates.length, topK)
      res = raw
    } else {
      res = (await deps.ai.run(
        RERANK_MODEL,
        { query, contexts: candidates.map((candidate) => ({ text: candidate.text })), top_k: topK },
        aiGateway(deps.gatewayId, deps.tenantId),
      )) as BgeRerankOutput
    }
    const remapped = remapRerank(candidates.length, res)
    return remapped ? remapped.slice(0, topK) : identityOrder(candidates.length, topK)
  } catch {
    return identityOrder(candidates.length, topK)
  }
}

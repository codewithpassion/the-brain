/**
 * `embed()` chokepoint over bge-m3 (PRD §5.1, invariants 12, 14, 16).
 *
 * bge-m3 is LOCKED to 1024d. A dim mismatch is REFUSED (invariant 12) — a silent model
 * swap that changes dims is a P0, so we refuse rather than poison the index. Two variants:
 *   - READ path `embed()` — NEVER throws (invariant 14); returns `null` so the caller
 *     degrades to keyword-only. Covers missing binding, oversized input, dim mismatch.
 *   - WRITE/index path `embedForIndex()` — THROWS on any failure so the Workflow step
 *     retries; we never index un-embedded chunks (invariant 14).
 *
 * Provider routing: when `deps.openaiConfig` is set, routes to the openai-compatible
 * `/v1/embeddings` endpoint instead of `env.AI.run`. Same dim invariant applies.
 */
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "@brain/shared"
import {
  type AiDeps,
  aiGateway,
  GatewayBudgetError,
  isGatewayBudgetError,
  type OpenAiCompatConfig,
} from "./gateway"

/** bge-m3's documented context window; guard cheaply before burning an AI call. */
const MAX_EMBED_INPUT_TOKENS = 60_000
/** Rough BPE heuristic — set the guard from the model window, not a stale literal. */
const CHARS_PER_TOKEN = 4

interface BgeEmbedOutput {
  data?: number[][]
}

interface OpenAiEmbedResponse {
  data?: { embedding: number[] }[]
}

const exceedsWindow = (texts: string[]): boolean =>
  texts.some((text) => Math.ceil(text.length / CHARS_PER_TOKEN) > MAX_EMBED_INPUT_TOKENS)

/** openai-compatible embed via POST /v1/embeddings. Returns null on any non-ok/parse failure. */
const runEmbedOpenAi = async (
  cfg: OpenAiCompatConfig,
  texts: string[],
): Promise<number[][] | null> => {
  const model = cfg.embedModel ?? EMBEDDING_MODEL
  const fetchFn = cfg.fetch ?? globalThis.fetch
  const res = await fetchFn(`${cfg.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as OpenAiEmbedResponse
  const data = json.data
  if (!data || data.length !== texts.length) return null
  if (data.some((row) => row.embedding.length !== EMBEDDING_DIMS)) return null
  return data.map((row) => row.embedding)
}

/**
 * Run bge-m3 (or openai-compatible) and validate count + 1024-dim on EVERY row.
 * Returns `null` on shape mismatch. Throws `GatewayBudgetError` on budget rejection
 * (Workers AI path only); other errors propagate as-is.
 */
const runEmbed = async (deps: AiDeps, texts: string[]): Promise<number[][] | null> => {
  if (deps.openaiConfig) return runEmbedOpenAi(deps.openaiConfig, texts)
  try {
    const res = (await deps.ai.run(
      EMBEDDING_MODEL,
      { text: texts },
      aiGateway(deps.gatewayId, deps.tenantId),
    )) as BgeEmbedOutput
    const data = res.data
    if (!data || data.length !== texts.length) return null
    if (data.some((row) => row.length !== EMBEDDING_DIMS)) return null
    return data
  } catch (err) {
    if (isGatewayBudgetError(err)) throw new GatewayBudgetError()
    throw err
  }
}

/**
 * READ path. Returns `[]` for empty input, `null` on any failure (missing binding,
 * oversized input, dim mismatch, or a thrown AI error) — never throws.
 */
export const embed = async (deps: AiDeps, texts: string[]): Promise<number[][] | null> => {
  if (texts.length === 0) return []
  if (exceedsWindow(texts)) return null
  try {
    return await runEmbed(deps, texts)
  } catch {
    return null
  }
}

/**
 * WRITE/index path. Throws on any failure so the calling Workflow step retries; a chunk
 * is never indexed un-embedded or at the wrong dimension. A `GatewayBudgetError` thrown
 * here is a typed signal to the Workflow that retrying won't help until budget resets.
 */
export const embedForIndex = async (deps: AiDeps, texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return []
  if (exceedsWindow(texts)) {
    throw new Error("embed input exceeds bge-m3 token window")
  }
  const out = await runEmbed(deps, texts)
  if (!out) {
    throw new Error(`embed failed or did not return ${EMBEDDING_DIMS}-dim vectors`)
  }
  return out
}

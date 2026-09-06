/**
 * `gen()` chokepoint over llama-3.3-70b (PRD §5.5, invariants 14, 16).
 *
 * READ path only: NEVER throws (invariant 14). On any failure (missing binding, empty
 * output, thrown AI error) returns `null` so `think` degrades to evidence-without-
 * synthesis. The token-budget-guarded prompt PACKING (`buildSynthesisPrompt`) is the
 * Phase-2 retrieval pipeline; this chokepoint is just the guarded model call.
 *
 * Provider routing: when `deps.openaiConfig` is set, routes to the openai-compatible
 * `/v1/chat/completions` endpoint instead of `env.AI.run`.
 */
import { EXTRACT_MODEL, GENERATION_MODEL } from "@brain/shared"
import { type AiDeps, aiGateway, type OpenAiCompatConfig } from "./gateway"

interface LlamaGenOutput {
  response?: string
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[]
}

/** openai-compatible chat via POST /v1/chat/completions. Returns null on any failure. */
const runGenOpenAi = async (
  cfg: OpenAiCompatConfig,
  messages: { role: string; content: string }[],
  model: string,
  extra?: Record<string, unknown>,
): Promise<string | null> => {
  const fetchFn = cfg.fetch ?? globalThis.fetch
  const res = await fetchFn(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, ...extra }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as OpenAiChatResponse
  const content = json.choices?.[0]?.message?.content
  return typeof content === "string" && content.length > 0 ? content : null
}

/**
 * Generate over the given prompt (optional system preamble). Returns the text, or `null`
 * on any failure. The caller is responsible for token-budget packing before calling.
 */
export const gen = async (
  deps: AiDeps,
  prompt: string,
  system?: string,
): Promise<string | null> => {
  const messages: { role: string; content: string }[] = system
    ? [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ]
    : [{ role: "user", content: prompt }]
  if (deps.openaiConfig) {
    const model = deps.openaiConfig.genModel ?? GENERATION_MODEL
    return runGenOpenAi(deps.openaiConfig, messages, model).catch(() => null)
  }
  try {
    const res = (await deps.ai.run(
      GENERATION_MODEL,
      { messages },
      aiGateway(deps.gatewayId, deps.tenantId),
    )) as LlamaGenOutput
    const out = res.response
    return typeof out === "string" && out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Room for a full KG batch's entity list (the 256-token Workers AI default truncates mid-JSON). */
const DEFAULT_EXTRACT_MAX_TOKENS = 4096

/**
 * KG-extraction generation over llama-3.1-8b (`EXTRACT_MODEL`, PRD §6.2). Same never-throws
 * contract as `gen()` (invariant 14) — returns `null` on any failure so entity extraction
 * stays NON-FATAL. Requests `response_format: { type: 'json_object' }` for the structured KG
 * payload; the caller still applies truncation-salvage parsing on top.
 */
export const genExtract = async (
  deps: AiDeps,
  prompt: string,
  system?: string,
  opts?: { maxTokens?: number },
): Promise<string | null> => {
  const maxTokens = opts?.maxTokens ?? DEFAULT_EXTRACT_MAX_TOKENS
  const messages: { role: string; content: string }[] = system
    ? [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ]
    : [{ role: "user", content: prompt }]
  if (deps.openaiConfig) {
    const model = deps.openaiConfig.extractModel ?? EXTRACT_MODEL
    return runGenOpenAi(deps.openaiConfig, messages, model, {
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
    }).catch(() => null)
  }
  try {
    // NOTE: do NOT pass `response_format: { type: "json_object" }` here — Workers AI's
    // `@cf/meta/llama-3.1-8b-instruct` rejects that param (the call throws → null → 0 entities,
    // which is what silently broke KG extraction). The EXTRACT_SYSTEM prompt instructs JSON-only
    // output and the caller's `parseKgJson` salvages it. (The openai-compat path above keeps it.)
    const res = (await deps.ai.run(
      EXTRACT_MODEL,
      // `max_tokens` is REQUIRED here: Workers AI defaults to 256 tokens, which truncates the KG
      // JSON mid-entity → unparseable → 0 entities (the empty-graph bug). Give it room for a full
      // batch's entity list; callers with bigger payloads (propose_corrections) raise it.
      { messages, max_tokens: maxTokens },
      aiGateway(deps.gatewayId, deps.tenantId),
    )) as LlamaGenOutput
    const out = res.response
    return typeof out === "string" && out.length > 0 ? out : null
  } catch (err) {
    console.error("genExtract failed", err)
    return null
  }
}

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
): Promise<string | null> => {
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
    }).catch(() => null)
  }
  try {
    const res = (await deps.ai.run(
      EXTRACT_MODEL,
      { messages, response_format: { type: "json_object" } },
      aiGateway(deps.gatewayId, deps.tenantId),
    )) as LlamaGenOutput
    const out = res.response
    return typeof out === "string" && out.length > 0 ? out : null
  } catch {
    return null
  }
}

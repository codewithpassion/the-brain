/**
 * `gen()` chokepoint over llama-3.3-70b (PRD §5.5, invariants 14, 16).
 *
 * READ path only: NEVER throws (invariant 14). On any failure (missing binding, empty
 * output, thrown AI error) returns `null` so `think` degrades to evidence-without-
 * synthesis. The token-budget-guarded prompt PACKING (`buildSynthesisPrompt`) is the
 * Phase-2 retrieval pipeline; this chokepoint is just the guarded model call.
 */
import { GENERATION_MODEL } from "@brain/shared"
import { type AiDeps, aiGateway } from "./gateway"

interface LlamaGenOutput {
  response?: string
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
  const messages = system
    ? [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ]
    : [{ role: "user", content: prompt }]
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

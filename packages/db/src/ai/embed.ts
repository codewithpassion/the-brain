/**
 * `embed()` chokepoint over bge-m3 (PRD §5.1, invariants 12, 14, 16).
 *
 * bge-m3 is LOCKED to 1024d. A dim mismatch is REFUSED (invariant 12) — a silent model
 * swap that changes dims is a P0, so we refuse rather than poison the index. Two variants:
 *   - READ path `embed()` — NEVER throws (invariant 14); returns `null` so the caller
 *     degrades to keyword-only. Covers missing binding, oversized input, dim mismatch.
 *   - WRITE/index path `embedForIndex()` — THROWS on any failure so the Workflow step
 *     retries; we never index un-embedded chunks (invariant 14).
 */
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "@brain/shared"
import { type AiDeps, aiGateway } from "./gateway"

/** bge-m3's documented context window; guard cheaply before burning an AI call. */
const MAX_EMBED_INPUT_TOKENS = 60_000
/** Rough BPE heuristic — set the guard from the model window, not a stale literal. */
const CHARS_PER_TOKEN = 4

interface BgeEmbedOutput {
  data?: number[][]
}

const exceedsWindow = (texts: string[]): boolean =>
  texts.some((text) => Math.ceil(text.length / CHARS_PER_TOKEN) > MAX_EMBED_INPUT_TOKENS)

/** Run bge-m3 and validate count + 1024-dim on EVERY row. `null` = refuse/degrade. */
const runEmbed = async (deps: AiDeps, texts: string[]): Promise<number[][] | null> => {
  const res = (await deps.ai.run(
    EMBEDDING_MODEL,
    { text: texts },
    aiGateway(deps.gatewayId, deps.tenantId),
  )) as BgeEmbedOutput
  const data = res.data
  if (!data || data.length !== texts.length) return null
  if (data.some((row) => row.length !== EMBEDDING_DIMS)) return null
  return data
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
 * is never indexed un-embedded or at the wrong dimension.
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

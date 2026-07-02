/**
 * Concrete `SearchDeps` ports composed from the tenant-scoped `ScopedServices` (PRD §5, §7).
 * Lifted into `@brain/db` (from the former apps/api copy) so EVERY surface — REST, tRPC,
 * MCP — binds the same enforcing cost cap + recall-trace + spend-attribution logic without
 * drifting copies (the op-registry's "cannot drift" guarantee extends to the deps wiring).
 *
 *   - `BudgetPort`  — the ENFORCING cost cap (invariant 16): reads the tenant's `token_spend`
 *                     for the current window and THROWS a 429 (`CostCeilingError`) BEFORE any
 *                     `embed()`/`gen()` AI call.
 *   - `RecallSink`  — recall-trace writes dispatched OFF the synchronous read path via the
 *                     caller's `waitUntil` (invariant 10), so the response never blocks.
 *   - spend ATTRIBUTION (`recordThinkSpend`) — a coarse neuron estimate, also off the read
 *                     path, enough to keep the running window total (and thus the 429) meaningful.
 *
 * `CostCeilingError` carries `status = 429` so a surface's error mapper (Hono `onError`,
 * tRPC `TRPCError`) maps it without importing an app-level error type.
 */
import { GENERATION_MODEL, MONTHLY_COST_CEILING_USD } from "@brain/shared"
import type { ScopedServices } from "../services"
import type { BudgetPort, RecallSink, RecallTraceBatch, ThinkResult } from "./types"

/** Thrown by the budget pre-check when the monthly cost ceiling is reached (HTTP 429). */
export class CostCeilingError extends Error {
  readonly status = 429 as const
  constructor(message: string) {
    super(message)
    this.name = "CostCeilingError"
  }
}

/** Cloudflare Workers AI neuron price (v1 published rate): $0.011 per 1,000 neurons. */
export const USD_PER_NEURON = 0.011 / 1000
/** The monthly cost ceiling expressed in neurons — the 429 pre-check trips at/above this. */
export const MONTHLY_NEURON_CEILING = MONTHLY_COST_CEILING_USD / USD_PER_NEURON
/** ~4 chars/token (§4.3); coarse synthesis neuron factor for v1 attribution only. */
const CHARS_PER_TOKEN = 4
const GEN_NEURONS_PER_TOKEN = 0.4

/** Coarse generation-neuron estimate from a char count (the ONE v1 attribution formula for gen). */
export const estimateGenNeurons = (chars: number): number =>
  Math.ceil(chars / CHARS_PER_TOKEN) * GEN_NEURONS_PER_TOKEN

/**
 * Coarse EMBED-neuron estimate (bge-m3: ~1 token/4 chars, ~1 neuron/token) — mirrors the backfill
 * re-embed estimate so embed attribution is consistent across the codebase. Distinct from gen:
 * embeddings have no per-token generation factor.
 */
export const estimateEmbedNeurons = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

/** Current monthly spend window key, e.g. `'2026-06'` (UTC). */
export const monthlyWindow = (now: Date = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`

/**
 * Build the enforcing `BudgetPort`. `check()` reads the window's spend and 429s when it has
 * reached the ceiling — runs BEFORE any AI call inside the search pipeline (invariant 16).
 */
export const makeBudgetPort = (
  services: ScopedServices,
  window: string = monthlyWindow(),
): BudgetPort => ({
  async check(): Promise<void> {
    const neurons = await services.db.readWindowSpendNeurons(window)
    if (neurons >= MONTHLY_NEURON_CEILING) {
      throw new CostCeilingError(
        `monthly cost ceiling reached ($${MONTHLY_COST_CEILING_USD}); try again next window`,
      )
    }
  },
})

/**
 * Build the `RecallSink`. `append()` maps kept hits to recall traces (the author `user_id` /
 * `tenant_id` are forced inside `ScopedDB`) and dispatches the durable write on `waitUntil` —
 * the handler `await`s `append` but it resolves immediately (invariant 10).
 */
export const makeRecallSink = (
  services: ScopedServices,
  waitUntil: (promise: Promise<unknown>) => void,
  clientId: string,
): RecallSink => ({
  async append(batch: RecallTraceBatch): Promise<void> {
    if (batch.hits.length === 0) return
    const traces = batch.hits.map((hit) => ({
      query: batch.query,
      targetId: hit.chunkId,
      score: hit.score,
      clientId,
    }))
    waitUntil(services.db.appendRecallTraces(traces))
  },
})

/**
 * Record a coarse synthesis spend estimate (attribution, off the read path). Returns the neurons
 * recorded so a caller (e.g. the Dream reflection loop) can charge them against its own budget
 * slice. `surface` attributes the spend (`'think'` for user reads, `'dream'` for reflection).
 */
export const recordThinkSpend = async (
  services: ScopedServices,
  out: ThinkResult,
  window: string = monthlyWindow(),
  surface = "think",
): Promise<number> => {
  const chars = out.answer.length + out.evidence.reduce((sum, hit) => sum + hit.snippet.length, 0)
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN)
  const neurons = estimateGenNeurons(chars)
  await services.db.recordSpend({
    window,
    model: GENERATION_MODEL,
    surface,
    outputTokens: tokens,
    neurons,
  })
  return neurons
}

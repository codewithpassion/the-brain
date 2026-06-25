/**
 * Concrete `SearchDeps` ports wired from the tenant-scoped `ScopedServices` (PRD §5, §7).
 *
 *   - `BudgetPort`  — the ENFORCING cost cap (invariant 16): reads the tenant's `token_spend`
 *                     for the current window and THROWS a 429 BEFORE any `embed()`/`gen()`.
 *   - `RecallSink`  — recall-trace writes the WORKER dispatches OFF the synchronous read path
 *                     via `ctx.waitUntil` (invariant 10), so the response never blocks on the
 *                     durable D1 write.
 *   - `AiPort`      — `ScopedServices.ai` structurally satisfies it (read-path embed/gen/rerank).
 *
 * Spend ATTRIBUTION (`recordThinkSpend`) is also dispatched off the read path. v1 records a
 * coarse neuron ESTIMATE (Workers AI is billed in neurons; we have no per-call usage on the
 * read path), enough to make the running window total — and thus the 429 cap — meaningful.
 */
import type {
  BudgetPort,
  RecallSink,
  RecallTraceBatch,
  ScopedServices,
  ThinkResult,
} from "@brain/db"
import { GENERATION_MODEL, MONTHLY_COST_CEILING_USD } from "@brain/shared"
import { HttpError } from "./http"

/** Cloudflare Workers AI neuron price (v1 published rate): $0.011 per 1,000 neurons. */
export const USD_PER_NEURON = 0.011 / 1000
/** The monthly cost ceiling expressed in neurons — the 429 pre-check trips at/above this. */
export const MONTHLY_NEURON_CEILING = MONTHLY_COST_CEILING_USD / USD_PER_NEURON
/** ~4 chars/token (§4.3); coarse synthesis neuron factor for v1 attribution only. */
const CHARS_PER_TOKEN = 4
const GEN_NEURONS_PER_TOKEN = 0.4

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
      throw new HttpError(
        429,
        `monthly cost ceiling reached ($${MONTHLY_COST_CEILING_USD}); try again next window`,
      )
    }
  },
})

/**
 * Build the `RecallSink`. `append()` maps kept hits to `RecallTraceInput`s (the trace author
 * `user_id`/`tenant_id` are forced inside `ScopedDB`) and dispatches the durable write on
 * `waitUntil` — the handler `await`s `append` but it resolves immediately (invariant 10).
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

/** Record a coarse synthesis spend estimate (attribution, off the read path). */
export const recordThinkSpend = (
  services: ScopedServices,
  out: ThinkResult,
  window: string = monthlyWindow(),
): Promise<void> => {
  const chars = out.answer.length + out.evidence.reduce((sum, hit) => sum + hit.snippet.length, 0)
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN)
  return services.db.recordSpend({
    window,
    model: GENERATION_MODEL,
    surface: "think",
    outputTokens: tokens,
    neurons: tokens * GEN_NEURONS_PER_TOKEN,
  })
}

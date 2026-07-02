/**
 * `runDreamJob` — the ONE run-FSM driver both consolidation (D1) and reflection (D2) share, so the
 * two can't drift (they had already diverged on lost-claim handling). It owns the whole lifecycle:
 * same-day no-op on `success`, claim-by-changed-rows (never re-read), resume from a `paused`/
 * `failure` row, the budget slice (min 10% of the remaining monthly ceiling, `maxNeurons`), the
 * resumable `cursor`, and the terminal `paused`/`success`/`failure` flips.
 *
 * The caller parameterizes it with `selectItems`/`itemKey`/`processItem` — the driver never knows
 * what a cluster or a target is. `processItem` records its OWN `surface='dream'` spend and returns
 * the neurons it spent (for the budget threshold) + a stats delta + an optional payload id.
 */
import { CostCeilingError, MONTHLY_NEURON_CEILING } from "../search/ports"
import {
  CLAIMABLE_FROM,
  type DreamRunStats,
  type DreamRunStatus,
  type DreamRunStore,
  ZERO_DREAM_STATS,
} from "./runs"

/** What `processItem` returns for one item. */
export interface ProcessResult {
  /** Neurons this item spent — charged against the run's budget slice (processItem records spend). */
  neurons: number
  /** The stats counters this item advanced (folded into the run's rolling `DreamRunStats`). */
  statsDelta: Partial<DreamRunStats>
  /** An optional produced id (e.g. an insight document id) collected into `payloads`. */
  payload?: string | null
}

export interface DreamJobResult {
  runId: string
  status: DreamRunStatus
  noop: boolean
  resumed: boolean
  stats: DreamRunStats
  /** Items left unprocessed when the run stopped on budget (0 on clean completion). */
  itemsRemaining: number
  /** Non-null payloads produced this run (in processing order). */
  payloads: string[]
}

export interface DreamJobSpec<Item> {
  runId: string
  kind: "consolidation" | "reflection"
  /** Per-run neuron cap; effective threshold = min(10% remaining ceiling, this). */
  maxNeurons?: number
  /** The window's spend so far (neurons) — read once, before selection (finding: budget-first). */
  windowSpentNeurons: () => Promise<number>
  /** Select the run's work items (deterministic order). Not called when the budget is exhausted. */
  selectItems: () => Promise<Item[]>
  /** The item's stable ordering key (== the resume cursor value). */
  itemKey: (item: Item) => string
  /** Process one item; records its own spend, returns neurons + stats delta + optional payload. */
  processItem: (item: Item) => Promise<ProcessResult>
}

/** Drive one dream run through its FSM. See the module doc for the model. */
export const runDreamJob = async <Item>(
  runs: DreamRunStore,
  spec: DreamJobSpec<Item>,
): Promise<DreamJobResult> => {
  const { runId, kind } = spec
  const existing = await runs.get(runId)
  const existingStatus = (existing?.status ?? null) as DreamRunStatus | null

  const noopResult = (status: DreamRunStatus): DreamJobResult => ({
    runId,
    status,
    noop: true,
    resumed: false,
    stats: existing?.stats ?? { ...ZERO_DREAM_STATS },
    itemsRemaining: 0,
    payloads: [],
  })

  // Same-day no-op keys off `success` ONLY (terminal, cursor null). `running`/`cancelled` aren't claimable.
  if (existingStatus === "success") return noopResult("success")
  if (existingStatus !== null && !CLAIMABLE_FROM.includes(existingStatus)) {
    return noopResult(existingStatus)
  }

  if (existing === null) await runs.createRun({ id: runId, kind })
  if (!(await runs.claim(runId, existingStatus ?? "queued"))) {
    // Lost the claim race (another worker flipped it to running first) → no-op.
    return noopResult(((await runs.get(runId))?.status ?? "running") as DreamRunStatus)
  }

  const resumeCursor = existing?.cursor ?? null
  const resumed = existingStatus === "paused" || existingStatus === "failure"
  const stats: DreamRunStats = { ...(existing?.stats ?? ZERO_DREAM_STATS) }
  const payloads: string[] = []

  try {
    const spent = await spec.windowSpentNeurons()
    const threshold = Math.min(
      Math.max(0, MONTHLY_NEURON_CEILING - spent) * 0.1,
      spec.maxNeurons ?? Number.POSITIVE_INFINITY,
    )
    // Budget-first: if the slice is already spent, pause WITHOUT the expensive selection scan.
    if (threshold <= 0) {
      await runs.persistProgress(runId, resumeCursor, stats)
      await runs.finishRun(runId, "paused")
      return { runId, status: "paused", noop: false, resumed, stats, itemsRemaining: 0, payloads }
    }

    const items = await spec.selectItems()
    const pending =
      resumeCursor === null ? items : items.filter((i) => spec.itemKey(i) > resumeCursor)

    let runNeurons = 0
    let lastKey = resumeCursor
    let processed = 0
    let stopped = false
    for (const item of pending) {
      if (runNeurons >= threshold) {
        stopped = true
        break
      }
      let result: ProcessResult
      try {
        result = await spec.processItem(item)
      } catch (err) {
        // The monthly ceiling (hard 429) mid-item → stop cleanly as a resumable budget pause.
        if (err instanceof CostCeilingError) {
          stopped = true
          break
        }
        throw err
      }
      runNeurons += result.neurons
      for (const [key, delta] of Object.entries(result.statsDelta)) {
        const k = key as keyof DreamRunStats
        stats[k] += delta ?? 0
      }
      if (result.payload) payloads.push(result.payload)
      lastKey = spec.itemKey(item)
      processed += 1
      await runs.persistProgress(runId, lastKey, stats)
    }

    const itemsRemaining = pending.length - processed
    if (stopped) {
      await runs.persistProgress(runId, lastKey, stats)
      await runs.finishRun(runId, "paused")
      return { runId, status: "paused", noop: false, resumed, stats, itemsRemaining, payloads }
    }
    await runs.persistProgress(runId, null, stats)
    await runs.finishRun(runId, "success")
    return { runId, status: "success", noop: false, resumed, stats, itemsRemaining: 0, payloads }
  } catch (err) {
    await runs.finishRun(runId, "failure", err instanceof Error ? err.message : String(err))
    throw err
  }
}

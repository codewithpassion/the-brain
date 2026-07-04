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
  /** Items left unprocessed when the run stopped (0 on clean completion). */
  itemsRemaining: number
  /**
   * Why the run stopped, when `status='paused'`. `'budget'` = the monthly neuron slice is spent →
   * stop for the night. `'page'` = the per-invocation item cap was hit but budget is fine → the
   * workflow should re-invoke to continue THIS sweep. `null` on clean completion / noop.
   */
  stopReason: "budget" | "page" | null
  /** Non-null payloads produced this run (in processing order). */
  payloads: string[]
}

export interface DreamJobSpec<Item> {
  runId: string
  kind: "consolidation" | "reflection" | "dedup" | "hygiene" | "entitypages"
  /** Per-run neuron cap; effective threshold = min(10% remaining ceiling, this). */
  maxNeurons?: number
  /** The window's spend so far (neurons) — read once, before selection (finding: budget-first). */
  windowSpentNeurons: () => Promise<number>
  /**
   * Select work items in deterministic (id-ascending) order. `cursor` is the resume point:
   * NON-paged kinds ignore it and return the full set (the driver filters by cursor); a PAGED kind
   * (`pageSize` set) returns only `id > cursor` up to `pageSize` and the driver loops pages.
   * Not called when the budget is already exhausted.
   */
  selectItems: (cursor: string | null) => Promise<Item[]>
  /** The item's stable ordering key (== the resume cursor value). */
  itemKey: (item: Item) => string
  /** Process one item; records its own spend, returns neurons + stats delta + optional payload. */
  processItem: (item: Item) => Promise<ProcessResult>
  /**
   * When set, the driver PAGES: it re-calls `selectItems(cursor)` (each returns ≤ `pageSize` rows
   * WHERE id > cursor) until a page comes back short — killing both the fixed-tail blindness and the
   * full-snapshot re-read on resume. Unset → single-shot (the original behavior, other kinds).
   */
  pageSize?: number
  /**
   * Cap on items processed in ONE invocation (subrequest-cap guard for the workflow's step loop).
   * On hit, the run pauses with `stopReason='page'` so the caller re-invokes to continue. Unset →
   * process until budget/exhaustion. Only meaningful with `pageSize`.
   */
  maxItemsPerInvocation?: number
  /** Persist progress (cursor + stats) every N processed items (default 1 → after each). */
  persistEvery?: number
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
    stopReason: null,
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
      return {
        runId,
        status: "paused",
        noop: false,
        resumed,
        stats,
        itemsRemaining: 0,
        stopReason: "budget",
        payloads,
      }
    }

    const persistEvery = Math.max(1, spec.persistEvery ?? 1)
    let runNeurons = 0
    let lastKey = resumeCursor
    let processed = 0
    let stopReason: "budget" | "page" | null = null
    // Best-effort count of items known to remain when we stopped (a lower bound in the paged path).
    let itemsRemaining = 0

    // Fold one item's result into the rolling stats/spend/cursor. Returns false if the loop must
    // stop (budget spent or ceiling 429); the caller sets `stopReason`.
    const runItem = async (item: Item): Promise<boolean> => {
      let result: ProcessResult
      try {
        result = await spec.processItem(item)
      } catch (err) {
        if (err instanceof CostCeilingError) return false // hard 429 mid-item → resumable pause
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
      if (processed % persistEvery === 0) await runs.persistProgress(runId, lastKey, stats)
      return true
    }

    if (spec.pageSize !== undefined) {
      // ── PAGED path (dedup): loop pages (id > cursor) until a short page (done) or a stop. ──
      let cursor = resumeCursor
      paging: while (true) {
        const page = await spec.selectItems(cursor)
        if (page.length === 0) break // exhausted → success
        for (let i = 0; i < page.length; i++) {
          const item = page[i] as Item
          if (runNeurons >= threshold) {
            stopReason = "budget"
            itemsRemaining = page.length - i // ≥1 unprocessed in this page (more pages may follow)
            break paging
          }
          if (spec.maxItemsPerInvocation !== undefined && processed >= spec.maxItemsPerInvocation) {
            stopReason = "page"
            itemsRemaining = page.length - i // ≥1 more; the workflow loops on 'page' regardless
            break paging
          }
          if (!(await runItem(item))) {
            stopReason = "budget"
            itemsRemaining = page.length - i
            break paging
          }
          cursor = spec.itemKey(item)
        }
        if (page.length < spec.pageSize) break // last (short) page → success
      }
    } else {
      // ── SINGLE-SHOT path (consolidation/reflection): full set, driver-filtered by cursor. ──
      const items = await spec.selectItems(resumeCursor)
      const pending =
        resumeCursor === null ? items : items.filter((i) => spec.itemKey(i) > resumeCursor)
      for (const item of pending) {
        if (runNeurons >= threshold) {
          stopReason = "budget"
          break
        }
        if (!(await runItem(item))) {
          stopReason = "budget"
          break
        }
      }
      itemsRemaining = stopReason ? pending.length - processed : 0
    }

    if (stopReason) {
      await runs.persistProgress(runId, lastKey, stats)
      await runs.finishRun(runId, "paused")
      return {
        runId,
        status: "paused",
        noop: false,
        resumed,
        stats,
        itemsRemaining,
        stopReason,
        payloads,
      }
    }
    await runs.persistProgress(runId, null, stats)
    await runs.finishRun(runId, "success")
    return {
      runId,
      status: "success",
      noop: false,
      resumed,
      stats,
      itemsRemaining: 0,
      stopReason: null,
      payloads,
    }
  } catch (err) {
    await runs.finishRun(runId, "failure", err instanceof Error ? err.message : String(err))
    throw err
  }
}

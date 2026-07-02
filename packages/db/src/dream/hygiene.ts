/**
 * `runDreamHygiene` (v2 W1/D5) — the LLM-FREE memory-hygiene sweep: confidence DECAY of stale facts
 * and NOTABILITY boost of frequently-recalled ones, over the shared `runDreamJob` FSM
 * (kind='hygiene'). It is the cheapest dream step — pure SQL over existing columns, ZERO neuron
 * spend — so it runs every night as part of `all` (and standalone via `dream_now kind='hygiene'`).
 *
 * SIGNAL: `memory_recall_traces`. The `recall` op writes one trace per returned fact
 * (`target_id = String(fact.id)`); content/think recall writes chunk-UUID traces — no collision with
 * integer fact ids. "recalled" here therefore means "surfaced via the `recall` op" (get_session_context
 * does NOT emit traces — documented limitation; its session-scoped facts are protected by the
 * created-age guard and the lineage reveal).
 *
 * DECAY: a fact unrecalled for `UNRECALLED_DAYS`, older than that (a fresh fact hasn't had time to be
 * recalled), and uncorroborated (no sibling active fact with the same entity_slug+kind) is stepped
 * ×`DECAY_FACTOR`; below `CONFIDENCE_FLOOR` it is SOFT-expired (`valid_until` — reversible, distinct
 * from the `expired_at` hard-forget; the active-fact filter now honors it, wired repo-wide in D5).
 * Dream-generated facts decay too (hygiene is graph maintenance, not content generation — D-i2 does
 * NOT apply). BOOST: a fact recalled ≥`BOOST_TO_MEDIUM`/`BOOST_TO_HIGH` times in the window is raised
 * (raise-only). The whole pass is ONE budgeted FSM item (no paging needed — bulk SQL UPDATEs).
 */

import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import type { ScopedDB } from "../scoped/db"
import { createScopedServices } from "../services"
import { runDreamJob } from "./job"
import { hygieneRunId } from "./plan"
import { dreamRunId } from "./run"
import { type DreamRunStats, type DreamRunStatus, DreamRunStore } from "./runs"

/** Days a fact may go unrecalled (and must be older than) before it starts to decay. */
const UNRECALLED_DAYS = 30
/** Multiplier applied to a stale fact's confidence each run. */
const DECAY_FACTOR = 0.9
/** Below this decayed confidence a fact is soft-expired (`valid_until` set). */
const CONFIDENCE_FLOOR = 0.3
/** Recall-count window (days) for the notability boost. */
const NOTABILITY_WINDOW_DAYS = 30
/** Recalls in the window to raise `low → medium`. */
const BOOST_TO_MEDIUM = 2
/** Recalls in the window to raise (any lower tier) → `high`. */
const BOOST_TO_HIGH = 5
/** Cap on per-fact ids+priors recorded in the audit diff (full lists can be unbounded). */
const AUDIT_SAMPLE_CAP = 200

const DAY_MS = 86_400_000

/** The tenant-scoped bundle the hygiene sweep needs (built by `createDreamHygieneServices`). */
export interface DreamHygieneServices {
  db: ScopedDB
  runs: DreamRunStore
  principal: Principal
}

export interface DreamHygieneOptions {
  runId?: string
}

export interface DreamHygieneResult {
  runId: string
  status: DreamRunStatus
  noop: boolean
  resumed: boolean
  stats: DreamRunStats
}

/** A single-item sweep marker (hygiene is one bulk-SQL pass, not a per-item loop). */
const HYGIENE_ITEM = "hygiene" as const

/** Run one memory-hygiene sweep (decay + notability) over the shared FSM driver. */
export const runDreamHygiene = async (
  services: DreamHygieneServices,
  opts?: DreamHygieneOptions,
): Promise<DreamHygieneResult> => {
  const now = new Date().toISOString()
  const runId = opts?.runId ?? hygieneRunId(dreamRunId(services.principal.tenantId, new Date(now)))
  const nowMs = Date.parse(now)
  const createdCutoff = new Date(nowMs - UNRECALLED_DAYS * DAY_MS).toISOString()
  const recallCutoffMs = nowMs - UNRECALLED_DAYS * DAY_MS
  const windowCutoffMs = nowMs - NOTABILITY_WINDOW_DAYS * DAY_MS
  const { db } = services

  const result = await runDreamJob(services.runs, {
    runId,
    kind: "hygiene",
    windowSpentNeurons: () => Promise.resolve(0), // LLM-free; the budget slice is irrelevant
    selectItems: () => Promise.resolve([HYGIENE_ITEM]), // one bulk-SQL pass
    itemKey: () => HYGIENE_ITEM,
    processItem: async () => {
      // The whole sweep is ONE id-first atomic batch (decay + soft-expire + boost + audit).
      const swept = await db.hygieneSweep({
        now,
        createdCutoff,
        recallCutoffMs,
        windowCutoffMs,
        decayFactor: DECAY_FACTOR,
        floor: CONFIDENCE_FLOOR,
        toMedium: BOOST_TO_MEDIUM,
        toHigh: BOOST_TO_HIGH,
        auditCap: AUDIT_SAMPLE_CAP,
      })
      return {
        neurons: 0,
        statsDelta: {
          factsDecayed: swept.decayed,
          factsSoftExpired: swept.softExpired,
          factsBoosted: swept.boosted,
        },
        payload: null,
      }
    },
  })

  return {
    runId: result.runId,
    status: result.status,
    noop: result.noop,
    resumed: result.resumed,
    stats: result.stats,
  }
}

/**
 * `createDreamHygieneServices(env, principal)` — the hygiene bundle: the scoped DB (facts + recall
 * traces) + the `dream_runs` store. Raw `drizzle(env.DB)` here is legal (packages/db, invariant 2).
 */
export const createDreamHygieneServices = (
  env: BrainBindings,
  principal: Principal,
): DreamHygieneServices => ({
  db: createScopedServices(env, principal).db,
  runs: new DreamRunStore(drizzle(env.DB), principal),
  principal,
})

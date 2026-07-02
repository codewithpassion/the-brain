/**
 * `runDreamDedup` (v2 W1/D4) — the cross-session entity dedup sweep: fold near-duplicate entities
 * ("Cloudflare Workers" / "CF Workers") into one, over the shared `runDreamJob` FSM (kind='dedup',
 * budgeted, resumable, CURSOR-PAGED). Reuses the entity Vectorize arm + `recheckEntities` D1 re-check
 * that `graph/dedup.ts` uses for NEW entities, and ADDS a `gen()` same-entity confirmation step (the
 * new-entity path has no LLM confirm — it trusts the deterministic key / cosine floor; a sweep over
 * the EXISTING set is more consequential, so every candidate pair is model-confirmed here).
 *
 * PAGING (D4 item 5): `selectItems(cursor)` returns one id-ordered page WHERE id > cursor; the FSM
 * loops pages until one is short — no fixed-tail truncation, no full-snapshot re-read on resume. The
 * cursor is the last entity id. `maxItemsPerInvocation` (item 7e) caps ONE invocation so the workflow
 * can chunk the sweep across `step.do` calls under the subrequest cap; that stop is `stopReason='page'`
 * (the workflow re-invokes), distinct from a `'budget'` stop (stop for the night).
 *
 * ISOLATION (D-i4): candidate ids from the Vectorize arm pass the mandatory `recheckEntities` D1
 * re-check (tenant + scope + `{world,team}` visibility, merged losers dropped) — a cross-tenant id is
 * dropped, never merged. We additionally require SAME kind AND SAME scope (asserted before the merge).
 * The merge itself (re-point mentions/relations + fold aliases + soft-delete loser + rich audit) is
 * ONE `db.batch` in `mergeEntities`. D-i5: the loser is SOFT-deleted (`merged_into`), never hard-
 * deleted — reversible from the audit diff. Dedup is graph hygiene, not content generation, so the
 * D-i2 depth rules do NOT apply (it operates on the graph regardless of `origin`).
 *
 * COST (items 7a/8): a page's entities reuse their STORED vector (`getByIds`) when it is current
 * (`embedded_at` set and not older than `updated_at`); only missing/stale ones are re-embedded. Embed
 * spend is attributed to `EMBEDDING_MODEL`, gen-confirm spend to `EXTRACT_MODEL`, and both flow into
 * the run's `stats.neurons` so the run row shows real cost.
 */

import type { Principal } from "@brain/shared"
import {
  clampConfidence,
  EMBEDDING_MODEL,
  EXTRACT_MODEL,
  extractJsonCandidates,
  RELATED_FLOOR,
} from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import type { DedupEntity, ScopedGraph } from "../graph/scoped-graph"
import type { ScopedDB } from "../scoped/db"
import type { ScopedVectorize } from "../scoped/vectorize"
import { estimateEmbedNeurons, estimateGenNeurons, monthlyWindow } from "../search/ports"
import { createScopedServices, type ScopedServices } from "../services"
import { runDreamJob } from "./job"
import { dedupRunId } from "./plan"
import { dreamRunId } from "./run"
import { type DreamRunStats, type DreamRunStatus, DreamRunStore } from "./runs"

/** How many nearest neighbors to consider per entity. */
const DEDUP_TOPK = 5
/** DB page size for the cursored sweep (item 5). */
const DEDUP_PAGE_SIZE = 500
/** Cap of stranded loser vectors reconciled at sweep start (item 6). */
const RECONCILE_LIMIT = 1000

/** The tenant-scoped bundle the dedup sweep needs (built by `createDreamDedupServices`). */
export interface DreamDedupServices {
  db: ScopedDB
  graph: ScopedGraph
  entityVectors: ScopedVectorize
  ai: Pick<ScopedServices["ai"], "embed" | "gen">
  runs: DreamRunStore
  principal: Principal
}

export interface DreamDedupOptions {
  runId?: string
  maxNeurons?: number
  now?: string
  /** Cap items processed in ONE invocation (workflow step-chunking under the subrequest cap). */
  maxItemsPerInvocation?: number
  /** Override the DB page size (tests). */
  pageSize?: number
}

export interface DreamDedupResult {
  runId: string
  status: DreamRunStatus
  noop: boolean
  resumed: boolean
  stats: DreamRunStats
  entitiesRemaining: number
  /** Why the run stopped when paused: `'page'` → workflow should re-invoke; `'budget'` → stop. */
  stopReason: "budget" | "page" | null
}

interface SameEntityVerdict {
  same: boolean
  confidence: number
  rationale: string
}

/** Minimal shape both endpoints expose for deterministic winner selection. */
type WinnerFields = Pick<DedupEntity, "id" | "scope" | "mentionCount" | "createdAt">
/** Minimal shape the gen prompt renders. */
type DescribeFields = Pick<DedupEntity, "name" | "description" | "kind">

const SAME_ENTITY_SYSTEM =
  "You judge whether two extracted knowledge-graph entities refer to the SAME real-world thing. " +
  'Reply with ONE JSON object only: {"same":boolean,"confidence":0..1,"rationale":string}.'

const describeEntity = (e: DescribeFields, label: string): string =>
  `Entity ${label}: kind=${e.kind}; name="${e.name}"; description="${e.description}"`

/** Salvage-parse a same-entity verdict (null when unparseable → treat as not-same). */
const parseVerdict = (raw: string): SameEntityVerdict | null => {
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const p = JSON.parse(candidate) as Record<string, unknown>
      if (!p || typeof p !== "object") continue
      return {
        same: p.same === true,
        confidence: clampConfidence(p.confidence),
        rationale: typeof p.rationale === "string" ? p.rationale : "",
      }
    } catch {
      // try the next salvage strategy
    }
  }
  return null
}

/** Winner = more mentions; tie → older createdAt; tie → smaller id (full determinism). */
const pickWinner = (
  a: WinnerFields,
  b: WinnerFields,
): { winner: WinnerFields; loser: WinnerFields } => {
  const aWins =
    a.mentionCount !== b.mentionCount
      ? a.mentionCount > b.mentionCount
      : a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
        : a.id < b.id
  return aWins ? { winner: a, loser: b } : { winner: b, loser: a }
}

/** An unordered pair key so a pair is examined once per invocation regardless of discovery side. */
const pairKey = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`)

/** Run one entity-dedup sweep over the shared FSM driver. */
export const runDreamDedup = async (
  services: DreamDedupServices,
  opts?: DreamDedupOptions,
): Promise<DreamDedupResult> => {
  const now = opts?.now ?? new Date().toISOString()
  const runId = opts?.runId ?? dedupRunId(dreamRunId(services.principal.tenantId, new Date(now)))
  const window = monthlyWindow(new Date(now))
  const { graph, entityVectors, ai, db } = services
  const pageSize = opts?.pageSize ?? DEDUP_PAGE_SIZE

  // ── Item 6: sweep-start vector reconciliation (only on a FRESH start, not a resume/continue). ──
  // Self-heals a failed best-effort per-merge vector delete so a stranded loser vector can't keep
  // resurfacing as a candidate. Gated on `cursor === null` so it runs once, not per page-step.
  const existingRun = await services.runs.get(runId)
  const freshStart =
    existingRun === null ||
    (existingRun.cursor === null &&
      existingRun.status !== "success" &&
      existingRun.status !== "running")
  if (freshStart) {
    try {
      const stranded = await graph.listMergedLoserIds(RECONCILE_LIMIT)
      if (stranded.length > 0) await entityVectors.deleteVectors(stranded)
    } catch {
      // non-fatal: reconciliation is an optimization; the merged_into gate keeps losers hidden
    }
  }

  // Per-INVOCATION work-dedup + staleness state (NOT the safety mechanism — see the module doc):
  // `examinedPairs` skips a repeat gen-confirm of the same unordered pair; `mergedThisRun` skips an
  // entity already folded away this invocation. Both reset on resume/next step; correctness there
  // rests on `merged_into` (recheck drops it) + the fresh per-item self-read staleness guard.
  const examinedPairs = new Set<string>()
  const mergedThisRun = new Set<string>()

  const result = await runDreamJob(services.runs, {
    runId,
    kind: "dedup",
    ...(opts?.maxNeurons !== undefined ? { maxNeurons: opts.maxNeurons } : {}),
    ...(opts?.maxItemsPerInvocation !== undefined
      ? { maxItemsPerInvocation: opts.maxItemsPerInvocation }
      : {}),
    pageSize,
    windowSpentNeurons: () => db.readWindowSpendNeurons(window),
    selectItems: (cursor) => graph.listActiveEntitiesForDedup(cursor, pageSize),
    itemKey: (e) => e.id,
    processItem: async (entity) => {
      // Fast pre-check then a fresh self-read: an earlier merge THIS invocation may have folded this
      // entity away (A~B merges B; B later in the same page). The self-read also gives fresh counts.
      if (mergedThisRun.has(entity.id)) {
        return { neurons: 0, statsDelta: { entitiesExamined: 1, skipped: 1 }, payload: null }
      }
      const self = await graph.getEntityForMerge(entity.id)
      if (self === null || self.mergedInto !== null) {
        return { neurons: 0, statsDelta: { entitiesExamined: 1, skipped: 1 }, payload: null }
      }

      let neurons = 0
      const recordEmbed = async (chars: number): Promise<void> => {
        const n = estimateEmbedNeurons(chars)
        neurons += n
        await db.recordSpend({ window, model: EMBEDDING_MODEL, surface: "dream", neurons: n })
      }
      const recordGen = async (chars: number): Promise<void> => {
        const n = estimateGenNeurons(chars)
        neurons += n
        await db.recordSpend({ window, model: EXTRACT_MODEL, surface: "dream", neurons: n })
      }

      // Item 7a: reuse the stored vector when it is current; embed only when missing/stale.
      const stale = self.embeddedAt === null || self.updatedAt > self.embeddedAt
      let embedding: number[] | undefined
      if (!stale) {
        try {
          embedding = (await entityVectors.getByIds([self.id])).get(self.id)
        } catch {
          embedding = undefined
        }
      }
      if (embedding === undefined) {
        const text = `${self.name}\n${self.description}`.trim()
        const vectors = await ai.embed([text])
        await recordEmbed(text.length)
        embedding = vectors?.[0]
      }
      if (embedding === undefined) {
        return {
          neurons,
          statsDelta: { entitiesExamined: 1, skipped: 1, neurons },
          payload: null,
        }
      }

      // Nearest neighbors, scope-partitioned; D1 re-check drops cross-tenant/out-of-scope/merged.
      const scopeFilter = self.scope !== null ? { scope: self.scope } : undefined
      const folded = entityVectors.foldPartitionFilter(scopeFilter)
      const nearest = await entityVectors.query({
        values: embedding,
        topK: DEDUP_TOPK,
        ...(folded !== undefined ? { filter: folded } : {}),
      })
      const candidateIds = nearest
        .filter((m) => m.id !== self.id && m.score >= RELATED_FLOOR)
        .map((m) => m.id)
      const rechecked = await graph.recheckEntities(candidateIds)

      let pairsExamined = 0
      for (const cand of rechecked) {
        if (cand.id === self.id || cand.kind !== self.kind) continue
        if ((cand.scope ?? null) !== (self.scope ?? null)) continue
        if (mergedThisRun.has(cand.id)) continue // already a loser this invocation
        const key = pairKey(self.id, cand.id)
        if (examinedPairs.has(key)) continue // examined once already (work-dedup)
        examinedPairs.add(key)

        pairsExamined += 1
        const verdict = await genConfirm(
          ai,
          { name: self.name, description: self.description, kind: self.kind },
          { name: cand.canonicalName, description: cand.description, kind: cand.kind },
          recordGen,
        )
        if (verdict === null || !verdict.same || verdict.confidence < RELATED_FLOOR) continue

        const candFields: WinnerFields = {
          id: cand.id,
          scope: cand.scope,
          mentionCount: cand.mentionCount,
          createdAt: cand.createdAt,
        }
        const { winner, loser } = pickWinner(self, candFields)
        if ((winner.scope ?? null) !== (loser.scope ?? null)) continue // never merge across scopes
        await graph.mergeEntities(winner.id, loser.id)
        mergedThisRun.add(loser.id)
        // Drop the loser's stale vector so it can't resurface as a future candidate (best-effort).
        try {
          await entityVectors.deleteVectors([loser.id])
        } catch {
          // non-fatal: the loser is hidden by merged_into regardless (+ sweep-start reconciliation)
        }
        return {
          neurons,
          statsDelta: { entitiesExamined: 1, pairsExamined, merged: 1, neurons },
          payload: null,
        }
      }

      return {
        neurons,
        statsDelta: { entitiesExamined: 1, pairsExamined, skipped: 1, neurons },
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
    entitiesRemaining: result.itemsRemaining,
    stopReason: result.stopReason,
  }
}

/** Ask the model whether two entities are the same; records its gen spend under EXTRACT_MODEL. */
const genConfirm = async (
  ai: Pick<ScopedServices["ai"], "gen">,
  a: DescribeFields,
  b: DescribeFields,
  recordGen: (chars: number) => Promise<void>,
): Promise<SameEntityVerdict | null> => {
  const prompt = `${describeEntity(a, "A")}\n${describeEntity(b, "B")}\n\nAre A and B the same real-world entity?`
  const raw = await ai.gen(prompt, SAME_ENTITY_SYSTEM)
  await recordGen(prompt.length + (raw?.length ?? 0))
  return raw === null ? null : parseVerdict(raw)
}

/**
 * `createDreamDedupServices(env, principal)` — the dedup bundle. Reuses the scoped graph + entity
 * vectors + AI (embed/gen) and adds the `dream_runs` store. Raw `drizzle(env.DB)` here is legal
 * (packages/db, invariant 2).
 */
export const createDreamDedupServices = (
  env: BrainBindings,
  principal: Principal,
): DreamDedupServices => {
  const base = createScopedServices(env, principal)
  return {
    db: base.db,
    graph: base.graph,
    entityVectors: base.entityVectors,
    ai: { embed: base.ai.embed, gen: base.ai.gen },
    runs: new DreamRunStore(drizzle(env.DB), principal),
    principal,
  }
}

/**
 * `runDreamEntityPages` (v3/W2) — the entity-page BACKFILL sweep: mint a page for every entity that
 * doesn't have one yet, over the shared `runDreamJob` FSM (kind='entitypages'), cursor-PAGED and
 * `maxItemsPerInvocation`-chunked exactly like the dedup sweep. STANDALONE (not part of nightly
 * `all`) — it's graph hygiene over the whole entity set, run on its own cadence via
 * `dream_now kind='entitypages'`.
 *
 * Each item is `mintOnly` (item 1c): an entity that ALREADY has a page is left untouched, so this
 * never clobbers a reflection-enriched or human-edited body — it only fills the gaps. The mint is
 * LLM-free (body = the entity's name+description), so it spends zero neurons; the run row still
 * carries counts + cursor for resumability. `EntityPageStore` re-derives visibility from the entity
 * (never private), so a minted page inherits the entity's tier.
 */
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { runBatchIngestCore } from "../ingest"
import { syncBackingDoc } from "../pages/backing-doc"
import type { BrainDrizzle } from "../scoped/db"
import { monthlyWindow } from "../search/ports"
import { createScopedServices, type ScopedServices } from "../services"
import { EntityPageStore } from "../wiki/entity-pages"
import { runDreamJob } from "./job"
import { entitypagesRunId } from "./plan"
import { dreamRunId } from "./run"
import { type DreamRunStats, type DreamRunStatus, DreamRunStore } from "./runs"

const ENTITYPAGES_PAGE_SIZE = 500

/**
 * The tenant-scoped bundle the entity-page backfill needs — the FULL `ScopedServices` (for the W3
 * backing-doc sync: blobs/vectors/db/graph) plus the raw handle + run store.
 */
export type DreamEntityPagesServices = ScopedServices & {
  raw: BrainDrizzle
  runs: DreamRunStore
  principal: Principal
}

export interface DreamEntityPagesOptions {
  runId?: string
  maxNeurons?: number
  now?: string
  /** Cap items processed in ONE invocation (workflow step-chunking under the subrequest cap). */
  maxItemsPerInvocation?: number
  /** Override the DB page size (tests). */
  pageSize?: number
}

export interface DreamEntityPagesResult {
  runId: string
  status: DreamRunStatus
  noop: boolean
  resumed: boolean
  stats: DreamRunStats
  entitiesRemaining: number
  stopReason: "budget" | "page" | null
}

/** Run one entity-page backfill sweep over the shared FSM driver. */
export const runDreamEntityPages = async (
  services: DreamEntityPagesServices,
  opts?: DreamEntityPagesOptions,
): Promise<DreamEntityPagesResult> => {
  const now = opts?.now ?? new Date().toISOString()
  const runId =
    opts?.runId ?? entitypagesRunId(dreamRunId(services.principal.tenantId, new Date(now)))
  const window = monthlyWindow(new Date(now))
  const { graph, db, raw, principal } = services
  const pageSize = opts?.pageSize ?? ENTITYPAGES_PAGE_SIZE
  const store = new EntityPageStore(raw, principal)

  const result = await runDreamJob(services.runs, {
    runId,
    kind: "entitypages",
    ...(opts?.maxNeurons !== undefined ? { maxNeurons: opts.maxNeurons } : {}),
    ...(opts?.maxItemsPerInvocation !== undefined
      ? { maxItemsPerInvocation: opts.maxItemsPerInvocation }
      : {}),
    pageSize,
    windowSpentNeurons: () => db.readWindowSpendNeurons(window),
    selectItems: (cursor) => graph.listActiveEntitiesForDedup(cursor, pageSize),
    itemKey: (e) => e.id,
    processItem: async (entity) => {
      const body = `# ${entity.name}\n\n${entity.description}`.trim()
      const res = await store.mintOrUpdate(entity.id, {
        body,
        systemAuthored: true,
        mintOnly: true,
      })
      const minted = res !== null && res.changed
      // W3: a freshly-minted entity page gets a searchable backing doc (KG-skipped agent origin).
      if (minted && res?.pageId != null) {
        await syncBackingDoc(services, res.pageId, (params) =>
          runBatchIngestCore(services, params).then(() => {}),
        )
      }
      return {
        neurons: 0,
        statsDelta: { entitiesExamined: 1, skipped: minted ? 0 : 1 },
        payload: minted ? (res?.pageId ?? null) : null,
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

/** `createDreamEntityPagesServices(env, principal)` — the backfill bundle. Raw handle legal here. */
export const createDreamEntityPagesServices = (
  env: BrainBindings,
  principal: Principal,
): DreamEntityPagesServices => {
  const base = createScopedServices(env, principal)
  const raw = drizzle(env.DB)
  return {
    ...base,
    raw,
    runs: new DreamRunStore(raw, principal),
    principal,
  }
}

/**
 * `runDreamIndexes` (v3/W5) — regenerate the auto-maintained OKF INDEX pages: one `<ns>/index` per
 * world namespace plus the root `index`, over the shared `runDreamJob` FSM (kind='indexes').
 * STANDALONE (not part of nightly `all`) — run on its own cadence via `dream_now kind='indexes'`.
 *
 * LLM-free + deterministic: each index body is a slug-sorted list of world children (title +
 * first-paragraph), byte-identical on regen, so an unchanged namespace no-ops in `PageStore` (no
 * version churn). Leak-safe by construction — `IndexPageStore` reads children through the system
 * principal's `visibilityPredicate` (world only). NO backing doc (navigation, not knowledge).
 */
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import type { BrainDrizzle } from "../scoped/db"
import { monthlyWindow } from "../search/ports"
import { createScopedServices, type ScopedServices } from "../services"
import { IndexPageStore } from "../wiki/index-pages"
import { runDreamJob } from "./job"
import { indexesRunId } from "./plan"
import { dreamRunId, systemPrincipal } from "./run"
import { type DreamRunStats, type DreamRunStatus, DreamRunStore } from "./runs"

/** The tenant-scoped bundle the index sweep needs: db (for window spend) + raw handle + run store. */
export type DreamIndexesServices = ScopedServices & {
  raw: BrainDrizzle
  runs: DreamRunStore
  principal: Principal
}

export interface DreamIndexesOptions {
  runId?: string
  maxNeurons?: number
  now?: string
}

export interface DreamIndexesResult {
  runId: string
  status: DreamRunStatus
  noop: boolean
  resumed: boolean
  stats: DreamRunStats
}

/** Root sentinel — sorts first (empty string) so the root index regenerates before the namespaces. */
const ROOT_ITEM = ""

/** Run one index-regeneration sweep over the shared FSM driver (single-shot: namespaces are few). */
export const runDreamIndexes = async (
  services: DreamIndexesServices,
  opts?: DreamIndexesOptions,
): Promise<DreamIndexesResult> => {
  const now = opts?.now ?? new Date().toISOString()
  const runId = opts?.runId ?? indexesRunId(dreamRunId(services.principal.tenantId, new Date(now)))
  const window = monthlyWindow(new Date(now))
  const { db, raw, principal } = services
  const store = new IndexPageStore(raw, principal)

  // Snapshot the world page set ONCE — the whole sweep (root + every namespace) is built from it, so
  // the run is a single consistent view and namespaces don't re-query per item.
  const worldPages = await store.worldPages()
  const namespaces = store.namespacesOf(worldPages)
  // Deterministic + id-ascending (root's "" sorts first — the FSM cursor contract, though indexes
  // never resumes: no per-item spend → never pauses). KNOWN LIMITATION (low severity): because root
  // regenerates BEFORE the `<ns>/index` pages exist, root's `[[ns/index]]` links don't materialize as
  // doc_links on the first run (recordPending:false), and byte-identical idempotency means they never
  // do later — so the root→ns/index BACKLINK edge never forms. Navigation via rendered links is
  // unaffected (the links still resolve client-side); only the graph edge is absent.
  const items = [ROOT_ITEM, ...namespaces]

  const result = await runDreamJob(services.runs, {
    runId,
    kind: "indexes",
    ...(opts?.maxNeurons !== undefined ? { maxNeurons: opts.maxNeurons } : {}),
    windowSpentNeurons: () => db.readWindowSpendNeurons(window),
    selectItems: () => Promise.resolve(items),
    itemKey: (item) => item,
    processItem: async (item) => {
      const res =
        item === ROOT_ITEM
          ? await store.regenerateRoot(worldPages, namespaces)
          : await store.regenerateNamespace(item, worldPages)
      return {
        neurons: 0,
        statsDelta: { targets: 1, skipped: res.changed ? 0 : 1 },
        payload: res.changed ? res.slug : null,
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
 * `createDreamIndexesServices(env, principal)` — the index sweep bundle. It FORCES a system principal
 * (from the caller's tenant) for every read/write, IGNORING the dispatcher's identity — `indexes` is
 * standalone, so it only ever runs via the `dream_now` admin op under a REAL user principal; without
 * this coercion `worldPages()` would read the caller's own team/private pages and render their
 * titles into a world-visible index (cross-user leak). Raw `drizzle(env.DB)` here is legal (invariant 2).
 */
export const createDreamIndexesServices = (
  env: BrainBindings,
  principal: Principal,
): DreamIndexesServices => {
  const sys = systemPrincipal(principal.tenantId)
  const base = createScopedServices(env, sys)
  const raw = drizzle(env.DB)
  return { ...base, raw, runs: new DreamRunStore(raw, sys), principal: sys }
}

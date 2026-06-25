/**
 * `searchEntities` — entity vector search over `brain-entities` + `entity_fts`, RRF-fused,
 * with the MANDATORY D1 re-check (PRD §6.7 A′, invariants 1, 3, 4).
 *
 * Mirrors the chunk hybrid arm exactly: `ScopedVectorize` (namespace=tenant baked in, scope
 * folded into the metadata filter) gives candidate ids; `entity_fts` gives a keyword arm;
 * the two ranked id lists fuse by RRF — and then EVERY surviving id is re-checked against the
 * live `entities` base table (`recheckEntities`: tenant + scope + `{world,team}` visibility,
 * drop-don't-error). Isolation does NOT rest on the Vectorize namespace; it rests on that
 * re-check, so an adversarial index emitting a cross-tenant entity id can never leak.
 */
import { COSINE_FLOOR, RRF_K } from "@brain/shared"
import type { ScopedVectorize } from "../scoped/vectorize"
import type { AiPort } from "../search/types"
import type { EntityRow, ScopedGraph } from "./scoped-graph"

/** Injected seams for `searchEntities` (decoupled from bindings for deterministic CI). */
export interface EntitySearchDeps {
  graph: ScopedGraph
  entityVectors: ScopedVectorize
  ai: Pick<AiPort, "embed">
}

export interface EntitySearchOptions {
  topK?: number
}

/** One entity hit, built ONLY from a re-checked `entities` row (never a raw match id). */
export interface EntityHit {
  id: string
  name: string
  kind: string
  description: string
  score: number
  scope: string | null
  visibility: string
  teamId: string | null
}

/** RRF over per-arm ranked id lists → fused {id, normalized score}, descending. */
const fuseIdRanks = (arms: string[][], k: number = RRF_K): { id: string; score: number }[] => {
  const raw = new Map<string, number>()
  for (const arm of arms) {
    for (let rank = 0; rank < arm.length; rank++) {
      const id = arm[rank]
      if (id === undefined) continue
      raw.set(id, (raw.get(id) ?? 0) + 1 / (k + rank + 1))
    }
  }
  if (raw.size === 0) return []
  let max = 0
  for (const value of raw.values()) {
    if (value > max) max = value
  }
  return [...raw.entries()]
    .map(([id, value]) => ({ id, score: max > 0 ? value / max : 0 }))
    .sort((a, b) => b.score - a.score)
}

export const searchEntities = async (
  deps: EntitySearchDeps,
  query: string,
  options?: EntitySearchOptions,
): Promise<EntityHit[]> => {
  if (query.length === 0) return []
  const topK = options?.topK ?? 20

  // Vector arm: embed(query) → ScopedVectorize over brain-entities (degrade to [] on failure).
  let vectorIds: string[] = []
  const embedded = await deps.ai.embed([query])
  const values = embedded?.[0]
  if (values) {
    try {
      const filter = deps.entityVectors.foldPartitionFilter()
      const matches = await deps.entityVectors.query(
        filter ? { values, topK, filter } : { values, topK },
      )
      vectorIds = matches.filter((match) => match.score >= COSINE_FLOOR).map((match) => match.id)
    } catch {
      vectorIds = []
    }
  }

  // Keyword arm: entity_fts (MATCH pure text; JOIN-back re-checks tenant/scope/visibility).
  const ftsIds = await deps.graph.entityFtsIds(query, topK)
  if (vectorIds.length === 0 && ftsIds.length === 0) return []

  // Fuse, THEN the authoritative D1 re-check drops any cross-tenant / out-of-visibility id.
  const fused = fuseIdRanks([vectorIds, ftsIds])
  const rows = await deps.graph.recheckEntities(fused.map((entry) => entry.id))
  const byId = new Map<string, EntityRow>(rows.map((row) => [row.id, row]))

  const out: EntityHit[] = []
  for (const entry of fused) {
    const row = byId.get(entry.id)
    if (!row) continue // dropped by the re-check — never surfaced
    out.push({
      id: row.id,
      name: row.canonicalName,
      kind: row.kind,
      description: row.description,
      score: entry.score,
      scope: row.scope,
      visibility: row.visibility,
      teamId: row.teamId,
    })
  }
  return out.slice(0, topK)
}

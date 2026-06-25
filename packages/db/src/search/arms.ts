/**
 * The two hybrid-search arms (PRD §5.3.1 / §5.3.2, invariants 3, 4).
 *
 * THE LEAK TRAP (invariant 3): a raw `ScopedVectorize`/FTS id list can contain a
 * cross-tenant / out-of-scope / out-of-visibility / soft-deleted id BEFORE the D1 re-check.
 * So BOTH arms funnel their ids through `ScopedDB` hydration (`getChunksByIds` /
 * `hydrateChunks`) — which IS the re-check — and a `Candidate` is built ONLY from the rows
 * that survive it. No evidence, no citation, no recall trace is ever assembled from a raw
 * match id. This module never touches a raw binding; it composes the frozen chokepoints.
 */
import { COSINE_FLOOR } from "@brain/shared"
import type { ScopedDB } from "../scoped/db"
import type { ScopedVectorize } from "../scoped/vectorize"
import type { AiPort, Candidate } from "./types"
import { toCandidate } from "./types"

/**
 * Vector arm: embed(query) → `ScopedVectorize.query` (namespace=tenant baked in) →
 * raw-cosine threshold (PRE-FUSION) → `ScopedDB.getChunksByIds` (the re-check). Returns
 * `[]` when the AI binding or Vectorize is unavailable (degrade to keyword-only,
 * invariant 14). The surviving rows are returned in cosine-descending order; the per-row
 * cosine is carried as `armScore` purely for that ordering.
 */
export const vectorArm = async (
  db: ScopedDB,
  vectors: ScopedVectorize,
  ai: AiPort,
  query: string,
  topK: number,
  threshold: number = COSINE_FLOOR,
): Promise<Candidate[]> => {
  if (query.length === 0) return []
  const embedded = await ai.embed([query])
  const values = embedded?.[0]
  if (!values) return [] // degrade: vector arm empty

  let matches: { id: string; score: number }[]
  try {
    // Push a restricted scope grant into the metadata filter so the topK budget is spent
    // inside the granted partition (the recall-cliff fix); `'*'` passes through unchanged.
    const filter = vectors.foldPartitionFilter()
    matches = await vectors.query(filter ? { values, topK, filter } : { values, topK })
  } catch {
    return [] // degrade: Vectorize unavailable
  }

  // Threshold on RAW cosine, BEFORE fusion (never on normalized RRF scores).
  const scoreById = new Map<string, number>()
  for (const match of matches) {
    if (match.score >= threshold) scoreById.set(match.id, match.score)
  }
  if (scoreById.size === 0) return []

  // THE RE-CHECK: cross-tenant / out-of-scope / hidden / deleted ids are silently dropped.
  // Candidates are built from these survivors ONLY — never from `matches` above.
  const rows = await db.getChunksByIds([...scoreById.keys()])
  return rows
    .map((row) => toCandidate(row, scoreById.get(row.id) ?? 0))
    .sort((a, b) => b.armScore - a.armScore)
}

/**
 * FTS (bm25) arm: `ScopedDB.ftsChunkIds` (MATCH is pure text; the tenant + scope +
 * soft-delete predicate sits on the base table after the JOIN-back) → `hydrateChunks` (the
 * re-check, which re-applies the visibility tier the keyword arm cannot). The returned ids
 * are already bm25-ordered; surviving rows keep that order, and a synthetic descending
 * `armScore` encodes the rank for fusion. Any id dropped at hydration is simply absent.
 */
export const ftsArm = async (db: ScopedDB, query: string, topK: number): Promise<Candidate[]> => {
  if (query.length === 0) return []
  const ids = await db.ftsChunkIds(query, topK)
  if (ids.length === 0) return []

  // THE RE-CHECK: hydrate re-applies tenant + scope + visibility + soft-delete; a row that
  // fails any predicate is missing from the map, so it can never become a Candidate.
  const hydrated = await db.hydrateChunks(ids)
  const out: Candidate[] = []
  for (let rank = 0; rank < ids.length; rank++) {
    const id = ids[rank]
    if (id === undefined) continue
    const row = hydrated.get(id)
    if (!row) continue // dropped by the re-check — never surfaced
    // Descending synthetic score so arm-internal order = bm25 order (fusion uses position).
    out.push(toCandidate(row, ids.length - rank))
  }
  return out
}

/**
 * Pure derivation helpers (client-safe, no server imports → unit-testable). `foldDocuments` collapses
 * `search` hits into distinct documents: one row per `documentId`, keeping the best-scoring snippet
 * and the chunk count, sorted by top score. This is the whole of the v1 "Documents" view (the API
 * exposes no list-documents op).
 */
import type { DerivedDocument, SearchHit } from "./types"

export const foldDocuments = (hits: readonly SearchHit[]): DerivedDocument[] => {
  const byDoc = new Map<string, DerivedDocument>()
  for (const hit of hits) {
    const prev = byDoc.get(hit.documentId)
    if (prev === undefined) {
      byDoc.set(hit.documentId, {
        documentId: hit.documentId,
        slug: hit.slug,
        topScore: hit.score,
        snippet: hit.snippet,
        hitCount: 1,
      })
    } else {
      prev.hitCount += 1
      if (hit.score > prev.topScore) {
        prev.topScore = hit.score
        prev.snippet = hit.snippet
      }
    }
  }
  return [...byDoc.values()].sort((a, b) => b.topScore - a.topScore)
}

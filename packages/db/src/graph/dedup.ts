/**
 * Phase 3.5: cross-session semantic entity dedup (PRD §6.6).
 *
 * `upsertEntityWithVectorDedup` — deterministic-key-first → vector-nearest fallback
 * (cosine ≥ RELATED_FLOOR = 0.85, same kind, same scope partition) → D1 re-check
 * (recheckEntities: same tenant + scope + {world,team} visibility) → merge if matched;
 * otherwise create new and immediately upsert its vector so the NEXT entity in the same
 * extraction batch can match against it (within-batch ordering guarantee).
 *
 * All vector/embed calls are non-fatal (catch-and-fall-through to creation). Idempotent:
 * re-extracting the same source hits the deterministic key on the second run, never
 * creating a duplicate.
 *
 * Isolation contract (non-vacuous cross-tenant proof):
 *   A Vectorize namespace match for a DIFFERENT tenant's entity id passes through
 *   `recheckEntities`, which enforces `tenant_id = p.tenantId` — so the id is NOT found
 *   and `vectorMatchId` stays null. The function then creates a new entity row for the
 *   correct tenant. Cross-tenant merges are structurally impossible.
 *
 * This function is isolated from `ScopedGraph` so it can be unit-tested with a
 * fake/adversarial `ScopedVectorize` and a controlled embed stub (bun:sqlite), exactly
 * mirroring the `graph.test.ts` canary patterns.
 */
import { EMBEDDING_MODEL, RELATED_FLOOR } from "@brain/shared"
import type { ScopedVectorize } from "../scoped/vectorize"
import type { ExtractedEntityInput, ScopedGraph } from "./scoped-graph"

/** The embed seam: same signature as `services.ai.embed`. Returns null on degrade. */
export type EmbedFn = (texts: string[]) => Promise<number[][] | null>

/** Result of a single entity upsert through the Phase 3.5 dedup pipeline. */
export interface EntityDedupResult {
  /** The resolved entity id (existing merged-into, or newly created). */
  id: string
  /**
   * true = the entity's vector was embedded + upserted INLINE during dedup.
   * The extraction pipeline should skip step-5 re-embedding for this id.
   * false = deterministic key hit (step 5 handles vector refresh) or embed was unavailable.
   */
  embedded: boolean
}

/**
 * Upsert an entity with Phase 3.5 cross-session semantic dedup. Algorithm:
 *
 * 1. **Deterministic key** `(tenant, COALESCE(scope,''), kind, lower(name))` → if hit:
 *    merge via `mergeEntityInto`, return existing id. Vector NOT embedded inline;
 *    step 5 of the extraction pipeline handles refresh (pre-3.5 behavior preserved).
 *
 * 2. **Vector-nearest fallback** (deterministic miss only):
 *    - Embed the entity text (`name + description`, same chokepoint as chunks).
 *    - Query brain-entities (namespace=tenantId, topK=1, optional scope filter).
 *    - If top score ≥ RELATED_FLOOR (0.85): D1 re-check via `recheckEntities` —
 *      must be same kind AND same scope partition. If match: merge into existing
 *      entity, add the new surface name as an alias, re-upsert updated vector inline.
 *
 * 3. **Create new** (both checks missed): insert entity row → upsert its vector
 *    immediately so the next entity in the batch can match against it.
 *
 * All `embed`/`query`/`upsert` calls are wrapped in try/catch. On any error the
 * function falls through to phase 3 (create). The D1 row is always the existence gate.
 */
export const upsertEntityWithVectorDedup = async (
  graph: ScopedGraph,
  entityVectors: ScopedVectorize,
  embed: EmbedFn,
  input: ExtractedEntityInput,
): Promise<EntityDedupResult> => {
  // ── Phase 1: deterministic key (exact match wins, current behavior) ───────────
  const byKey = await graph.findEntityByKey(input.name, input.kind, input.scope)
  if (byKey) {
    await graph.mergeEntityInto(byKey.id, input)
    // Step 5 of the extraction pipeline refreshes the vector for this entity.
    return { id: byKey.id, embedded: false }
  }

  // ── Phase 2: vector-nearest fallback (only on deterministic miss) ─────────────
  const entityText = `${input.name}\n${input.description}`.trim()
  let embedding: number[] | null = null
  let vectorMatchId: string | null = null

  try {
    const vectors = await embed([entityText])
    embedding = vectors?.[0] ?? null
    if (embedding !== null) {
      // Fold scope into the filter to keep the ANN budget inside the right partition
      // (same optimisation as `searchEntities` uses foldPartitionFilter for chunks).
      const scopeFilter: VectorizeVectorMetadataFilter | undefined =
        input.scope !== null ? { scope: input.scope } : undefined
      const filter = entityVectors.foldPartitionFilter(scopeFilter)
      const nearest = await entityVectors.query({
        values: embedding,
        topK: 1,
        ...(filter !== undefined ? { filter } : {}),
      })
      const top = nearest[0]
      if (top !== undefined && top.score >= RELATED_FLOOR) {
        // D1 re-check: enforces tenant_id = p.tenantId (cross-tenant never leaks),
        // scope, {world,team} visibility. Additionally check kind + scope partition.
        const recheck = await graph.recheckEntities([top.id])
        const match = recheck.find(
          (r) => r.kind === input.kind && (r.scope ?? null) === (input.scope ?? null),
        )
        if (match !== undefined) vectorMatchId = match.id
      }
    }
  } catch {
    // Non-fatal: fall through to Phase 3 (create new).
  }

  if (vectorMatchId !== null) {
    // Vector-dedup hit: merge into existing entity.
    // Add the new surface name as an alias (the canonical representation stays, the new
    // surface form becomes a queryable alias — §6.6 "add the new surface name to the
    // existing entity's aliases union").
    await graph.mergeEntityInto(vectorMatchId, {
      ...input,
      aliases: [...input.aliases, input.name],
    })
    // Re-upsert vector for the merged entity (updated data / new surface form).
    if (embedding !== null) {
      try {
        await entityVectors.upsert({
          id: vectorMatchId,
          values: embedding,
          scope: input.scope,
          teamId: input.teamId,
          visibility: input.visibility,
          embeddingModel: EMBEDDING_MODEL,
        })
        await graph.markEntityEmbedded(vectorMatchId, new Date().toISOString())
      } catch {
        // Non-fatal: the D1 row exists; next re-extract will retry the vector upsert.
      }
    }
    return { id: vectorMatchId, embedded: true }
  }

  // ── Phase 3: create new entity + immediately upsert its vector ────────────────
  // Upsert BEFORE returning so the NEXT entity in the same extraction batch queries a
  // brain-entities index that already contains this entity's vector (within-batch ordering).
  const id = await graph.createEntity(input)
  let embedded = false
  if (embedding !== null) {
    try {
      await entityVectors.upsert({
        id,
        values: embedding,
        scope: input.scope,
        teamId: input.teamId,
        visibility: input.visibility,
        embeddingModel: EMBEDDING_MODEL,
      })
      await graph.markEntityEmbedded(id, new Date().toISOString())
      embedded = true
    } catch {
      // Non-fatal: entity_fts still covers the entity; step 5 retries the vector upsert.
    }
  }
  return { id, embedded }
}

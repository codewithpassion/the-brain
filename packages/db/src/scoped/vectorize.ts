/**
 * `ScopedVectorize` — the ONLY way to touch a Vectorize V2 index (PRD §7.3/§7.4,
 * invariants 1, 3).
 *
 * Hard-wires `namespace = p.tenantId` (NEVER `userId`) on EVERY upsert AND query, so a
 * forgotten namespace is impossible — the caller never builds the raw query. `topK` is
 * capped at `VECTORIZE_TOPK_MAX` (100). `foldPartitionFilter` folds a restricted
 * `allowedScopes` grant into the metadata filter as `{scope:{$in:[...]}}` so the topK
 * budget is spent INSIDE the granted partition (the recall-cliff fix).
 *
 * Isolation does NOT rest on the namespace (invariant 3): Cloudflare does not document it
 * as a security boundary. Every id this returns is re-checked at the D1 gate
 * (`ScopedDB.getChunksByIds`), which drops anything cross-tenant. This wrapper returns
 * `{id, score}` only — no values, no metadata leave it.
 */
import type { Principal } from "@brain/shared"
import { VECTORIZE_TOPK_MAX } from "@brain/shared"

/** A scored vector match, stripped to the two fields the re-check needs. */
export interface VectorMatch {
  id: string
  score: number
}

/** Upsert input; the wrapper stamps `namespace`/`tenant_id` itself (callers cannot). */
export interface ScopedUpsert {
  id: string
  values: number[]
  /** Mirrored from the chunk; folded into the metadata filter for scope partitioning. */
  scope?: string | null
  /** Set only when `visibility = 'team'`. */
  teamId?: string | null
  visibility: string
  /** Carried for the re-embed migration (invariant 12); a stale-model vector is re-embedded. */
  embeddingModel: string
}

export interface ScopedVectorQuery {
  values: number[]
  topK: number
  filter?: VectorizeVectorMetadataFilter
}

const namedScopes = (value: VectorizeVectorMetadataFilter["scope"]): string[] => {
  if (typeof value === "string") return [value]
  if (value && typeof value === "object" && "$in" in value && Array.isArray(value.$in)) {
    return value.$in.filter((entry): entry is string => typeof entry === "string")
  }
  return []
}

export class ScopedVectorize {
  private readonly index: Vectorize
  private readonly p: Principal

  constructor(index: Vectorize, principal: Principal) {
    this.index = index
    this.p = principal
  }

  /**
   * Fold a restricted scope grant into the metadata filter (`{scope:{$in:[...]}}`) so a
   * single query covers any number of granted scopes. `'*'` passes the caller filter
   * through unchanged. Visibility is deliberately NOT folded — pushing it into Vectorize
   * would drop the principal's own private chunks the D1 re-check can never recover, so
   * visibility stays authoritative at D1.
   */
  foldPartitionFilter(
    filter?: VectorizeVectorMetadataFilter,
  ): VectorizeVectorMetadataFilter | undefined {
    if (this.p.allowedScopes === "*") return filter
    return { ...filter, scope: { $in: [...this.p.allowedScopes] } }
  }

  /** Reject an EXPLICIT scope filter that names a scope outside the grant (iter-2 fix). */
  private assertScopeAuthorized(filter?: VectorizeVectorMetadataFilter): void {
    if (!filter || this.p.allowedScopes === "*" || filter.scope === undefined) return
    const allowed = this.p.allowedScopes
    const bad = namedScopes(filter.scope).find((scope) => !allowed.includes(scope))
    if (bad !== undefined) {
      throw new Error(`scope '${bad}' not in allowedScopes`)
    }
  }

  /**
   * Query the index. `namespace = tenantId` is stamped here and cannot be forgotten;
   * `topK` is capped at 100. We request neither `returnValues` nor `returnMetadata:'all'`,
   * so the full topK=100 budget stays available even with a metadata filter. Returns
   * `{id, score}` only — the mandatory D1 re-check still runs downstream.
   */
  async query(input: ScopedVectorQuery): Promise<VectorMatch[]> {
    this.assertScopeAuthorized(input.filter)
    const res = await this.index.query(input.values, {
      topK: Math.min(input.topK, VECTORIZE_TOPK_MAX),
      namespace: this.p.tenantId,
      returnValues: false,
      returnMetadata: "indexed",
      ...(input.filter ? { filter: input.filter } : {}),
    })
    return res.matches.map((match) => ({ id: match.id, score: match.score }))
  }

  /**
   * Upsert a vector. `namespace = tenantId` is hard-wired; `tenant_id` is also stamped
   * into metadata (belt-and-suspenders) alongside the scope/team/visibility/embedding_model
   * fields the metadata indexes and the re-embed migration read.
   */
  async upsert(vector: ScopedUpsert): Promise<void> {
    const metadata: Record<string, VectorizeVectorMetadata> = {
      tenant_id: this.p.tenantId,
      visibility: vector.visibility,
      embedding_model: vector.embeddingModel,
    }
    if (vector.scope != null) metadata.scope = vector.scope
    if (vector.teamId != null) metadata.team_id = vector.teamId
    await this.index.upsert([
      { id: vector.id, values: vector.values, namespace: this.p.tenantId, metadata },
    ])
  }
}

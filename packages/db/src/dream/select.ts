/**
 * Dream candidate selection (v2 W1/D1 step 1). Reads ACTIVE, non-dream facts and groups them
 * into clusters a judge can rule on. Two grouping passes:
 *   1. `(entity_slug, kind)` groups — the cheap, deterministic primary pass.
 *   2. residual facts (no `entity_slug`) clustered by embedding cosine ≥ `RELATED_FLOOR` (0.85),
 *      grouped within `(tier, kind)` so a cluster never mixes fact kinds.
 *
 * Every cluster is HOMOGENEOUS in `(scope, teamId, userId, visibility, kind)` — the composite
 * group key includes the tier + kind, so a consolidated fact inherits the cluster's tier/kind
 * unambiguously (apply.ts relies on this). Only groups with ≥2 facts are clusters. A cluster is
 * capped at `MAX_CLUSTER_SIZE` (newest first); the remainder is left for a future night — this
 * bounds both the D1 bind-param count in apply's link UPDATE and the judge prompt size.
 *
 * The read mirrors the SAME discipline `ScopedDB`/`SessionStore` enforce: `tenant_id` FORCED from
 * the Principal (invariant 1) + the SHARED `scopePredicate` + `visibilityPredicate` (invariant 8)
 * + the SHARED `activeFactPredicate` (superseded/consolidated excluded). The anti-loop guard is in
 * the WHERE: `is_dream_generated = 0` (D-i2). Clusters are ordered by their key so the run's
 * `cursor` (last-processed key) makes the next run resume deterministically (D-i3).
 */

import type { Principal } from "@brain/shared"
import { EMBED_BATCH_SIZE, RELATED_FLOOR } from "@brain/shared"
import { and, asc, eq, isNull } from "drizzle-orm"
import { facts } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { activeFactPredicate, scopePredicate, visibilityPredicate } from "../scoped/predicates"

/** Max facts consolidated per cluster per night (bounds bind params + judge prompt; newest first). */
export const MAX_CLUSTER_SIZE = 100
/** Max residual (no-entity) facts embedded per (tier, kind) per night — bounds the O(n²) pass. */
export const MAX_RESIDUALS_PER_GROUP = 500

/** A candidate fact loaded for consolidation (the tier fields drive cluster homogeneity). */
export interface DreamFact {
  id: number
  entitySlug: string | null
  fact: string
  kind: string
  confidence: number
  visibility: string
  scope: string | null
  teamId: string | null
  userId: string | null
  validFrom: string
}

/** A homogeneous group of ≥2 facts handed to the judge. */
export interface DreamCluster {
  /** Deterministic ordering key; the run's `cursor` is the last-processed key. */
  key: string
  entitySlug: string | null
  kind: string
  scope: string | null
  teamId: string | null
  userId: string | null
  visibility: string
  facts: DreamFact[]
}

const visibilityCols = {
  visibility: facts.visibility,
  teamId: facts.teamId,
  userId: facts.userId,
} as const

const lineageCols = { supersededBy: facts.supersededBy, consolidatedInto: facts.consolidatedInto }

/** Tier tuple as a stable string (never collides across scope/team/user/visibility). */
const tierKey = (f: {
  scope: string | null
  teamId: string | null
  userId: string | null
  visibility: string
}): string => JSON.stringify([f.scope, f.teamId, f.userId, f.visibility])

/** Cosine similarity of two equal-length vectors (residual clustering). */
const cosine = (a: number[], b: number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** The AI slice this step needs (embed only) — narrower than the full services bundle. */
export interface SelectAi {
  embed: (texts: string[]) => Promise<number[][] | null>
}

/** Cap a group to the newest `MAX_CLUSTER_SIZE` (rows arrive id-asc, so the tail is newest). */
const newestCapped = (bucket: DreamFact[]): DreamFact[] =>
  bucket.length <= MAX_CLUSTER_SIZE ? bucket : bucket.slice(bucket.length - MAX_CLUSTER_SIZE)

/**
 * Load active non-dream facts and cluster them. `entity_slug` groups are formed first; residual
 * facts (no entity_slug) are embedded (chunked at `EMBED_BATCH_SIZE`) and greedily clustered per
 * `(tier, kind)` at cosine ≥ RELATED_FLOOR. Embedding degrades per chunk (a null chunk drops only
 * its own facts; never throws — D-i3/inv 14).
 */
export const selectClusters = async (
  db: BrainDrizzle,
  principal: Principal,
  ai: SelectAi,
  opts?: { limit?: number },
): Promise<DreamCluster[]> => {
  const rows = await db
    .select({
      id: facts.id,
      entitySlug: facts.entitySlug,
      fact: facts.fact,
      kind: facts.kind,
      confidence: facts.confidence,
      visibility: facts.visibility,
      scope: facts.scope,
      teamId: facts.teamId,
      userId: facts.userId,
      validFrom: facts.validFrom,
    })
    .from(facts)
    .where(
      and(
        eq(facts.tenantId, principal.tenantId),
        isNull(facts.expiredAt),
        activeFactPredicate(lineageCols), // superseded/consolidated excluded (shared definition)
        eq(facts.isDreamGenerated, 0), // anti-loop (D-i2)
        scopePredicate(principal, facts.scope),
        visibilityPredicate(principal, visibilityCols),
      ),
    )
    .orderBy(asc(facts.id))
    .limit(opts?.limit ?? 5000)

  const clusters: DreamCluster[] = []

  // ── Pass 1: (entity_slug, kind, tier) groups ────────────────────────────────
  const grouped = new Map<string, DreamFact[]>()
  const residual: DreamFact[] = []
  for (const row of rows) {
    if (row.entitySlug === null) {
      residual.push(row)
      continue
    }
    const key = `${row.entitySlug} ${row.kind} ${tierKey(row)}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(row)
    else grouped.set(key, [row])
  }
  for (const [gkey, bucket] of grouped) {
    if (bucket.length < 2) continue
    const members = newestCapped(bucket)
    const head = members[0]
    if (head === undefined) continue
    clusters.push({
      key: `e:${gkey}`,
      entitySlug: head.entitySlug,
      kind: head.kind,
      scope: head.scope,
      teamId: head.teamId,
      userId: head.userId,
      visibility: head.visibility,
      facts: members,
    })
  }

  // ── Pass 2: residual (no entity_slug) → embedding clusters per (tier, kind) ──
  if (residual.length >= 2) {
    // Group residuals by (tier, kind) so a cluster never mixes fact kinds (finding: homogeneity).
    const byGroup = new Map<string, DreamFact[]>()
    for (const row of residual) {
      const gk = `${tierKey(row)} ${row.kind}`
      const bucket = byGroup.get(gk)
      if (bucket) bucket.push(row)
      else byGroup.set(gk, [row])
    }
    for (const [, rawBucket] of byGroup) {
      if (rawBucket.length < 2) continue
      // Cap residuals per group (newest first) to bound the O(n²) similarity pass.
      const bucket =
        rawBucket.length <= MAX_RESIDUALS_PER_GROUP
          ? rawBucket
          : rawBucket.slice(rawBucket.length - MAX_RESIDUALS_PER_GROUP)

      // Embed in EMBED_BATCH_SIZE chunks; a failed chunk leaves its slots null (degrades locally).
      const vectors: (number[] | null)[] = new Array(bucket.length).fill(null)
      for (let i = 0; i < bucket.length; i += EMBED_BATCH_SIZE) {
        const slice = bucket.slice(i, i + EMBED_BATCH_SIZE)
        const vecs = await ai.embed(slice.map((f) => f.fact))
        if (vecs === null || vecs.length !== slice.length) continue
        for (let j = 0; j < slice.length; j++) vectors[i + j] = vecs[j] ?? null
      }

      const used = new Set<number>()
      for (let i = 0; i < bucket.length; i++) {
        if (used.has(i)) continue
        const vi = vectors[i]
        if (vi == null) continue // null (failed chunk) or undefined (bounds) — same skip
        const groupIdx = [i]
        for (let j = i + 1; j < bucket.length; j++) {
          if (used.has(j)) continue
          const vj = vectors[j]
          if (vj == null) continue
          if (cosine(vi, vj) >= RELATED_FLOOR) groupIdx.push(j)
        }
        if (groupIdx.length < 2) continue
        for (const idx of groupIdx) used.add(idx)
        const members = newestCapped(
          groupIdx.map((idx) => bucket[idx]).filter((f): f is DreamFact => f !== undefined),
        )
        const head = members[0]
        if (head === undefined) continue
        const minId = Math.min(...members.map((f) => f.id))
        clusters.push({
          key: `r:${tierKey(head)} ${head.kind} ${minId}`,
          entitySlug: null,
          kind: head.kind,
          scope: head.scope,
          teamId: head.teamId,
          userId: head.userId,
          visibility: head.visibility,
          facts: members,
        })
      }
    }
  }

  clusters.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return clusters
}

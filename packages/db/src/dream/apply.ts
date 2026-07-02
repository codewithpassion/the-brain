/**
 * Dream apply (v2 W1/D1 step 3). Turns a judge verdict into D1 writes for ONE cluster, mirroring
 * the store discipline (`SessionStore.replacePromotedFacts`): `tenant_id` + actor FORCED from the
 * Principal, every mutation batched with its `memory_audit` row in the SAME `db.batch` (D-i4).
 *
 * NON-DESTRUCTIVE (D-i5): originals keep their rows. `merge` inserts a NEW consolidated fact and
 * sets `consolidated_into`/`consolidated_at` pointers on the inputs; `supersede` sets
 * `superseded_by`; `contradict` files a `memory_review` row for a human. Nothing is deleted and no
 * original text is modified — every action is reversible by clearing the pointers.
 *
 * TRUST (D-i1): the consolidated fact is `is_dream_generated=1`, `source='dream:consolidation'`,
 * confidence = MIN of its inputs (conservative), `source_session_id=null` (lineage lives in the
 * `consolidated_into` pointers, not a marker). It gets NO `memory_use_policy` row, so its
 * trust_grade COALESCEs to 'evidence' — dream output is never promoted above evidence.
 *
 * `facts.id` is the lone INTEGER AUTOINCREMENT pk, so the consolidated insert uses `.returning()`
 * INSIDE its batch to hand back the new id (no re-select, no marker). Linking the inputs to that id
 * needs a SEPARATE batch (the id is unknowable at the first batch's bind time) — both batches carry
 * an audit row, so D-i4 holds. Every `inArray` UPDATE is chunked at `ID_CHUNK` ids per statement
 * (D1's ~100 bound-param cap), all chunks + the audit row in one batch.
 */
import type { Principal } from "@brain/shared"
import { and, eq, inArray } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { facts, memoryAudit, memoryReview } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import type { DreamVerdict } from "./judge"
import type { DreamCluster } from "./select"

type BatchStatement = BatchItem<"sqlite">

interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown[]>
}

/** Ids per `inArray` UPDATE statement — under D1's ~100 bound-param cap (invariant 11). */
export const ID_CHUNK = 90

/** Below this confidence a merge/supersede is downgraded to a human review (plan risk mitigation). */
export const AUTO_MERGE_FLOOR = 0.7

/** The per-cluster apply outcome (counts folded into the run's stats). */
export interface ApplyOutcome {
  merged: number
  superseded: number
  contradictions: number
  kept: number
}

const ZERO_OUTCOME: ApplyOutcome = { merged: 0, superseded: 0, contradictions: 0, kept: 0 }

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Apply one verdict. Returns the outcome counts. Throws only on a read-only principal (a guard,
 * never hit by the system dream principal); every other degrade path resolves to `kept`.
 */
export const applyCluster = async (
  db: BrainDrizzle,
  principal: Principal,
  cluster: DreamCluster,
  verdict: DreamVerdict,
  now: string,
): Promise<ApplyOutcome> => {
  if (principal.readOnly) throw new Error("dream apply denied: read-only principal")

  const runBatch = async (statements: BatchStatement[]): Promise<unknown[]> => {
    const [first, ...rest] = statements
    if (first === undefined) return []
    return (await (db as unknown as BatchCapable).batch([first, ...rest])) ?? []
  }

  const auditStatement = (action: string, targetId: string | null, diff: unknown): BatchStatement =>
    db.insert(memoryAudit).values({
      id: crypto.randomUUID(),
      tenantId: principal.tenantId, // forced
      userId: principal.userId, // forced actor
      action,
      targetId,
      at: Date.now(),
      diff: JSON.stringify(diff),
    })

  const inputIds = cluster.facts.map((f) => f.id)

  // Auto-merge floor: a low-confidence merge/supersede is filed for review, never applied.
  const belowFloor =
    (verdict.action === "merge" || verdict.action === "supersede") &&
    verdict.confidence < AUTO_MERGE_FLOOR
  const effective = belowFloor ? "contradict" : verdict.action

  // ── merge → insert consolidated fact (RETURNING id) + link inputs ───────────
  if (effective === "merge") {
    if (verdict.mergedText === null) return { ...ZERO_OUTCOME, kept: 1 } // nothing to merge into
    const confidence = Math.min(...cluster.facts.map((f) => f.confidence))
    const insert = db
      .insert(facts)
      .values({
        tenantId: principal.tenantId, // forced
        scope: cluster.scope,
        teamId: cluster.teamId,
        userId: cluster.userId,
        entitySlug: cluster.entitySlug,
        fact: verdict.mergedText,
        kind: cluster.kind,
        visibility: cluster.visibility,
        confidence,
        source: "dream:consolidation",
        sourceSessionId: null, // lineage lives in consolidated_into pointers, not a marker
        isDreamGenerated: 1, // anti-loop (D-i2)
        validFrom: now,
      })
      .returning({ id: facts.id })
    const results = await runBatch([
      insert,
      auditStatement("dream.consolidate", null, { inputIds, rationale: verdict.rationale }),
    ])
    const insertedRows = (results[0] as { id: number }[] | undefined) ?? []
    const newId = insertedRows[0]?.id ?? null

    if (newId !== null && inputIds.length > 0) {
      // Link the inputs to the new fact — chunked ≤ ID_CHUNK ids/statement, all in one batch.
      const links: BatchStatement[] = chunk(inputIds, ID_CHUNK).map((ids) =>
        db
          .update(facts)
          .set({ consolidatedInto: newId, consolidatedAt: now })
          .where(and(eq(facts.tenantId, principal.tenantId), inArray(facts.id, ids))),
      )
      await runBatch([
        ...links,
        auditStatement("dream.consolidate.link", String(newId), { inputIds }),
      ])
    }
    return { ...ZERO_OUTCOME, merged: 1 }
  }

  // ── supersede → point losers at the winner ──────────────────────────────────
  if (effective === "supersede") {
    if (verdict.winnerId === null || verdict.supersededIds.length === 0) {
      return { ...ZERO_OUTCOME, kept: 1 } // insufficient verdict → leave untouched
    }
    const losers = verdict.supersededIds.filter((id) => id !== verdict.winnerId)
    if (losers.length === 0) return { ...ZERO_OUTCOME, kept: 1 }
    const updates: BatchStatement[] = chunk(losers, ID_CHUNK).map((ids) =>
      db
        .update(facts)
        .set({ supersededBy: verdict.winnerId })
        .where(and(eq(facts.tenantId, principal.tenantId), inArray(facts.id, ids))),
    )
    await runBatch([
      ...updates,
      auditStatement("dream.supersede", String(verdict.winnerId), {
        supersededIds: losers,
        rationale: verdict.rationale,
      }),
    ])
    return { ...ZERO_OUTCOME, superseded: losers.length }
  }

  // ── contradict (or a downgraded low-confidence merge/supersede) → human review ──
  if (effective === "contradict") {
    const targetId = String(inputIds[0] ?? "")
    const reviewId = crypto.randomUUID()
    const review = db.insert(memoryReview).values({
      id: reviewId,
      tenantId: principal.tenantId, // forced
      targetId,
      status: "unreviewed",
      reviewer: "dream",
      reviewedAt: now, // NOT NULL — "filed at" for an unreviewed row
      note: JSON.stringify({
        factIds: inputIds,
        rationale: verdict.rationale,
        originalAction: verdict.action,
        downgraded: belowFloor,
      }),
    })
    await runBatch([
      review,
      auditStatement("dream.contradict", targetId, { factIds: inputIds, reviewId }),
    ])
    return { ...ZERO_OUTCOME, contradictions: 1 }
  }

  // ── keep → nothing to do ─────────────────────────────────────────────────────
  return { ...ZERO_OUTCOME, kept: 1 }
}

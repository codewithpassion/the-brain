/**
 * `DreamRunStore` — tenant-scoped lifecycle over the `dream_runs` row (v2 W1/D1), the Dream
 * engine's counterpart to `BackfillRunStore`. The status FSM (`queued→running→success|failure|
 * cancelled`), the resumable `cursor` (last-processed cluster key), and the `stats` roll-up all
 * live here.
 *
 * `dream_runs` is an OPS table, not tenant MEMORY: like `BackfillRunStore` (and `recordSpend`),
 * its writes carry NO `memory_audit` row and are NOT gated by `readOnly` — they are run-state
 * counters, recorded regardless of who incurred them. But `tenant_id` is STILL FORCED from the
 * Principal on every read and write (invariant 1), never read from a caller, so a run can never
 * be claimed/advanced across tenants. Atomicity stays `db.batch([...])` (invariant 11).
 */
import type { Principal } from "@brain/shared"
import { and, desc, eq, sql } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { dreamRuns } from "../schema"
import type { BrainDrizzle } from "../scoped/db"

type BatchStatement = BatchItem<"sqlite">

/** `db.batch([...])` — the all-or-nothing atomicity primitive (invariant 11). */
interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** The run's mutable stats roll-up (JSON-encoded in `dream_runs.stats`). */
export interface DreamRunStats {
  // consolidation (D1) counters
  clustersJudged: number
  merged: number
  superseded: number
  contradictions: number
  kept: number
  // reflection (D2) counters
  targets: number
  insights: number
  // shared
  skipped: number
  /** Neurons attributed to THIS run (the dream cost ledger, D-i3). */
  neurons: number
}

/** A `dream_runs` row after a tenant-scoped read. */
export interface DreamRunRow {
  id: string
  tenantId: string
  kind: string
  status: string
  cursor: string | null
  stats: DreamRunStats
  attempts: number
  note: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export type DreamRunStatus = "queued" | "running" | "paused" | "success" | "failure" | "cancelled"

/** Statuses a `runDreamConsolidation` invocation may (re-)claim from — a fresh queued run, a
 *  budget-`paused` run resuming, or a `failure` retrying. `running`/`cancelled` are NOT claimable. */
export const CLAIMABLE_FROM: readonly DreamRunStatus[] = ["queued", "paused", "failure"]

/** `createRun` input — `tenantId` is NEVER accepted; the store forces it. */
export interface CreateDreamRunInput {
  id: string
  kind: "consolidation" | "reflection" | "digest" | "dedup" | "hygiene"
}

export const ZERO_DREAM_STATS: DreamRunStats = {
  clustersJudged: 0,
  merged: 0,
  superseded: 0,
  contradictions: 0,
  kept: 0,
  targets: 0,
  insights: 0,
  skipped: 0,
  neurons: 0,
}

/** Coerce ONE known numeric stat key (drops null/string/garbage; never re-persists junk). */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const parseStats = (json: string | null): DreamRunStats => {
  if (json === null) return { ...ZERO_DREAM_STATS }
  try {
    const p = JSON.parse(json) as Record<string, unknown>
    if (!p || typeof p !== "object") return { ...ZERO_DREAM_STATS }
    return {
      clustersJudged: num(p.clustersJudged),
      merged: num(p.merged),
      superseded: num(p.superseded),
      contradictions: num(p.contradictions),
      kept: num(p.kept),
      targets: num(p.targets),
      insights: num(p.insights),
      skipped: num(p.skipped),
      neurons: num(p.neurons),
    }
  } catch {
    return { ...ZERO_DREAM_STATS }
  }
}

export class DreamRunStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
  }

  /** Run statements atomically (invariant 11). See `BatchCapable` for the D1/test seam. */
  private async commitBatch(statements: BatchStatement[]): Promise<void> {
    const [first, ...rest] = statements
    if (first === undefined) return
    await (this.db as unknown as BatchCapable).batch([first, ...rest])
  }

  /** A tenant-scoped read of one run; `null` when absent or owned by another tenant. */
  async get(runId: string): Promise<DreamRunRow | null> {
    const rows = await this.db
      .select()
      .from(dreamRuns)
      .where(and(eq(dreamRuns.id, runId), eq(dreamRuns.tenantId, this.p.tenantId)))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    return {
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind,
      status: row.status,
      cursor: row.cursor,
      stats: parseStats(row.stats),
      attempts: row.attempts,
      note: row.note,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  /** Insert a fresh `queued` run with `tenant_id` forced (idempotent on id); returns the run id. */
  async createRun(input: CreateDreamRunInput): Promise<string> {
    const now = new Date().toISOString()
    const insert = this.db
      .insert(dreamRuns)
      .values({
        id: input.id,
        tenantId: this.p.tenantId, // forced
        kind: input.kind,
        status: "queued",
        stats: JSON.stringify(ZERO_DREAM_STATS),
        createdAt: now,
        updatedAt: now,
      })
      // A same-day re-dispatch re-uses the row id (esp. the digest one-shot); keep the existing row.
      .onConflictDoNothing()
    await this.commitBatch([insert])
    return input.id
  }

  /** Overwrite the raw `stats` JSON (the digest step stores a bespoke stats shape here). */
  async setStats(runId: string, statsJson: string): Promise<void> {
    const update = this.db
      .update(dreamRuns)
      .set({ stats: statsJson, updatedAt: new Date().toISOString() })
      .where(and(eq(dreamRuns.id, runId), eq(dreamRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /**
   * Optimistic conditional claim: flip `from → running` and bump `attempts` in ONE atomic
   * conditional UPDATE. The claim is decided by the UPDATE's CHANGED-ROW COUNT (via `.returning()`),
   * NOT a re-read — so two racing callers cannot both win (the loser's WHERE matches zero rows once
   * the winner flips the status). Returns `true` iff THIS caller changed the row. Tenant-scoped WHERE.
   */
  async claim(runId: string, from: DreamRunStatus = "queued"): Promise<boolean> {
    const now = new Date().toISOString()
    const changed = await this.db
      .update(dreamRuns)
      .set({ status: "running", attempts: sql`${dreamRuns.attempts} + 1`, updatedAt: now })
      .where(
        and(
          eq(dreamRuns.id, runId),
          eq(dreamRuns.tenantId, this.p.tenantId),
          eq(dreamRuns.status, from),
        ),
      )
      .returning({ id: dreamRuns.id })
    return changed.length > 0
  }

  /** Persist the resumable `cursor` + merged `stats` after a cluster (the resume point). */
  async persistProgress(runId: string, cursor: string | null, stats: DreamRunStats): Promise<void> {
    const update = this.db
      .update(dreamRuns)
      .set({ cursor, stats: JSON.stringify(stats), updatedAt: new Date().toISOString() })
      .where(and(eq(dreamRuns.id, runId), eq(dreamRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /** Terminal/paused status flip. Does NOT touch `cursor` (the caller persists that first). */
  async finishRun(runId: string, status: DreamRunStatus, error?: string): Promise<void> {
    const update = this.db
      .update(dreamRuns)
      .set({ status, error: error ?? null, updatedAt: new Date().toISOString() })
      .where(and(eq(dreamRuns.id, runId), eq(dreamRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /** List runs for the tenant, newest-first (the Jobs/Dreams dashboard projection). */
  async list(limit = 50): Promise<DreamRunRow[]> {
    const rows = await this.db
      .select()
      .from(dreamRuns)
      .where(eq(dreamRuns.tenantId, this.p.tenantId))
      .orderBy(desc(dreamRuns.createdAt))
      .limit(limit)
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind,
      status: row.status,
      cursor: row.cursor,
      stats: parseStats(row.stats),
      attempts: row.attempts,
      note: row.note,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }
}

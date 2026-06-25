/**
 * `BackfillRunStore` — tenant-scoped lifecycle ops over the `backfill_runs` row (PRD §8.1/§8.6).
 *
 * The Queue owns message-level dispatch; THIS row owns the enumerator-run state: status FSM
 * (`queued→running→success|failure|cancelled`), the resumable `cursor`, the durable `anchor`
 * (advances ONLY on a clean full pass — §8.6 / `gbrain-cf:src/sync.ts`), `stats`, `attempts`,
 * `fail_count`, and gbrain's optimistic conditional `claim`.
 *
 * `backfill_runs` is an OPS table, not tenant MEMORY: like `recordSpend`/`appendRecallTraces`
 * (scoped/db.ts) its writes carry NO `memory_audit` row and are NOT gated by `readOnly` — they
 * are run-state counters, recorded regardless of who incurred them. But `tenant_id` is STILL
 * FORCED from the Principal on every read and write (invariant 1), never read from a caller, so
 * a run can never be claimed/advanced across tenants. Atomicity stays `db.batch([...])` only
 * (invariant 11), via the same `commitBatch` seam the stores share.
 */
import type { Principal } from "@brain/shared"
import { and, eq } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { backfillRuns } from "../schema"
import type { BrainDrizzle } from "../scoped/db"

type BatchStatement = BatchItem<"sqlite">

/** `db.batch([...])` — the all-or-nothing atomicity primitive (invariant 11). */
interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** The run's mutable stats roll-up (JSON-encoded in `backfill_runs.stats`). */
export interface RunStats {
  processed: number
  created: number
  skipped: number
  errors: number
  merged: number
  /** Neurons attributed to this run (the re-embed cost ledger, §8.7). */
  neurons: number
}

/** A `backfill_runs` row after a tenant-scoped read. */
export interface BackfillRunRow {
  id: string
  tenantId: string
  sourceId: string
  kind: string
  direction: string
  status: string
  cursor: string | null
  anchor: string | null
  stats: RunStats
  attempts: number
  failCount: number
  error: string | null
}

export type RunStatus = "queued" | "running" | "success" | "failure" | "cancelled"

/** `createRun` input — `tenantId` is NEVER accepted; the store forces it. */
export interface CreateRunInput {
  id: string
  sourceId: string
  kind: string
  direction?: "backfill" | "incremental"
}

const ZERO_STATS: RunStats = {
  processed: 0,
  created: 0,
  skipped: 0,
  errors: 0,
  merged: 0,
  neurons: 0,
}

const parseStats = (json: string | null): RunStats => {
  if (json === null) return { ...ZERO_STATS }
  try {
    const parsed = JSON.parse(json) as Partial<RunStats>
    return {
      processed: parsed.processed ?? 0,
      created: parsed.created ?? 0,
      skipped: parsed.skipped ?? 0,
      errors: parsed.errors ?? 0,
      merged: parsed.merged ?? 0,
      neurons: parsed.neurons ?? 0,
    }
  } catch {
    return { ...ZERO_STATS }
  }
}

export class BackfillRunStore {
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
  async get(runId: string): Promise<BackfillRunRow | null> {
    const rows = await this.db
      .select()
      .from(backfillRuns)
      .where(and(eq(backfillRuns.id, runId), eq(backfillRuns.tenantId, this.p.tenantId)))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    return {
      id: row.id,
      tenantId: row.tenantId,
      sourceId: row.sourceId,
      kind: row.kind,
      direction: row.direction,
      status: row.status,
      cursor: row.cursor,
      anchor: row.anchor,
      stats: parseStats(row.stats),
      attempts: row.attempts,
      failCount: row.failCount,
      error: row.error,
    }
  }

  /** Insert a fresh `queued` run with `tenant_id` forced; returns the run id. */
  async createRun(input: CreateRunInput): Promise<string> {
    const now = new Date().toISOString()
    const insert = this.db.insert(backfillRuns).values({
      id: input.id,
      tenantId: this.p.tenantId, // forced
      sourceId: input.sourceId,
      kind: input.kind,
      direction: input.direction ?? "backfill",
      status: "queued",
      stats: JSON.stringify(ZERO_STATS),
      createdAt: now,
      updatedAt: now,
    })
    await this.commitBatch([insert])
    return input.id
  }

  /**
   * gbrain's optimistic conditional claim (`gbrain-cf:src/jobs.ts`): flip `queued→running` (or
   * reclaim a stale `running`) and bump `attempts`, but ONLY when the current status still matches
   * `from`. Returns `true` iff THIS caller won the claim — a racing second consumer reads a
   * non-matching status and gets `false` (no double-drive). Tenant-scoped WHERE.
   */
  async claim(runId: string, from: RunStatus = "queued"): Promise<boolean> {
    const now = new Date().toISOString()
    const current = await this.get(runId)
    if (current === null || current.status !== from) return false
    const update = this.db
      .update(backfillRuns)
      .set({ status: "running", attempts: current.attempts + 1, updatedAt: now })
      .where(
        and(
          eq(backfillRuns.id, runId),
          eq(backfillRuns.tenantId, this.p.tenantId),
          eq(backfillRuns.status, from),
        ),
      )
    await this.commitBatch([update])
    const after = await this.get(runId)
    return after?.status === "running"
  }

  /**
   * Persist the resumable `cursor` + merged `stats` after a batch (§8.6 driveImport loop). This
   * is the resume point a restarted enumerator reads — it does NOT advance the durable anchor.
   */
  async persistProgress(runId: string, cursor: string | null, stats: RunStats): Promise<void> {
    const update = this.db
      .update(backfillRuns)
      .set({ cursor, stats: JSON.stringify(stats), updatedAt: new Date().toISOString() })
      .where(and(eq(backfillRuns.id, runId), eq(backfillRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /**
   * Advance the durable `anchor` — called ONLY on a clean full pass (a terminal cursor reached
   * with no per-item failure). A truncated/failed pass NEVER reaches here, so no silent page
   * loss (§8.6 / invariant: anchor advances only on clean finalize).
   */
  async advanceAnchor(runId: string, anchor: string): Promise<void> {
    const update = this.db
      .update(backfillRuns)
      .set({ anchor, updatedAt: new Date().toISOString() })
      .where(and(eq(backfillRuns.id, runId), eq(backfillRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /** Merge a stats delta into the run (the re-embed cost ledger + per-item counters). */
  async addStats(runId: string, delta: Partial<RunStats>): Promise<void> {
    const current = await this.get(runId)
    if (current === null) return
    const merged: RunStats = {
      processed: current.stats.processed + (delta.processed ?? 0),
      created: current.stats.created + (delta.created ?? 0),
      skipped: current.stats.skipped + (delta.skipped ?? 0),
      errors: current.stats.errors + (delta.errors ?? 0),
      merged: current.stats.merged + (delta.merged ?? 0),
      neurons: current.stats.neurons + (delta.neurons ?? 0),
    }
    const update = this.db
      .update(backfillRuns)
      .set({ stats: JSON.stringify(merged), updatedAt: new Date().toISOString() })
      .where(and(eq(backfillRuns.id, runId), eq(backfillRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /** Terminal status flip (`success|failure|cancelled`); bumps `fail_count` on failure. */
  async finishRun(runId: string, status: RunStatus, error?: string): Promise<void> {
    const current = await this.get(runId)
    const failCount = (current?.failCount ?? 0) + (status === "failure" ? 1 : 0)
    const update = this.db
      .update(backfillRuns)
      .set({
        status,
        failCount,
        error: error ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(backfillRuns.id, runId), eq(backfillRuns.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }
}

export { ZERO_STATS }

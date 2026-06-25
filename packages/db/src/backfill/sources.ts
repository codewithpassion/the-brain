/**
 * `SourceStore` — tenant-scoped ops over the `sources` row (PRD §8.1, gbrain `0005`/`0009`).
 *
 * Owns a source's durable sync state + the exponential-backoff gate that keeps a failing source
 * from being hammered every tick:
 *   - `last_attempt_at` + `sync_fail_count` drive the backoff window (`base · 2^fail_count`);
 *   - a clean pass RESETS `sync_fail_count` and advances the anchor (`last_commit`/`last_sync_at`)
 *     — matching the run-row anchor discipline (§8.6: anchor advances only on a clean pass);
 *   - `archived` retires a dead source so the idle-source re-enqueue sweep skips it.
 *
 * Like `BackfillRunStore`, `sources` is an OPS table: writes carry no audit row and no `readOnly`
 * gate, but `tenant_id` is FORCED on every read/write (invariant 1).
 */
import type { Principal } from "@brain/shared"
import { and, eq } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { sources } from "../schema"
import type { BrainDrizzle } from "../scoped/db"

type BatchStatement = BatchItem<"sqlite">

interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** Default backoff base (1 minute); the window is `BASE · 2^sync_fail_count`. */
export const BACKOFF_BASE_MS = 60_000

/** A `sources` row after a tenant-scoped read (the backoff + anchor projection). */
export interface SourceRow {
  id: string
  tenantId: string
  name: string
  kind: string | null
  lastCommit: string | null
  lastSyncAt: string | null
  lastAttemptAt: string | null
  syncFailCount: number
  archived: number
}

/**
 * The exponential-backoff gate (pure). A source is ready to re-attempt when it has never been
 * attempted, OR `last_attempt_at + BASE · 2^sync_fail_count` is in the past. An ARCHIVED source
 * is never ready. The shift is capped so a long-dead source's window doesn't overflow.
 */
export const isBackoffReady = (
  source: Pick<SourceRow, "lastAttemptAt" | "syncFailCount" | "archived">,
  now: Date = new Date(),
  baseMs: number = BACKOFF_BASE_MS,
): boolean => {
  if (source.archived !== 0) return false
  if (source.lastAttemptAt === null) return true
  const shift = Math.min(source.syncFailCount, 20)
  const windowMs = baseMs * 2 ** shift
  return new Date(source.lastAttemptAt).getTime() + windowMs <= now.getTime()
}

export class SourceStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
  }

  private async commitBatch(statements: BatchStatement[]): Promise<void> {
    const [first, ...rest] = statements
    if (first === undefined) return
    await (this.db as unknown as BatchCapable).batch([first, ...rest])
  }

  private project(row: typeof sources.$inferSelect): SourceRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      kind: row.kind,
      lastCommit: row.lastCommit,
      lastSyncAt: row.lastSyncAt,
      lastAttemptAt: row.lastAttemptAt,
      syncFailCount: row.syncFailCount,
      archived: row.archived,
    }
  }

  /** A tenant-scoped read of one source; `null` when absent or owned by another tenant. */
  async get(sourceId: string): Promise<SourceRow | null> {
    const rows = await this.db
      .select()
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.tenantId, this.p.tenantId)))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : this.project(row)
  }

  /** Every non-archived source in the tenant (the idle-source re-enqueue sweep's candidate set). */
  async listActive(): Promise<SourceRow[]> {
    const rows = await this.db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, this.p.tenantId), eq(sources.archived, 0)))
    return rows.map((row) => this.project(row))
  }

  /**
   * The idle-source re-enqueue candidates: non-archived sources whose backoff window has elapsed.
   * The enumerator re-creates a run per returned source (the "idle source re-enqueue" path).
   */
  async listReenqueuable(
    now: Date = new Date(),
    baseMs: number = BACKOFF_BASE_MS,
  ): Promise<SourceRow[]> {
    const active = await this.listActive()
    return active.filter((source) => isBackoffReady(source, now, baseMs))
  }

  /** Stamp `last_attempt_at = now` (called at the START of a sync tick, before work). */
  async recordAttempt(sourceId: string, now: Date = new Date()): Promise<void> {
    const update = this.db
      .update(sources)
      .set({ lastAttemptAt: now.toISOString() })
      .where(and(eq(sources.id, sourceId), eq(sources.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /**
   * Record a sync FAILURE: bump `sync_fail_count` (→ a longer backoff window) and stamp
   * `last_attempt_at`. The anchor is deliberately untouched — a failed pass never advances it.
   */
  async recordFailure(sourceId: string, now: Date = new Date()): Promise<void> {
    const current = await this.get(sourceId)
    if (current === null) return
    const update = this.db
      .update(sources)
      .set({ syncFailCount: current.syncFailCount + 1, lastAttemptAt: now.toISOString() })
      .where(and(eq(sources.id, sourceId), eq(sources.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /**
   * Record a clean pass: RESET `sync_fail_count` to 0 and advance the durable anchor
   * (`last_commit`/`last_sync_at`). Mirrors the run-row anchor discipline (§8.6).
   */
  async recordSuccess(
    sourceId: string,
    anchor: { lastCommit?: string | null; lastSyncAt?: string | null } = {},
    now: Date = new Date(),
  ): Promise<void> {
    const update = this.db
      .update(sources)
      .set({
        syncFailCount: 0,
        lastAttemptAt: now.toISOString(),
        lastSyncAt: anchor.lastSyncAt ?? now.toISOString(),
        ...(anchor.lastCommit !== undefined ? { lastCommit: anchor.lastCommit } : {}),
      })
      .where(and(eq(sources.id, sourceId), eq(sources.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }

  /** Retire a dead source so the re-enqueue sweep skips it (`isBackoffReady` returns false). */
  async archive(sourceId: string, now: Date = new Date()): Promise<void> {
    const update = this.db
      .update(sources)
      .set({ archived: 1, archivedAt: now.toISOString() })
      .where(and(eq(sources.id, sourceId), eq(sources.tenantId, this.p.tenantId)))
    await this.commitBatch([update])
  }
}

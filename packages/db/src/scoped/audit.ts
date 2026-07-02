/**
 * `batchWithAudit` — the ONE atomic "mutation + its `memory_audit` row" seam (invariants 10, 11),
 * shared by BOTH chokepoints (`ScopedDB` for docs/chunks/facts, `ScopedGraph` for the KG). It
 * FORCES `tenant_id` + actor `user_id` from the Principal (never the caller), rejects a read-only
 * principal, and commits the audit row in the SAME `db.batch` as the change — so the change and its
 * audit either both land or neither does. Centralizing it removes the hand-rolled `memoryAudit`
 * insert + `as unknown as {batch}` cast that had been duplicated in `ScopedGraph.mergeEntities`.
 */
import type { Principal } from "@brain/shared"
import type { BatchItem } from "drizzle-orm/batch"
import { memoryAudit } from "../schema"
import type { BrainDrizzle } from "./db"

export type BatchStatement = BatchItem<"sqlite">

/** What `batchWithAudit` stamps into the in-batch `memory_audit` row. */
export interface AuditSpec {
  action: string
  targetId?: string | null
  diff?: string | null
}

/** The all-or-nothing `.batch([...])` seam D1 exposes (the portable read base type omits it). */
interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/**
 * Append a forced `memory_audit` row to `statements` and commit them atomically. Throws on a
 * read-only principal (write denied) before touching the DB.
 */
export const batchWithAudit = async (
  db: BrainDrizzle,
  principal: Principal,
  statements: BatchStatement[],
  audit: AuditSpec,
): Promise<void> => {
  if (principal.readOnly) throw new Error("write denied: read-only principal")
  const auditStatement = db.insert(memoryAudit).values({
    id: crypto.randomUUID(),
    tenantId: principal.tenantId, // forced — never caller-supplied
    userId: principal.userId, // forced actor
    action: audit.action,
    targetId: audit.targetId ?? null,
    at: Date.now(),
    diff: audit.diff ?? null,
  })
  const all: BatchStatement[] = [...statements, auditStatement]
  const [first, ...rest] = all
  if (first === undefined) return
  await (db as unknown as BatchCapable).batch([first, ...rest])
}

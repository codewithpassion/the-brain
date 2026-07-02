/**
 * The single D1 batch-commit helper, shared by the credential/source stores (vault, notion,
 * sources) that force `tenant_id` manually and commit an insert/update + its audit row atomically.
 * One home so the `[first, ...rest]` non-empty-tuple dance (D1's `batch()` needs a non-empty tuple)
 * isn't re-implemented per store.
 */
import type { BatchItem } from "drizzle-orm/batch"
import type { BrainDrizzle } from "./scoped/db"

export type BatchStatement = BatchItem<"sqlite">

interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** Commit a list of statements in one D1 batch (atomic). A NO-OP for an empty list. */
export const commitBatch = async (
  db: BrainDrizzle,
  statements: BatchStatement[],
): Promise<void> => {
  const [first, ...rest] = statements
  if (first === undefined) return
  await (db as unknown as BatchCapable).batch([first, ...rest])
}

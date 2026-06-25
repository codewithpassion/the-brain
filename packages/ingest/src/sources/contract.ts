/**
 * `runImporterContract` (PRD §4.7) — the resumable-enumeration safety verifier the backfill
 * Enumerator (§8.6) relies on, and the importers' test harness. It drains an `Importer` through
 * `begin → nextBatch* → finalize` and enforces the two invariants that make resumption safe:
 *   (1) a terminal cursor is `null`;
 *   (2) an empty batch with a NON-null cursor is a contract violation (it would loop forever).
 * `finalize` is called exactly once, after the terminal page.
 */
import type { ImportedSession, Importer } from "./types"

/** Drain an importer to completion, asserting the contract; returns every emitted session. */
export const runImporterContract = async (importer: Importer): Promise<ImportedSession[]> => {
  const collected: ImportedSession[] = []
  const begin = await importer.begin({})
  let cursor = begin.cursor
  let guard = 0
  while (cursor !== null) {
    if (guard++ > 100_000) throw new Error("runImporterContract: cursor did not terminate")
    const batch = await importer.nextBatch(cursor)
    if (batch.items.length === 0 && batch.nextCursor !== null) {
      throw new Error("runImporterContract: empty batch with a non-null cursor (would loop)")
    }
    collected.push(...batch.items)
    cursor = batch.nextCursor
  }
  await importer.finalize()
  return collected
}

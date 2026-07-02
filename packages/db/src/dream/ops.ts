/**
 * Dream op CONTRACTS + the `list_dream_runs` read handler (v2 W1/D1).
 *
 *   - `dream_now` (admin) — trigger a consolidation run for the caller's tenant. Its INVOKE lives
 *     in the surface catalog (it needs the deploy-only `DREAM` Workflow binding + inline fallback,
 *     exactly like `ingest_document`), so only the contract is defined here.
 *   - `list_dream_runs` (read) — newest-first `dream_runs` list for the Jobs/Dreams dashboards.
 *     Mirrors `list_backfill_runs`: an `AdminBoundOp` that builds its own `drizzle(env.DB)`.
 */
import { type AnyOpDef, defineOp, type OpRegistry, type Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"
import type { AdminBoundOp } from "../admin"
import type { BrainDrizzle } from "../scoped/db"
import { DREAM_KINDS } from "./plan"
import { DreamRunStore } from "./runs"

// ── Op contracts (handler-free; registered into the shared registry) ──────────────

/** `dream_now` — manually trigger a fact-consolidation dream for the caller's tenant. */
export const DREAM_NOW_OP = defineOp({
  name: "dream_now",
  description:
    "Trigger the nightly Dream engine now: consolidate duplicate hot-memory facts, reflect over " +
    "recent memory into cited insight documents, and file contradictions for review. Admin only. " +
    "Returns the run id.",
  capability: "admin",
  readOnly: false,
  input: z.object({
    kind: z
      .enum(DREAM_KINDS)
      .default("all")
      .describe("Which dream step groups to run (default 'all')."),
  }),
  output: z.object({ runId: z.string(), status: z.string() }),
})

/** `list_dream_runs` — newest-first Dream run history with counts. */
export const LIST_DREAM_RUNS_OP = defineOp({
  name: "list_dream_runs",
  description:
    "List recent Dream engine runs newest-first, with per-run counts (clusters judged, merged, " +
    "superseded, contradictions filed). Use to monitor nightly memory consolidation.",
  capability: "read",
  readOnly: true,
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50).describe("Max runs to return (1–200)."),
  }),
  output: z.object({
    runs: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        status: z.string(),
        clustersJudged: z.number().int(),
        merged: z.number().int(),
        superseded: z.number().int(),
        contradictions: z.number().int(),
        kept: z.number().int(),
        neurons: z.number(),
        attempts: z.number().int(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
  }),
})

/** The Dream op contracts registered into the shared registry. */
export const DREAM_OP_DEFS: readonly AnyOpDef[] = [DREAM_NOW_OP, LIST_DREAM_RUNS_OP]

/** Register the Dream op contracts (handlers bind in the surface catalog). */
export const registerDreamOps = (registry: OpRegistry): OpRegistry => {
  for (const op of DREAM_OP_DEFS) registry.register(op)
  return registry
}

// ── list_dream_runs handler (AdminBoundOp, mirrors list_backfill_runs) ─────────────

export interface ListDreamRunRow {
  id: string
  kind: string
  status: string
  clustersJudged: number
  merged: number
  superseded: number
  contradictions: number
  kept: number
  neurons: number
  attempts: number
  createdAt: string
  updatedAt: string
}

export const listDreamRunsCore = async (
  db: BrainDrizzle,
  principal: Principal,
  input: { limit?: number },
): Promise<{ runs: ListDreamRunRow[] }> => {
  // Reuse the store's read + its single `parseStats` (one source for stats parsing).
  const rows = await new DreamRunStore(db, principal).list(input.limit ?? 50)
  return {
    runs: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      clustersJudged: row.stats.clustersJudged,
      merged: row.stats.merged,
      superseded: row.stats.superseded,
      contradictions: row.stats.contradictions,
      kept: row.stats.kept,
      neurons: row.stats.neurons,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  }
}

export const listDreamRunsOp: AdminBoundOp<{ limit?: number }, { runs: ListDreamRunRow[] }> = {
  def: LIST_DREAM_RUNS_OP,
  handler: (ctx, input) => listDreamRunsCore(drizzle(ctx.env.DB), ctx.principal, input),
}

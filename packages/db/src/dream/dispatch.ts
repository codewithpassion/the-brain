/**
 * `dispatchDreamRun` — the SINGLE workflow-or-inline dispatch path for a consolidation dream,
 * shared by the `dream_now` op (surface catalog) and the nightly cron so the two cannot drift.
 *
 * The run id is `dreamRunId(tenantId)` — the SAME id the `dream_runs` row uses (threaded into the
 * workflow params so the workflow's row id equals what `dream_now` returns). When the `DREAM`
 * Workflow binding is present it dispatches the durable workflow (instance id = the hashed run id,
 * for CF's charset/length cap); a same-day re-dispatch throws "instance already exists", which is
 * the ONE benign error we swallow (returning the existing run). Any OTHER create() error is
 * rethrown — a real dispatch failure must not be silently dropped. With no binding (local/test) it
 * runs `runDreamConsolidation` inline.
 */
import { workflowInstanceId } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import type { BrainBindings } from "../env"
import { createDreamServices, dreamRunId, runDreamConsolidation } from "./run"

/** The deploy-only Dream Workflow binding as the dispatcher needs it. */
export interface DreamWorkflowLike {
  create(options: { id: string; params: { principal: Principal; runId: string } }): Promise<unknown>
}

/** The binding env the dispatcher reads: the frozen bindings + the optional `DREAM` workflow. */
export type DreamDispatchEnv = BrainBindings & { DREAM?: DreamWorkflowLike }

export interface DreamDispatchResult {
  runId: string
  status: string
}

/** True only for the "instance already exists" duplicate-dispatch error (safe to swallow). */
export const isDuplicateInstanceError = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes("already exists") || (msg.includes("instance") && msg.includes("exist"))
}

/** Dispatch (or run inline) a consolidation dream for one principal's tenant. */
export const dispatchDreamRun = async (
  env: DreamDispatchEnv,
  principal: Principal,
): Promise<DreamDispatchResult> => {
  const runId = dreamRunId(principal.tenantId)
  const workflow = env.DREAM
  if (workflow) {
    try {
      await workflow.create({ id: await workflowInstanceId(runId), params: { principal, runId } })
      return { runId, status: "queued" }
    } catch (err) {
      if (isDuplicateInstanceError(err)) return { runId, status: "running" }
      throw err // a real dispatch failure — never swallowed
    }
  }
  const result = await runDreamConsolidation(createDreamServices(env, principal), { runId })
  return { runId, status: result.status }
}

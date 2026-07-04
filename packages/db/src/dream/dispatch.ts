/**
 * `dispatchDreamRun` — the SINGLE workflow-or-inline dispatch path for a dream, shared by the
 * `dream_now` op (surface catalog) and the nightly cron so the two cannot drift.
 *
 * `kind` selects the step groups via the shared `dreamStepPlan` (the SAME plan the `DreamWorkflow`
 * iterates — #20). The dispatch (consolidation) run id is `dreamRunId(tenantId)`; reflection's row
 * is derived from it (`${runId}-reflection`) INSIDE the plan, so the id a run creates always equals
 * the one dispatch returns and the one the workflow drives (no wall-clock re-derivation — #1).
 *
 * The workflow INSTANCE id includes `kind` (`dream-${tenant}-${day}-${kind}`) so a morning
 * `reflection` dispatch cannot block the nightly `all` (#2). Duplicate actual WORK is deduped by
 * each per-kind `dream_runs` row's FSM (e.g. `all` then `consolidation` same day → the
 * consolidation row is already `success` → no-op). A same-day re-dispatch of the SAME kind throws
 * "instance already exists" — the ONE benign error swallowed here; any other create() error is
 * rethrown.
 *
 * Inline (local/test): runs the plan's groups in order, aggregating step statuses worst-of (#3);
 * reflection is SKIPPED when consolidation returned `paused` (budget exhausted — #9). NOTE: the
 * inline path does NOT run KG-extraction over insight docs (that lives in apps/api's workflow
 * step); insights are still ingested (searchable/cited), just not graph-linked here.
 */
import { workflowInstanceId } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import type { BrainBindings } from "../env"
import { createSessionServices } from "../sessions/services"
import { refreshSessionContextSnapshot } from "../sessions/snapshot"
import { createDreamDedupServices, runDreamDedup } from "./dedup"
import { createDreamDigestServices, runDreamDigest } from "./digest"
import { createDreamEntityPagesServices, runDreamEntityPages } from "./entitypages"
import { createDreamHygieneServices, runDreamHygiene } from "./hygiene"
import { createDreamIndexesServices, runDreamIndexes } from "./indexes"
import { type DreamKind, dreamStepPlan, worstStatus } from "./plan"
import { createDreamReflectServices, runDreamReflection } from "./reflect"
import { createDreamServices, dreamRunId, runDreamConsolidation } from "./run"
import type { DreamRunStatus } from "./runs"

export type { DreamKind } from "./plan"

/** The deploy-only Dream Workflow binding as the dispatcher needs it. */
export interface DreamWorkflowLike {
  create(options: {
    id: string
    params: { principal: Principal; runId: string; kind: DreamKind }
  }): Promise<unknown>
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

/** Dispatch (or run inline) a dream for one principal's tenant. */
export const dispatchDreamRun = async (
  env: DreamDispatchEnv,
  principal: Principal,
  kind: DreamKind = "all",
): Promise<DreamDispatchResult> => {
  const runId = dreamRunId(principal.tenantId)
  const workflow = env.DREAM
  if (workflow) {
    try {
      await workflow.create({
        id: await workflowInstanceId(`${runId}-${kind}`),
        params: { principal, runId, kind },
      })
      return { runId, status: "queued" }
    } catch (err) {
      if (isDuplicateInstanceError(err)) return { runId, status: "running" }
      throw err // a real dispatch failure — never swallowed
    }
  }

  // Inline (local/test): run the plan's groups in order, worst-of status. A group that throws
  // records 'failure' but never aborts the sweep — so the digest still runs (must ALWAYS be written).
  const statuses: DreamRunStatus[] = []
  let consolidationPaused = false
  // An EXHAUSTIVE switch (not a kind→runner map): reflection (per-insight KG) and dedup (a bespoke
  // step-loop in the workflow arm) each need special-casing, so a map would collapse only 2 of 4
  // arms while adding cases — the `never` default below is the real drift guard, so the switch stays.
  for (const step of dreamStepPlan(runId, kind)) {
    switch (step.group) {
      case "consolidation":
        try {
          const r = await runDreamConsolidation(createDreamServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
          if (r.status === "paused") consolidationPaused = true
        } catch (err) {
          console.error("dream consolidation failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "reflection":
        if (consolidationPaused) break // budget exhausted by consolidation → skip reflection (#9)
        try {
          const r = await runDreamReflection(createDreamReflectServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
        } catch (err) {
          console.error("dream reflection failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "digest":
        try {
          const r = await runDreamDigest(createDreamDigestServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
        } catch (err) {
          console.error("dream digest failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "dedup":
        try {
          const r = await runDreamDedup(createDreamDedupServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
        } catch (err) {
          console.error("dream dedup failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "hygiene":
        try {
          const r = await runDreamHygiene(createDreamHygieneServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
        } catch (err) {
          console.error("dream hygiene failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "entitypages":
        try {
          const r = await runDreamEntityPages(createDreamEntityPagesServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
        } catch (err) {
          console.error("dream entitypages failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "indexes":
        try {
          const r = await runDreamIndexes(createDreamIndexesServices(env, principal), {
            runId: step.runId,
          })
          statuses.push(r.status)
        } catch (err) {
          console.error("dream indexes failed", step.runId, err)
          statuses.push("failure")
        }
        break
      case "snapshot":
        // W2.2 terminal: refresh the session-context snapshot (embeds tonight's digest). Non-fatal.
        try {
          await refreshSessionContextSnapshot(createSessionServices(env, principal))
        } catch (err) {
          console.error("session-context refresh failed", step.runId, err)
        }
        break
      default: {
        const _exhaustive: never = step.group
        throw new Error(`unknown dream step group: ${String(_exhaustive)}`)
      }
    }
  }
  return { runId, status: worstStatus(statuses) }
}

/**
 * `DreamWorkflow` — the deploy-time durable wrapper around the dream step groups (v2 W1).
 *
 * Iterates the SHARED `dreamStepPlan` (the SAME plan the inline `dispatchDreamRun` uses — #20) so
 * the two dispatch paths can't diverge on which groups run, in what order, or under which run ids.
 * Each group is a durable `step.do()` with counts-only output (< 1 MiB). Reflection runs AFTER
 * consolidation and is SKIPPED when consolidation returned `paused` (budget exhausted). Being the
 * NORMAL ingest spine, insight docs are KG-extracted here — ONE `step.do` per insight id so a
 * workflow retry never re-pays a completed extraction. The overall status is the worst-of the
 * groups (failure > paused > success).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import {
  createDreamDedupServices,
  createDreamDigestServices,
  createDreamEntityPagesServices,
  createDreamHygieneServices,
  createDreamIndexesServices,
  createDreamReflectServices,
  createDreamServices,
  createScopedServices,
  createSessionServices,
  type DreamKind,
  type DreamRunStatus,
  dreamStepPlan,
  refreshSessionContextSnapshot,
  runDreamConsolidation,
  runDreamDedup,
  runDreamDigest,
  runDreamEntityPages,
  runDreamHygiene,
  runDreamIndexes,
  runDreamReflection,
  worstStatus,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import type { ApiBindings } from "../bindings"
import { runEntityExtraction } from "../entity-extraction"

/** The serializable payload the `DreamWorkflow` carries (runId = the dispatcher's `dreamRunId`). */
export interface DreamWorkflowParams {
  principal: Principal
  runId: string
  kind: DreamKind
}

interface DreamWorkflowResult {
  runId: string
  kind: DreamKind
  status: DreamRunStatus
  insights: number
}

export class DreamWorkflow extends WorkflowEntrypoint<ApiBindings, DreamWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<DreamWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<DreamWorkflowResult> {
    const { principal, runId, kind } = event.payload
    const statuses: DreamRunStatus[] = []
    let insights = 0
    let consolidationPaused = false

    // An EXHAUSTIVE switch (not a kind→runner map): reflection (per-insight KG extraction) and dedup
    // (the bespoke step-loop below) each need special-casing, so a map would collapse only 2 of 4
    // arms while adding cases — the `never` default is the real drift guard, so the switch stays.
    for (const planStep of dreamStepPlan(runId, kind)) {
      switch (planStep.group) {
        case "consolidation": {
          // A group failure returns 'failure' (recorded in its run row by runDreamJob) WITHOUT
          // throwing out of the step, so the workflow proceeds to the digest.
          const r = await step.do("dream-consolidation", async () => {
            try {
              const res = await runDreamConsolidation(createDreamServices(this.env, principal), {
                runId: planStep.runId,
              })
              return { status: res.status }
            } catch (err) {
              console.error("dream consolidation failed", planStep.runId, err)
              return { status: "failure" as DreamRunStatus }
            }
          })
          statuses.push(r.status)
          if (r.status === "paused") consolidationPaused = true
          break
        }
        case "reflection": {
          if (consolidationPaused) break // budget exhausted → skip reflection (#9)
          const reflect = await step.do("dream-reflection", async () => {
            try {
              const res = await runDreamReflection(
                createDreamReflectServices(this.env, principal),
                {
                  runId: planStep.runId,
                },
              )
              return { status: res.status, insightIds: res.insightDocumentIds }
            } catch (err) {
              console.error("dream reflection failed", planStep.runId, err)
              return { status: "failure" as DreamRunStatus, insightIds: [] as string[] }
            }
          })
          statuses.push(reflect.status)
          insights = reflect.insightIds.length
          // One durable step per insight → a retry re-pays only the incomplete extractions (#10).
          for (const id of reflect.insightIds) {
            await step.do(`dream-reflection-kg-${id}`, async () => {
              const services = createScopedServices(this.env, principal)
              try {
                await runEntityExtraction(services, id)
                return { documentId: id, extracted: 1 }
              } catch (err) {
                console.error("dream reflection KG extraction failed", id, err)
                return { documentId: id, extracted: 0 } // non-fatal: insight stays searchable/cited
              }
            })
          }
          break
        }
        case "hygiene": {
          // LLM-free bulk-SQL sweep (fact decay + notability) — one durable step, counts-only out.
          const h = await step.do("dream-hygiene", async () => {
            try {
              const res = await runDreamHygiene(createDreamHygieneServices(this.env, principal), {
                runId: planStep.runId,
              })
              return { status: res.status }
            } catch (err) {
              console.error("dream hygiene failed", planStep.runId, err)
              return { status: "failure" as DreamRunStatus }
            }
          })
          statuses.push(h.status)
          break
        }
        case "indexes": {
          // LLM-free, deterministic index regeneration (root + per-namespace) — single durable step;
          // namespaces are few, so unlike dedup/entitypages it needs no chunk loop.
          const ix = await step.do("dream-indexes", async () => {
            try {
              const res = await runDreamIndexes(createDreamIndexesServices(this.env, principal), {
                runId: planStep.runId,
              })
              return { status: res.status }
            } catch (err) {
              console.error("dream indexes failed", planStep.runId, err)
              return { status: "failure" as DreamRunStatus }
            }
          })
          statuses.push(ix.status)
          break
        }
        case "digest": {
          // Digest runs even when consolidation paused — the digest must ALWAYS be written.
          const d = await step.do("dream-digest", async () => {
            try {
              const res = await runDreamDigest(createDreamDigestServices(this.env, principal), {
                runId: planStep.runId,
              })
              return { status: res.status }
            } catch (err) {
              console.error("dream digest failed", planStep.runId, err)
              return { status: "failure" as DreamRunStatus }
            }
          })
          statuses.push(d.status)
          break
        }
        case "dedup": {
          // The sweep can exceed workerd's subrequest cap on a big tenant, so it is CHUNKED across
          // step.do calls: each processes ≤ DEDUP_STEP_ITEMS entities and reports a `stopReason`.
          // We loop while it stops on `'page'` (more to do, budget fine); a `'budget'` stop or a
          // clean `'success'` (stopReason null) ends the loop. MAX_DEDUP_STEPS is a runaway guard.
          const DEDUP_STEP_ITEMS = 50
          const MAX_DEDUP_STEPS = 200
          let last: { status: DreamRunStatus; stopReason: "budget" | "page" | null } = {
            status: "success",
            stopReason: null,
          }
          for (let i = 0; i < MAX_DEDUP_STEPS; i++) {
            const dd = await step.do(`dream-dedup-${i}`, async () => {
              try {
                const res = await runDreamDedup(createDreamDedupServices(this.env, principal), {
                  runId: planStep.runId,
                  maxItemsPerInvocation: DEDUP_STEP_ITEMS,
                })
                return { status: res.status, stopReason: res.stopReason }
              } catch (err) {
                console.error("dream dedup failed", planStep.runId, err)
                return { status: "failure" as DreamRunStatus, stopReason: null }
              }
            })
            last = dd
            if (dd.stopReason !== "page") break // success / budget / failure → done looping
          }
          statuses.push(last.status)
          break
        }
        case "entitypages": {
          // Entity-page backfill: like dedup, CHUNKED across step.do calls (each ≤ EP_STEP_ITEMS
          // entities, reporting a stopReason). Loop while it stops on 'page'; 'budget'/'success'/
          // 'failure' ends the loop. EP is LLM-free, so 'budget' is rare (only a fully-spent tenant).
          const EP_STEP_ITEMS = 100
          const MAX_EP_STEPS = 200
          let last: { status: DreamRunStatus; stopReason: "budget" | "page" | null } = {
            status: "success",
            stopReason: null,
          }
          for (let i = 0; i < MAX_EP_STEPS; i++) {
            const ep = await step.do(`dream-entitypages-${i}`, async () => {
              try {
                const res = await runDreamEntityPages(
                  createDreamEntityPagesServices(this.env, principal),
                  { runId: planStep.runId, maxItemsPerInvocation: EP_STEP_ITEMS },
                )
                return { status: res.status, stopReason: res.stopReason }
              } catch (err) {
                console.error("dream entitypages failed", planStep.runId, err)
                return { status: "failure" as DreamRunStatus, stopReason: null }
              }
            })
            last = ep
            if (ep.stopReason !== "page") break
          }
          statuses.push(last.status)
          break
        }
        case "snapshot": {
          // W2.2 terminal: refresh the session-context snapshot (embeds tonight's digest) as its own
          // durable step; a failure never fails the dream. Iterated via the plan (not a bolt-on).
          await step.do("session-context-refresh", async () => {
            try {
              const r = await refreshSessionContextSnapshot(
                createSessionServices(this.env, principal),
              )
              return { refreshed: r.refreshed }
            } catch (err) {
              console.error("session-context refresh failed", planStep.runId, err)
              return { refreshed: false }
            }
          })
          break
        }
        default: {
          const _exhaustive: never = planStep.group
          throw new Error(`unknown dream step group: ${String(_exhaustive)}`)
        }
      }
    }

    return { runId, kind, status: worstStatus(statuses), insights }
  }
}

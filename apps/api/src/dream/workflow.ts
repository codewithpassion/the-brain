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
  createDreamDigestServices,
  createDreamReflectServices,
  createDreamServices,
  createScopedServices,
  type DreamKind,
  type DreamRunStatus,
  dreamStepPlan,
  runDreamConsolidation,
  runDreamDigest,
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
        default: {
          const _exhaustive: never = planStep.group
          throw new Error(`unknown dream step group: ${String(_exhaustive)}`)
        }
      }
    }

    return { runId, kind, status: worstStatus(statuses), insights }
  }
}

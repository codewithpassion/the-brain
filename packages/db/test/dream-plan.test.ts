import { describe, expect, test } from "bun:test"
import { DREAM_KINDS, dreamStepPlan, reflectionRunId, worstStatus } from "../src/dream/plan"

/**
 * Pure-function coverage for the dream step-plan layer (v2 W1) — the SINGLE source both the
 * `DreamWorkflow` and the inline `dispatchDreamRun` iterate. Proves the kind→steps ordering, the
 * per-step run-id derivation (#1/#20), and the worst-of status aggregation (#3).
 */

describe("dreamStepPlan — the shared kind→steps mapping", () => {
  test("'all' → consolidation, reflection, digest in order, each with its derived run id", () => {
    const steps = dreamStepPlan("dream-t-20260702", "all")
    expect(steps.map((s) => s.group)).toEqual(["consolidation", "reflection", "digest"])
    expect(steps[0]?.runId).toBe("dream-t-20260702")
    expect(steps[1]?.runId).toBe(reflectionRunId("dream-t-20260702"))
    expect(steps[1]?.runId).toBe("dream-t-20260702-reflection")
    // The digest is a terminal step keyed by the base run id (it has no run row of its own).
    expect(steps[2]?.runId).toBe("dream-t-20260702")
  })

  test("digest is present only for 'all' (not consolidation-only / reflection-only)", () => {
    expect(dreamStepPlan("b", "consolidation").some((s) => s.group === "digest")).toBe(false)
    expect(dreamStepPlan("b", "reflection").some((s) => s.group === "digest")).toBe(false)
    expect(dreamStepPlan("b", "all").some((s) => s.group === "digest")).toBe(true)
  })

  test("'consolidation' → only the consolidation step (base run id)", () => {
    const steps = dreamStepPlan("base", "consolidation")
    expect(steps).toEqual([{ group: "consolidation", runId: "base" }])
  })

  test("'reflection' → only the reflection step (suffixed run id)", () => {
    const steps = dreamStepPlan("base", "reflection")
    expect(steps).toEqual([{ group: "reflection", runId: "base-reflection" }])
  })

  test("'dedup' → only the dedup step (suffixed run id); NOT part of 'all'", () => {
    expect(dreamStepPlan("base", "dedup")).toEqual([{ group: "dedup", runId: "base-dedup" }])
    // Dedup is a standalone sweep (graph hygiene), deliberately excluded from the nightly 'all'.
    expect(dreamStepPlan("base", "all").some((s) => s.group === "dedup")).toBe(false)
  })

  test("DREAM_KINDS is the single kind set", () => {
    expect([...DREAM_KINDS]).toEqual(["consolidation", "reflection", "dedup", "all"])
  })
})

describe("worstStatus — worst-of aggregation across step groups", () => {
  test("failure dominates everything", () => {
    expect(worstStatus(["success", "paused", "failure"])).toBe("failure")
  })

  test("paused dominates success/running (a paused consolidation stays visible)", () => {
    expect(worstStatus(["success", "paused"])).toBe("paused")
    expect(worstStatus(["running", "paused"])).toBe("paused")
  })

  test("all-success → success; empty → success", () => {
    expect(worstStatus(["success", "success"])).toBe("success")
    expect(worstStatus([])).toBe("success")
  })
})

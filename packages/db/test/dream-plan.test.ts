import { describe, expect, test } from "bun:test"
import { DREAM_KINDS, dreamStepPlan, reflectionRunId, worstStatus } from "../src/dream/plan"

/**
 * Pure-function coverage for the dream step-plan layer (v2 W1) — the SINGLE source both the
 * `DreamWorkflow` and the inline `dispatchDreamRun` iterate. Proves the kind→steps ordering, the
 * per-step run-id derivation (#1/#20), and the worst-of status aggregation (#3).
 */

describe("dreamStepPlan — the shared kind→steps mapping", () => {
  test("'all' → consolidation, reflection, hygiene, digest in order, each with its derived run id", () => {
    const steps = dreamStepPlan("dream-t-20260702", "all")
    expect(steps.map((s) => s.group)).toEqual([
      "consolidation",
      "reflection",
      "hygiene",
      "digest",
      "snapshot",
    ])
    expect(steps[0]?.runId).toBe("dream-t-20260702")
    expect(steps[1]?.runId).toBe(reflectionRunId("dream-t-20260702"))
    expect(steps[1]?.runId).toBe("dream-t-20260702-reflection")
    // Hygiene (D5) runs after reflection, before digest, with its own `-hygiene` run row.
    expect(steps[2]?.runId).toBe("dream-t-20260702-hygiene")
    // The digest + the W2 session-context snapshot are terminal steps keyed by the base run id.
    expect(steps[3]?.runId).toBe("dream-t-20260702")
    expect(steps[4]?.group).toBe("snapshot")
    expect(steps[4]?.runId).toBe("dream-t-20260702")
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

  test("'hygiene' → only the hygiene step (suffixed run id); IS part of 'all'", () => {
    expect(dreamStepPlan("base", "hygiene")).toEqual([{ group: "hygiene", runId: "base-hygiene" }])
    // Hygiene (D5, LLM-free) runs nightly as part of 'all'.
    expect(dreamStepPlan("base", "all").some((s) => s.group === "hygiene")).toBe(true)
  })

  test("'entitypages' → only the entity-page backfill step (suffixed run id); NOT part of 'all'", () => {
    expect(dreamStepPlan("base", "entitypages")).toEqual([
      { group: "entitypages", runId: "base-entitypages" },
    ])
    // Standalone graph-hygiene sweep (like dedup), deliberately excluded from the nightly 'all'.
    expect(dreamStepPlan("base", "all").some((s) => s.group === "entitypages")).toBe(false)
  })

  test("DREAM_KINDS is the single kind set", () => {
    expect([...DREAM_KINDS]).toEqual([
      "consolidation",
      "reflection",
      "dedup",
      "hygiene",
      "entitypages",
      "all",
    ])
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

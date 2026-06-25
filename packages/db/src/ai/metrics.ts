/**
 * Ops-metrics interface + no-op default (PRD §10).
 *
 * The Analytics Engine binding lands in Phase 1e; defining the interface + a no-op now
 * lets the chokepoints and the factory compile and accept a metrics sink today without a
 * binding. The no-op records nothing.
 */

export interface AiCallMetric {
  model: string
  tenantId: string
  surface: string
  ok: boolean
  degraded: boolean
}

export interface OpsMetrics {
  recordAiCall(metric: AiCallMetric): void
}

export const noopOpsMetrics: OpsMetrics = {
  recordAiCall(): void {
    // no-op until the Analytics Engine binding lands (Phase 1e)
  },
}

/**
 * Ops-metrics interface + a concrete Analytics Engine sink + a no-op default (PRD §10).
 *
 * Two event kinds flow through one sink:
 *   - `recordAiCall` — one `embed()/gen()/rerank()` chokepoint call (model, ok, degraded).
 *   - `recordOpCall` — one op invocation across ANY surface (op name, tenant, latency, status).
 *
 * The concrete impl writes one Analytics Engine data point per event (`writeDataPoint`), keyed by
 * `tenantId` so per-tenant rollups are queryable. The AE binding has NO local emulation, so it is
 * OPTIONAL on `BrainBindings`: when the dataset is absent (local/test) `createOpsMetrics` returns
 * the no-op, and nothing is recorded — the surface layer never branches on binding presence.
 */

export interface AiCallMetric {
  model: string
  tenantId: string
  surface: string
  ok: boolean
  degraded: boolean
}

/** One op invocation across MCP / tRPC / CLI / REST — the per-call ops observability row. */
export interface OpCallMetric {
  op: string
  tenantId: string
  surface: string
  /** Wall-clock latency of the handler, milliseconds. */
  latencyMs: number
  /** `"ok"` | `"error"` | `"forbidden"` | … (the dispatch outcome). */
  status: string
}

export interface OpsMetrics {
  recordAiCall(metric: AiCallMetric): void
  recordOpCall(metric: OpCallMetric): void
}

/** Records nothing — the default when the Analytics Engine binding is absent. */
export const noopOpsMetrics: OpsMetrics = {
  recordAiCall(): void {
    // no-op until the Analytics Engine binding is wired
  },
  recordOpCall(): void {
    // no-op until the Analytics Engine binding is wired
  },
}

/**
 * Build the concrete Analytics Engine sink. `writeDataPoint` is fire-and-forget (no await, never
 * throws on the hot path). `indexes: [tenantId]` is the sampling key (per-tenant rollups); `blobs`
 * carry the string dimensions, `doubles` the numerics. Returns the no-op when `dataset` is absent.
 */
export const createOpsMetrics = (dataset?: AnalyticsEngineDataset): OpsMetrics => {
  if (dataset === undefined) return noopOpsMetrics
  return {
    recordAiCall(metric): void {
      dataset.writeDataPoint({
        indexes: [metric.tenantId],
        blobs: ["ai", metric.model, metric.surface],
        doubles: [metric.ok ? 1 : 0, metric.degraded ? 1 : 0],
      })
    },
    recordOpCall(metric): void {
      dataset.writeDataPoint({
        indexes: [metric.tenantId],
        blobs: ["op", metric.op, metric.surface, metric.status],
        doubles: [metric.latencyMs],
      })
    },
  }
}

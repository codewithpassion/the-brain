/**
 * Re-export shim — the concrete `SearchDeps` ports now live canonically in `@brain/db`
 * (`packages/db/src/search/ports.ts`) so REST, tRPC, and MCP bind ONE copy of the enforcing
 * cost cap + recall-trace + spend-attribution logic (no drift). This file keeps the historic
 * apps/api import paths (`./ports`) working for the REST routes + the backfill sweep.
 */
export {
  CostCeilingError,
  MONTHLY_NEURON_CEILING,
  makeBudgetPort,
  makeRecallSink,
  monthlyWindow,
  recordThinkSpend,
  USD_PER_NEURON,
} from "@brain/db"

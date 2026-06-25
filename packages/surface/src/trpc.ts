/**
 * `buildTrpcRouter` — project the catalog into a tRPC `appRouter` (PRD §9.1). Each op becomes ONE
 * procedure keyed by `op.def.name`: a `read` op (readOnly) → `query` on `protectedProcedure`; a
 * mutating op → `mutation` on `writeProcedure` (the read/write axis). EVERY resolver additionally
 * runs `scopeSatisfied(op.capability, principal)` → `FORBIDDEN` (the INDEPENDENT capability axis —
 * `writeProcedure` only checks `readOnly`, so e.g. `get_token_spend` (admin, readOnly) still needs
 * its admin gate). Input is validated by the op's frozen Zod schema; the handler runs via the
 * uniform catalog `invoke`. Per-call ops metrics (op, tenant, latency, status) are emitted through
 * the shared Analytics-Engine sink (no-op when the binding is absent).
 *
 * Only `"rest"`-surface ops become procedures (the tRPC↔rest mapping — see README in index.ts).
 *
 * TYPING NOTE: the router is generated from the catalog at runtime, so the exported `AppRouter`
 * carries procedure NAMES + the runtime contract but not per-procedure input/output inference
 * (the catalog erases op generics). Consumers (CLI/dashboard) get strong arg typing from the
 * shared Zod op schemas; richer end-to-end inference is a deferral for those agents.
 */
import { createOpsMetrics } from "@brain/db"
import { scopeSatisfied } from "@brain/shared"
import { TRPCError } from "@trpc/server"
import { buildCatalog, type SurfaceOp } from "./catalog"
import { protectedProcedure, router, writeProcedure } from "./context"

const buildProcedure = (op: SurfaceOp) => {
  const withInput = (op.def.readOnly ? protectedProcedure : writeProcedure).input(op.def.input)
  const resolve = async ({
    ctx,
    input,
  }: {
    ctx: import("./context").SurfaceContext
    input: unknown
  }) => {
    if (!scopeSatisfied(op.def.capability, ctx.principal)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `${op.def.capability} capability required`,
      })
    }
    const metrics = createOpsMetrics(ctx.env.ANALYTICS)
    const startedAt = Date.now()
    try {
      const out = await op.invoke(ctx, input)
      metrics.recordOpCall({
        op: op.def.name,
        tenantId: ctx.principal.tenantId,
        surface: ctx.surface,
        latencyMs: Date.now() - startedAt,
        status: "ok",
      })
      return out
    } catch (error) {
      metrics.recordOpCall({
        op: op.def.name,
        tenantId: ctx.principal.tenantId,
        surface: ctx.surface,
        latencyMs: Date.now() - startedAt,
        status: error instanceof TRPCError ? error.code : "error",
      })
      throw error
    }
  }
  return op.def.readOnly ? withInput.query(resolve) : withInput.mutation(resolve)
}

/** Build the tRPC `appRouter` from the catalog (every `"rest"`-surface op → one procedure). */
export const buildTrpcRouter = (catalog: readonly SurfaceOp[] = buildCatalog()) => {
  const record: Record<string, ReturnType<typeof buildProcedure>> = {}
  for (const op of catalog) {
    if (op.def.surfaces.includes("rest")) record[op.def.name] = buildProcedure(op)
  }
  return router(record)
}

/** The default deployed router + its type (the CLI/dashboard import `type { AppRouter }`). */
export const appRouter = buildTrpcRouter()
export type AppRouter = typeof appRouter

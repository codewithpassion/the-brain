/**
 * The surface runtime context + the tRPC primitives every generated procedure is built on.
 *
 * A `SurfaceContext` is what an op handler needs to run, INDEPENDENT of which surface invoked it:
 * the resolved `Principal` (already produced by `resolvePrincipal` at the edge — invariant 17),
 * the binding `env` (handlers build their own tenant-scoped services from it inside `@brain/db`;
 * the surface layer never touches a raw binding), a `waitUntil` for off-read-path writes
 * (invariants 10/16), and a `surface` label for attribution. The SAME context shape backs the
 * tRPC mount, the MCP agent, and the CLI bridge — that is what keeps the three from drifting.
 */
import type { BrainBindings } from "@brain/db"
import type { OpSurface, Principal } from "@brain/shared"
import { initTRPC, TRPCError } from "@trpc/server"

/** A Workflow binding as the surface layer needs it (deploy-only; absent locally → inline path). */
export interface WorkflowLike {
  create(options: { id: string; params: unknown }): Promise<unknown>
}

/**
 * The binding env the surface layer sees: the frozen `BrainBindings` plus the OPTIONAL deploy-only
 * Workflow bindings a couple of ops dispatch to (absent in local/test → the op runs inline).
 */
export type SurfaceEnv = BrainBindings & {
  SESSION_PROMOTE?: WorkflowLike
  BATCH_INGEST?: WorkflowLike
}

/** The per-request context handed to every op `invoke` (and the tRPC procedure context). */
export interface SurfaceContext {
  principal: Principal
  env: SurfaceEnv
  waitUntil: (promise: Promise<unknown>) => void
  /** The calling surface (`"rest"` for tRPC, per the tRPC↔rest mapping; see README in index.ts). */
  surface: OpSurface
}

/** Assemble a `SurfaceContext` (called by the tRPC mount / MCP agent / CLI bridge). */
export const createTrpcContext = (
  env: SurfaceEnv,
  principal: Principal,
  waitUntil: (promise: Promise<unknown>) => void,
): SurfaceContext => ({ principal, env, waitUntil, surface: "rest" })

const t = initTRPC.context<SurfaceContext>().create()

export const router = t.router
export const createCallerFactory = t.createCallerFactory

/**
 * `protectedProcedure` — the choke-point: a request with no resolved `Principal` is `UNAUTHORIZED`
 * (defence-in-depth; the edge already 401s a credential-less request). Read ops build on this.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.principal === undefined) throw new TRPCError({ code: "UNAUTHORIZED" })
  return next({ ctx })
})

/**
 * `writeProcedure` — mutations build on this: a `readOnly` principal is `FORBIDDEN` BEFORE dispatch
 * (the read/write axis). NOTE this gate checks ONLY `readOnly`; the per-op CAPABILITY gate
 * (`scopeSatisfied(op.capability, …)`) is applied INSIDE every resolver — the two are independent
 * (a non-read-only `member` still has no `admin` capability).
 */
export const writeProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.readOnly) throw new TRPCError({ code: "FORBIDDEN" })
  return next({ ctx })
})

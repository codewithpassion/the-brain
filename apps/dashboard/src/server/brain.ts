/**
 * SERVER-ONLY data layer. This module is imported exclusively from `createServerFn` handlers, so it
 * is stripped from the browser bundle — the raw API bearer + the tenant pin never reach the client
 * (invariant 17). It holds the credential and dispatches to the deployed `apps/api` `/trpc` surface
 * using the SAME real `@trpc/client` transport the CLI uses, dispatching by op NAME (so no
 * `dashboard → api` runtime edge exists; only the procedure names cross the wire).
 *
 * ROUTER TYPING NOTE: the CLI parameterizes the client with `type { AppRouter } from "@brain/surface"`.
 * Here it is typed with `AnyTRPCRouter` instead. Reason: a type-only `AppRouter` import transitively
 * pulls the whole `@brain/db` source (with its `@cloudflare/workers-types` globals) into this app's
 * tsc program, which then collides with the `DOM` lib the React UI requires (a TS6 `BufferSource`
 * typed-array variance in `@brain/db/src/auth/tokens.ts`). The `AppRouter` generic buys NOTHING here:
 * the op-registry catalog erases per-procedure IO inference (see `packages/surface/src/trpc.ts`), so
 * BOTH surfaces dispatch by name over erased types. Re-adding `AppRouter` is a one-liner once
 * `@brain/surface` ships prebuilt `.d.ts` (so tsc stops traversing `@brain/db` source).
 *
 * Auth flow per request: Clerk `auth()` (server-side) → verified `userId` + a fresh Clerk session
 * JWT (`getToken()`). The active tenant is COMPUTED on the server as `org_${userId}` (the brain's
 * deterministic per-user org id — `tenantPinFor`), NEVER taken from client input, and sent as
 * `X-Brain-Tenant`. The API re-verifies the JWT against Clerk JWKS and re-checks membership, so a
 * forged tenant header changes nothing.
 */

import { env } from "cloudflare:workers"
import { auth } from "@clerk/tanstack-react-start/server"
import { createTRPCClient, httpBatchLink } from "@trpc/client"
import type { AnyTRPCRouter } from "@trpc/server"
import { tenantPinFor } from "./tenant"

/** The deployed API origin. Used only when no service binding is available (local dev). */
const apiUrl = (): string =>
  (process.env.BRAIN_API_URL ?? "http://localhost:8787").replace(/\/$/, "")

/** One tRPC procedure as the dynamic-by-name dispatcher sees it (IO erased by the catalog). */
interface DynamicProcedure {
  query: (input: unknown) => Promise<unknown>
  mutate: (input: unknown) => Promise<unknown>
}

/** The exact fetch shape `httpBatchLink.fetch` accepts (tRPC's `FetchEsque`, derived not imported). */
type TrpcFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>

/** A fetch that attaches the server-held bearer + the server-pinned tenant to every API call.
 *  In production, routes through the BRAIN_API service binding (avoids worker-to-worker loopback).
 *  In local dev (no binding), falls back to global fetch against the public URL. */
const authFetch =
  (token: string, tenant: string): TrpcFetch =>
  (input, init) => {
    const headers = new Headers((init as RequestInit | undefined)?.headers)
    headers.set("authorization", `Bearer ${token}`)
    headers.set("x-brain-tenant", tenant)
    // Route through the BRAIN_API service binding (typed by `wrangler types` →
    // worker-configuration.d.ts). A public-URL fetch to another Worker on the same
    // account is blocked by Cloudflare (error 1042); the binding avoids that.
    return env.BRAIN_API.fetch(input as Parameters<typeof fetch>[0], {
      ...(init as RequestInit),
      headers,
    })
  }

/** The resolved server-side session: the Clerk JWT + the server-computed tenant pin + the userId. */
export interface BrainAuth {
  token: string
  tenant: string
  userId: string
}

/**
 * Resolve the per-request credential + tenant pin from Clerk (server-side). Throws an Error the
 * server fn surfaces as `null`/unauthenticated when there is no signed-in user or no session token.
 */
export const resolveBrainAuth = async (): Promise<BrainAuth> => {
  const session = await auth()
  if (!session.userId) throw new Error("unauthenticated")
  const token = await session.getToken()
  if (!token) throw new Error("no session token")
  return { token, tenant: tenantPinFor(session.userId), userId: session.userId }
}

/**
 * Dispatch one registered op against the API by NAME (`query` for readOnly ops, `mutate` otherwise),
 * with the credential + tenant attached server-side. The result is typed by the caller (the catalog
 * erases inference); the API has already validated it against the op's frozen Zod schema.
 */
export const brainCall = async <T>(name: string, readOnly: boolean, input: unknown): Promise<T> => {
  const { token, tenant } = await resolveBrainAuth()
  const client = createTRPCClient<AnyTRPCRouter>({
    links: [httpBatchLink({ url: `${apiUrl()}/trpc`, fetch: authFetch(token, tenant) })],
  })
  const procedures = client as unknown as Record<string, DynamicProcedure | undefined>
  const procedure = procedures[name]
  if (!procedure) throw new Error(`unknown op: ${name}`)
  const out = readOnly ? procedure.query(input) : procedure.mutate(input)
  return out as Promise<T>
}

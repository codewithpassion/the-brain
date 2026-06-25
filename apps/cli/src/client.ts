/**
 * The typed tRPC client (PRD §9.1) — `createTRPCClient<AppRouter>` over `httpBatchLink` against the
 * API's `/trpc` mount. `AppRouter` is a **TYPE-ONLY** import from `@brain/surface`, so the Worker
 * runtime is erased and no `apps/cli → apps/api` edge exists (only the procedure NAMES + the runtime
 * contract cross the boundary; the catalog erases per-procedure IO inference, so dispatch is by name
 * and inputs are validated client-side against the SAME Zod op schema before the call).
 *
 * Every request carries `Authorization: Bearer <token>` and the active-tenant `X-Brain-Tenant`
 * header (the server still re-validates membership — a spoofed tenant changes nothing). On a `401`
 * with a device-flow refresh available, the bearer is refreshed ONCE and the request retried.
 * Tokens are attached here and NOWHERE logged (invariant 17).
 */
import type { AppRouter } from "@brain/surface"
import { createTRPCClient, httpBatchLink } from "@trpc/client"

/** The exact fetch shape `httpBatchLink.fetch` accepts (tRPC's `FetchEsque`, derived not imported). */
type TrpcFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>

export interface BrainClientOptions {
  apiUrl: string
  token: string
  tenant?: string
  /** Obtain a fresh bearer on a 401 (device-flow refresh + persist). Returns null when unavailable. */
  refresh?: () => Promise<string | null>
  /** Override the underlying fetch (tests / refresh wiring). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** One tRPC procedure as the dynamic-by-name dispatcher sees it (IO erased by the catalog). */
interface DynamicProcedure {
  query: (input: unknown) => Promise<unknown>
  mutate: (input: unknown) => Promise<unknown>
}

export interface BrainClient {
  /** Dispatch op `name` as a tRPC `query` (readOnly) or `mutation`, returning the raw result. */
  call: (name: string, readOnly: boolean, input: unknown) => Promise<unknown>
}

const withAuthHeaders = (
  init: RequestInit | undefined,
  bearer: string,
  tenant?: string,
): RequestInit => {
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${bearer}`)
  if (tenant) headers.set("x-brain-tenant", tenant)
  return { ...init, headers }
}

/**
 * A fetch wrapper that injects auth headers and refreshes the bearer ONCE on a 401. Typed as tRPC's
 * `FetchEsque` (the `httpBatchLink.fetch` option type); `init` is narrowed to `RequestInit` for the
 * underlying call, and `input` cast to the global `fetch` input (a superset of `FetchEsque`'s).
 */
const createAuthFetch = (options: BrainClientOptions): TrpcFetch => {
  const base = options.fetchImpl ?? fetch
  let bearer = options.token
  return async (input, init) => {
    const target = input as Parameters<typeof fetch>[0]
    const response = await base(
      target,
      withAuthHeaders(init as RequestInit, bearer, options.tenant),
    )
    if (response.status !== 401 || !options.refresh) return response
    const next = await options.refresh()
    if (!next) return response
    bearer = next
    return base(target, withAuthHeaders(init as RequestInit, bearer, options.tenant))
  }
}

/** Build a `BrainClient` for a resolved session (apiUrl + token + tenant). */
export const createBrainClient = (options: BrainClientOptions): BrainClient => {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${options.apiUrl.replace(/\/$/, "")}/trpc`,
        fetch: createAuthFetch(options),
      }),
    ],
  })
  const procedures = client as unknown as Record<string, DynamicProcedure | undefined>
  return {
    call: (name, readOnly, input) => {
      const procedure = procedures[name]
      if (!procedure) throw new Error(`unknown op: ${name}`)
      return readOnly ? procedure.query(input) : procedure.mutate(input)
    },
  }
}

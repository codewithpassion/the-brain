import { describe, expect, test } from "bun:test"
import { CAPTURE_TURN_OP, MINT_API_KEY_OP } from "@brain/db"
import type { Principal } from "@brain/shared"
import { SEARCH_OP } from "@brain/shared"
import { TRPCError } from "@trpc/server"
import type { SurfaceOp } from "../src/catalog"
import { createCallerFactory, type SurfaceContext } from "../src/context"
import { buildTrpcRouter } from "../src/trpc"

/**
 * tRPC router smoke (PRD §9.1): the GENERATED router routes a query + a mutation through the
 * read/write + capability gates, with STUB op invokes (no real bindings). Proves the generation
 * mechanism — `.input(zod)` validation, `query`/`mutation` split, `protectedProcedure`/
 * `writeProcedure`, the per-resolver `scopeSatisfied` gate, and `createCaller` — end to end.
 */

// Stub ops: a read query (search), a write mutation (capture_turn), an admin mutation (mint_api_key).
const stubOps: SurfaceOp[] = [
  { def: SEARCH_OP, invoke: async (_ctx, input) => ({ echoed: input }) },
  {
    def: CAPTURE_TURN_OP,
    invoke: async () => ({ brainSessionId: "s1", idx: 0, offloaded: false }),
  },
  { def: MINT_API_KEY_OP, invoke: async () => ({ token: "bk_stub", keyId: "k1" }) },
]

const router = buildTrpcRouter(stubOps)
const caller = (principal: Principal) =>
  createCallerFactory(router)({
    principal,
    env: {} as SurfaceContext["env"],
    waitUntil: () => {},
    surface: "rest",
  }) as unknown as Record<string, (input: unknown) => Promise<unknown>>

const ADMIN: Principal = {
  tenantId: "t1",
  userId: "u1",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
}
const READONLY: Principal = { ...ADMIN, role: "readonly", capabilities: ["read"], readOnly: true }
const MEMBER: Principal = { ...ADMIN, role: "member", capabilities: ["read", "write"] }

describe("tRPC smoke", () => {
  test("a read op routes as a query and validates input", async () => {
    const out = await caller(ADMIN).search({ query: "hello", topK: 5 })
    expect(out).toEqual({ echoed: { query: "hello", topK: 5 } })
  })

  test("a write op routes as a mutation", async () => {
    const out = await caller(ADMIN).capture_turn({
      sessionId: "s1",
      role: "user",
      content: "hi",
      client: "cli",
    })
    expect(out).toEqual({ brainSessionId: "s1", idx: 0, offloaded: false })
  })

  test("invalid input is rejected before the handler runs", async () => {
    const err = await caller(ADMIN)
      .search({ topK: 5 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe("BAD_REQUEST")
  })

  test("a read-only principal is FORBIDDEN from a mutation (writeProcedure)", async () => {
    const err = await caller(READONLY)
      .capture_turn({ sessionId: "s1", role: "user", content: "hi", client: "cli" })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe("FORBIDDEN")
  })

  test("a non-admin principal is FORBIDDEN from an admin op (scopeSatisfied gate)", async () => {
    const err = await caller(MEMBER)
      .mint_api_key({ name: "k" })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe("FORBIDDEN")
  })
})

import { env } from "cloudflare:test"
import {
  assembleSessionContext,
  type BrainBindings,
  createSessionServices,
  createSnapshot,
  getSessionContext,
  listSnapshots,
  refreshSessionContextIfStale,
  refreshSessionContextSnapshot,
  SESSION_CONTEXT_MAX_CHARS,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { beforeAll, describe, expect, test } from "vitest"

/**
 * THE session-context snapshot canary (v2 W2.1/W2.2) — assembles + refreshes against REAL local D1
 * in workerd. Proves the injection-safety contract: the snapshot is WORLD-visibility only (it lands
 * in arbitrary sessions), tenant-isolated, idempotent on unchanged inputs, size-capped, and surfaced
 * through get_session_context.
 */

const env_ = env as unknown as BrainBindings

const systemAdmin = (tenantId: string): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const services = (tenantId: string) => createSessionServices(env_, systemAdmin(tenantId))

const seedFact = async (opts: {
  tenantId: string
  fact: string
  visibility?: string
  notability?: string
  userId?: string | null
  teamId?: string | null
}): Promise<number> => {
  const res = await env_.DB.prepare(
    `INSERT INTO facts (tenant_id, user_id, team_id, fact, kind, visibility, notability, confidence,
                        valid_from, source, created_at)
     VALUES (?, ?, ?, ?, 'fact', ?, ?, 1.0, '2026-06-25T00:00:00.000Z', 'mcp:extract_facts', '2026-06-25T00:00:00.000Z')
     RETURNING id`,
  )
    .bind(
      opts.tenantId,
      opts.userId ?? null,
      opts.teamId ?? null,
      opts.fact,
      opts.visibility ?? "world",
      opts.notability ?? "medium",
    )
    .first<{ id: number }>()
  if (!res) throw new Error("seedFact: no id")
  return res.id
}

const makeInstruction = async (tenantId: string, factId: number): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO memory_use_policy (id, tenant_id, target_id, trust_grade, scopes)
     VALUES (?, ?, ?, 'instruction', '[]')`,
  )
    .bind(`pol-${tenantId}-${factId}`, tenantId, String(factId))
    .run()
}

beforeAll(async () => {
  // Tenant sa: a world instruction, a world fact, a private fact, a team fact.
  const instr = await seedFact({
    tenantId: "sa",
    fact: "INSTRUCTED always cite sources",
    notability: "high",
  })
  await makeInstruction("sa", instr)
  await seedFact({
    tenantId: "sa",
    fact: "WORLDFACT pricing is public",
    visibility: "world",
    notability: "high",
  })
  await seedFact({
    tenantId: "sa",
    fact: "PRIVATESECRET salary data",
    visibility: "private",
    userId: "someoneElse",
  })
  await seedFact({ tenantId: "sa", fact: "TEAMONLY roadmap", visibility: "team", teamId: "team-x" })

  // Tenant sb: a distinct world fact (isolation check).
  await seedFact({ tenantId: "sb", fact: "OTHERTENANT data", visibility: "world" })

  // Tenant sc: idempotency + get_session_context.
  await seedFact({ tenantId: "sc", fact: "SC world fact", visibility: "world" })

  // Tenant sd: size cap — 20 long instruction facts (readInstructionFacts caps at 20; content caps at 4KB).
  for (let i = 0; i < 20; i++) {
    const id = await seedFact({ tenantId: "sd", fact: `LONGFACT ${i} ${"x".repeat(400)}` })
    await makeInstruction("sd", id)
  }
})

describe("session-context snapshot canary (W2) — real local D1 in workerd", () => {
  test("assembles WORLD-visibility content only — never private or team text", async () => {
    const r = await refreshSessionContextSnapshot(services("sa"))
    expect(r.refreshed).toBe(true)
    const content = (await services("sa").sessions.getSessionContextSnapshot()) ?? ""
    expect(content).toContain("INSTRUCTED always cite") // instruction-grade, world
    expect(content).toContain("WORLDFACT pricing") // world fact
    expect(content).not.toContain("PRIVATESECRET") // private fact — never injected
    expect(content).not.toContain("TEAMONLY") // team fact — never injected (system principal, no teams)
    expect(content).toContain("## Standing instructions")
  })

  test("is tenant-isolated (no cross-contamination)", async () => {
    await refreshSessionContextSnapshot(services("sb"))
    const saContent = (await services("sa").sessions.getSessionContextSnapshot()) ?? ""
    const sbContent = (await services("sb").sessions.getSessionContextSnapshot()) ?? ""
    expect(saContent).not.toContain("OTHERTENANT")
    expect(sbContent).toContain("OTHERTENANT")
    expect(sbContent).not.toContain("WORLDFACT")
  })

  test("refresh no-ops on unchanged inputs (no churn)", async () => {
    await refreshSessionContextSnapshot(services("sc"))
    const second = await refreshSessionContextSnapshot(services("sc")) // inputs unchanged
    expect(second.refreshed).toBe(false)
  })

  test("get_session_context surfaces the snapshot (auto-injected)", async () => {
    // sc already refreshed above.
    const ctx = await getSessionContext(services("sc"), "no-such-session")
    expect(ctx.contextSnapshot ?? "").toContain("SC world fact")
    // The vestigial snapshotStubbed placeholder is gone.
    expect("snapshotStubbed" in ctx).toBe(false)
  })

  test("enforces the ~4KB size cap with deterministic truncation", async () => {
    await refreshSessionContextSnapshot(services("sd"))
    const content = (await services("sd").sessions.getSessionContextSnapshot()) ?? ""
    expect(content.length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_CHARS)
    expect(content.length).toBeGreaterThan(1000) // non-trivially filled
  })

  test("injection posture: framing preamble + blockquoted notable facts; instructions unquoted", async () => {
    const content = await assembleSessionContext(services("sa"))
    expect(content).toContain("Curated memory context") // one-line framing preamble
    expect(content).toContain("> - WORLDFACT pricing") // notable fact blockquoted (untrusted)
    expect(content).toContain("\n- INSTRUCTED always cite") // standing instruction UNQUOTED (vetted)
  })

  test("assembly is deterministic (byte-identical across two runs → no-churn holds)", async () => {
    const a = await assembleSessionContext(services("sa"))
    const b = await assembleSessionContext(services("sa"))
    expect(a).toBe(b)
  })

  test("(item 6) forget_fact marks the snapshot stale → the next cron sweep refreshes", async () => {
    const id = await seedFact({
      tenantId: "sfg",
      fact: "SFG doomed fact",
      visibility: "world",
      userId: "system",
    })
    await refreshSessionContextSnapshot(services("sfg"))
    expect((await services("sfg").sessions.getSessionContextSnapshot()) ?? "").toContain(
      "SFG doomed",
    )
    // Forget it (sets expired_at) → the watermark advances past the snapshot's createdAt.
    await services("sfg").sessions.forgetFact(id)
    const r = await refreshSessionContextIfStale(services("sfg"))
    expect(r.skipped).toBe(false) // staleness detected (not skipped)
    expect((await services("sfg").sessions.getSessionContextSnapshot()) ?? "").not.toContain(
      "SFG doomed",
    )
  })

  test("(item 9) create_snapshot teaching errors + list_snapshots exposes kind", async () => {
    const svc = services("sk")
    await seedFact({ tenantId: "sk", fact: "SK fact", visibility: "world" })
    // session-context is a singleton — a label/scope is a teaching error.
    await expect(createSnapshot(svc, "my-label", null, "session-context")).rejects.toThrow(
      /singleton/,
    )
    // pinned requires a label.
    await expect(createSnapshot(svc, undefined, null, "pinned")).rejects.toThrow(/requires.*label/)
    // A valid session-context create → the singleton; list_snapshots shows its kind.
    await createSnapshot(svc, undefined, null, "session-context")
    const rows = await listSnapshots(svc)
    expect(rows.some((s) => s.kind === "session-context")).toBe(true)
  })
})

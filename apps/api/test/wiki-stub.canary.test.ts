import { env } from "cloudflare:test"
import type { BrainBindings } from "@brain/db"
import type { Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext } from "@brain/surface"
import { beforeAll, describe, expect, test } from "vitest"
import { seedMembership, seedOrg } from "./seed"

/**
 * W4a fix-round: the ENTITY-STUB live path, exercised through the REAL surface op (`wiki_get_page`)
 * — not just the store — under a normal (non-system, no-team) OWNER principal, which is what the
 * deployed dashboard uses. Mirrors the reported live call `/wiki/entities/project/agentos`.
 */

const env_ = env as unknown as BrainBindings
const STAMP = "2026-01-01T00:00:00.000Z"

const ctxEnv = { ...env_ } as unknown as SurfaceContext["env"]

const owner = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
})

const ctxFor = (principal: Principal): SurfaceContext => ({
  principal,
  env: ctxEnv,
  waitUntil: () => {},
  surface: "rest",
})

const seedEntity = async (o: {
  id: string
  tenantId: string
  kind: string
  name: string
  visibility?: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
        mention_count, scope, visibility, team_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', 0, ?, ?, ?, ?, ?)`,
  )
    .bind(
      o.id,
      o.tenantId,
      o.kind,
      o.name,
      `${o.name} d`,
      null,
      o.visibility ?? "world",
      null,
      STAMP,
      STAMP,
    )
    .run()
}

const catalog = buildCatalog()
const wikiGetPageOp = catalog.find((o) => o.def.name === "wiki_get_page")

beforeAll(async () => {
  await seedOrg("wStub", "w-stub")
  await seedMembership({ tenantId: "wStub", userId: "ownerLive" })
  await seedEntity({ id: "eAgentOs", tenantId: "wStub", kind: "project", name: "AgentOs" })
})

describe("wiki_get_page entity stub — real op path, normal owner (W4a fix round)", () => {
  test("a world 'project' entity with no page returns a stub via the OP (mirrors the live 404 repro)", async () => {
    expect(wikiGetPageOp).toBeDefined()
    const out = (await wikiGetPageOp?.invoke(ctxFor(owner("wStub", "ownerLive")), {
      target: "entities/project/agentos",
    })) as {
      page: { stub?: boolean; page: { id: string }; entity?: { canonicalName: string } } | null
    }
    expect(out.page).not.toBeNull()
    expect(out.page?.stub).toBe(true)
    expect(out.page?.page.id).toBe("")
    expect(out.page?.entity?.canonicalName).toBe("AgentOs")
  })
})

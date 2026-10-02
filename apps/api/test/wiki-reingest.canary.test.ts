import { env } from "cloudflare:test"
import type { BrainBindings } from "@brain/db"
import type { Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext } from "@brain/surface"
import { beforeAll, expect, test } from "vitest"
import { seedMembership, seedOrg } from "./seed"

/**
 * Regression: editing a wiki page must dispatch a NEW ingest workflow. The instance id used to be
 * derived from tenant+documentId alone, so every edit after the first save reused it; Workflows
 * rejects a reused id, the error was only logged, and the page sat at status='pending' with no
 * chunks — invisible to search. The stub below rejects duplicate ids the same way Workflows does.
 */

const env_ = env as unknown as BrainBindings

const principal: Principal = {
  tenantId: "reingestA",
  userId: "ownerA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
}

const ids: string[] = []
const fakeWorkflow = {
  create: async ({ id }: { id: string }) => {
    if (ids.includes(id)) throw new Error(`instance ${id} already exists`)
    ids.push(id)
    return { id }
  },
}

const pending: Promise<unknown>[] = []
const ctx: SurfaceContext = {
  principal,
  env: { ...env_, BATCH_INGEST: fakeWorkflow } as unknown as SurfaceContext["env"],
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p)
  },
  surface: "mcp",
}

const save = buildCatalog().find((o) => o.def.name === "wiki_save_page")

beforeAll(async () => {
  await seedOrg("reingestA", "reingest-a")
  await seedMembership({ tenantId: "reingestA", userId: "ownerA" })
})

test("each edit of a wiki page dispatches a fresh BATCH_INGEST instance", async () => {
  if (save === undefined) throw new Error("wiki_save_page missing from catalog")
  for (const body of ["First version.", "Second version.", "Third version."]) {
    await save.invoke(ctx, { slug: "notes/reingest", type: "note", visibility: "world", body })
    await Promise.all(pending.splice(0))
  }
  expect(ids).toHaveLength(3)
  expect(new Set(ids).size).toBe(3)
})

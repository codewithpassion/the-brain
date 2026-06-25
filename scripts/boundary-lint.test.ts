import { describe, expect, test } from "bun:test"
import { scanRepo, scanText } from "./boundary-lint"

/**
 * The RED proof (invariant 2 backstop). A linter that only ever passes is a no-op, so this
 * test drives the scanner against a fixture that CONTAINS a real raw-binding violation and
 * asserts it is FLAGGED — and that clean handler code passes. The fixture path
 * (`apps/api/src/leaky-handler.ts`) is a stand-in for production code OUTSIDE packages/db;
 * if the rule ever silently stops firing, this goes red.
 */

const LEAKY = `import type { BrainBindings } from "@brain/db"

export const handler = async (env: BrainBindings, request: Request) => {
  const row = await env.DB.prepare("SELECT * FROM chunks WHERE id = ?").bind("x").first()
  const matches = await env.CHUNK_INDEX.query(values, { topK: 10 })
  const direct = drizzle(env.DB)
  const out = await env.AI.run("@cf/baai/bge-m3", { text: ["x"] })
  const cast = binding as R2Bucket
  return Response.json({ row, matches, direct, out, cast })
}`

const CLEAN = `import { createScopedServices } from "@brain/db"
import type { Principal } from "@brain/shared"

export const handler = async (services: ReturnType<typeof createScopedServices>) => {
  const rows = await services.db.getChunksByIds(["a", "b"])
  const hits = await services.vectors.query({ values: [], topK: 10 })
  return Response.json({ rows, hits })
}`

describe("boundary-lint RED proof (invariant 2)", () => {
  test("FLAGS raw bindings in production-shaped code outside packages/db", () => {
    const hits = scanText("apps/api/src/leaky-handler.ts", LEAKY)
    expect(hits.length).toBeGreaterThan(0)
    const rules = new Set(hits.map((h) => h.rule))
    // Each independent raw-binding access path is caught, not just the first.
    expect(rules.has("raw env.DB")).toBe(true)
    expect(rules.has("raw D1 .prepare()")).toBe(true)
    expect(rules.has("raw Vectorize binding")).toBe(true)
    expect(rules.has("raw drizzle(env.*)")).toBe(true)
    expect(rules.has("raw env.AI")).toBe(true)
    expect(rules.has("raw binding type")).toBe(true)
    // Reported with a real line/column so the gate output is actionable.
    const dbHit = hits.find((h) => h.rule === "raw env.DB")
    expect(dbHit?.line).toBe(4)
    expect(typeof dbHit?.col).toBe("number")
  })

  test("FLAGS the destructure-from-env bypass (const { CHUNK_INDEX } = env)", () => {
    const sneaky = `export const leak = async (env: BrainBindings) => {
  const { CHUNK_INDEX } = env
  return CHUNK_INDEX.query([], { topK: 5 })
}`
    const hits = scanText("apps/api/src/sneaky.ts", sneaky)
    expect(hits.some((h) => h.rule === "raw binding destructured from env")).toBe(true)
  })

  test("PASSES clean code that only touches the Scoped* chokepoints", () => {
    expect(scanText("apps/api/src/clean-handler.ts", CLEAN)).toEqual([])
  })

  test("does NOT flag a binding type merely MENTIONED in a comment or string", () => {
    const prose = `// this handler used to touch env.DB.prepare() directly — now it does not
/** Vectorize is reached only via ScopedVectorize. */
const note = "env.DB and R2Bucket live behind packages/db"
export const ok = 1`
    expect(scanText("apps/api/src/note.ts", prose)).toEqual([])
  })

  test("the real repo tree is clean (the gate's own invariant)", () => {
    expect(scanRepo(process.cwd())).toEqual([])
  })
})

/**
 * Phase 3.5 semantic entity dedup tests — `upsertEntityWithVectorDedup`.
 *
 * Uses bun:sqlite (same real SQLite D1 presents at runtime) + a fake/adversarial
 * `ScopedVectorize`, mirroring the `graph.test.ts` canary patterns.
 *
 * Gate cases (per team-lead brief):
 *  1. Same-kind entities with ≥0.85 cosine → merge into one (alias union, mention_count
 *     summed, no duplicate row).
 *  2. Below threshold (< 0.85) → stays separate (two rows created).
 *  3. Cross-tenant nearest match → NEVER merged (D1 re-check drops it — non-vacuous).
 *  4. Re-running extraction → idempotent (deterministic key hit, no new dupe).
 *  5. Within-batch ordering → two equal entities in one run collapse to one.
 */
import type { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import type { drizzle } from "drizzle-orm/bun-sqlite"
import { upsertEntityWithVectorDedup } from "../src/graph/dedup"
import { ScopedGraph } from "../src/graph/scoped-graph"
import { ScopedVectorize } from "../src/scoped/vectorize"
import { makeDb, principal } from "./helpers"

// ── Fake Vectorize infrastructure ────────────────────────────────────────────

/**
 * A static fake index: every query returns the pre-set `matches` regardless of the
 * query vector. Used for threshold and cross-tenant tests (controlled score).
 */
const staticFakeIndex = (matches: { id: string; score: number }[]) =>
  ({
    query: () =>
      Promise.resolve({
        matches: matches.map((m) => ({
          id: m.id,
          score: m.score,
          values: [] as number[],
          metadata: {} as Record<string, string>,
        })),
        count: matches.length,
      }),
    upsert: () => Promise.resolve({ mutationId: "fake-m" }),
  }) as unknown as Vectorize

/**
 * A stateful fake index: tracks upserted vectors and returns them on subsequent queries
 * with a fixed score. Used for within-batch ordering tests.
 */
const statefulFakeIndex = (returnScore: number) => {
  const stored = new Map<string, boolean>()
  return {
    query: () => {
      const matches = [...stored.keys()].map((id) => ({
        id,
        score: returnScore,
        values: [] as number[],
        metadata: {} as Record<string, string>,
      }))
      return Promise.resolve({ matches, count: matches.size })
    },
    upsert: (vectors: VectorizeVector[]) => {
      for (const v of vectors) stored.set(v.id, true)
      return Promise.resolve({ mutationId: "stateful-m" })
    },
  } as unknown as Vectorize
}

/** A stub embed function returning a fixed single-element vector per call. */
const makeEmbed =
  (vec: number[] | null) =>
  async (_texts: string[]): Promise<number[][] | null> =>
    vec === null ? null : _texts.map(() => vec)

/** Canonical minimal entity input. */
const baseInput = (overrides: Partial<Parameters<typeof upsertEntityWithVectorDedup>[3]> = {}) =>
  ({
    name: "Test Entity",
    kind: "concept",
    aliases: [],
    description: "a test entity",
    chunkIds: ["c1"],
    scope: null,
    visibility: "world" as const,
    teamId: null,
    ...overrides,
  }) satisfies Parameters<typeof upsertEntityWithVectorDedup>[3]

// ── Helper ────────────────────────────────────────────────────────────────────

const countEntities = (sqlite: Database): number =>
  (sqlite.query("SELECT count(*) AS n FROM entities").get() as { n: number }).n

const getEntity = (sqlite: Database, id: string) =>
  sqlite
    .query("SELECT canonical_name, aliases, mention_count FROM entities WHERE id = ?")
    .get(id) as { canonical_name: string; aliases: string; mention_count: number } | null

// ─────────────────────────────────────────────────────────────────────────────

describe("upsertEntityWithVectorDedup — Phase 3.5 semantic dedup", () => {
  let sqlite: Database
  let db: ReturnType<typeof drizzle>

  beforeEach(() => {
    const made = makeDb()
    sqlite = made.sqlite
    db = made.db
  })

  // ── 1. Merge case (score ≥ 0.85, same kind) ──────────────────────────────────

  test("two entities with different names but ≥0.85 similarity merge into one (alias union, mention_count summed)", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)

    // First entity: created fresh (no vector in index yet) — static fake returns empty.
    const emptyIndex = new ScopedVectorize(staticFakeIndex([]), p)
    const r1 = await upsertEntityWithVectorDedup(graph, emptyIndex, makeEmbed([0.1, 0.2]), {
      ...baseInput({ name: "John Smith", kind: "person", chunkIds: ["c1"] }),
    })
    expect(r1.embedded).toBe(true)
    expect(countEntities(sqlite)).toBe(1)

    // Second entity: "Johnny Smith" — fake index returns first entity's id with score 0.92.
    const hitIndex = new ScopedVectorize(staticFakeIndex([{ id: r1.id, score: 0.92 }]), p)
    const r2 = await upsertEntityWithVectorDedup(graph, hitIndex, makeEmbed([0.11, 0.21]), {
      ...baseInput({ name: "Johnny Smith", kind: "person", chunkIds: ["c2"] }),
    })

    // Must resolve to the SAME entity row — no new row created.
    expect(r2.id).toBe(r1.id)
    expect(countEntities(sqlite)).toBe(1) // no duplicate

    const row = getEntity(sqlite, r1.id)
    expect(row).not.toBeNull()
    // "Johnny Smith" (the new surface name) must appear in aliases.
    const aliases = JSON.parse(row?.aliases ?? "[]") as string[]
    expect(aliases).toContain("Johnny Smith")
    // mention_count = c1 (1) + c2 (1) = 2 (summed from both upserts).
    expect(row?.mention_count).toBe(2)
  })

  // ── 2. Below threshold (score < 0.85) → stays separate ───────────────────────

  test("below-threshold score (0.70) keeps entities separate — two rows created", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)

    const r1 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([]), p),
      makeEmbed([0.1, 0.2]),
      baseInput({ name: "Alpha Corp", kind: "org" }),
    )

    const r2 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([{ id: r1.id, score: 0.7 }]), p),
      makeEmbed([0.5, 0.9]),
      baseInput({ name: "Beta Corp", kind: "org", chunkIds: ["c2"] }),
    )

    expect(r2.id).not.toBe(r1.id) // distinct entities
    expect(countEntities(sqlite)).toBe(2) // two rows
  })

  // ── 3. Cross-tenant: D1 re-check MUST drop it (non-vacuous) ──────────────────

  test("cross-tenant nearest match is NEVER merged — D1 re-check drops the foreign id", async () => {
    // Insert an entity belonging to tenant t2 directly into the DB.
    sqlite.run(
      `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description,
         source_chunk_ids, mention_count, scope, visibility, team_id, created_at, updated_at)
       VALUES ('t2-ent', 't2', 'concept', 'Shared Concept', '[]', 'shared', '[]', 0, NULL, 'world', NULL,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )

    // t1 graph — adversarial fake index returns t2's id at high score 0.99.
    const p1 = principal({ tenantId: "t1" })
    const graph1 = new ScopedGraph(db, p1)
    const adversarialIndex = new ScopedVectorize(
      staticFakeIndex([{ id: "t2-ent", score: 0.99 }]),
      p1,
    )

    const result = await upsertEntityWithVectorDedup(
      graph1,
      adversarialIndex,
      makeEmbed([0.1, 0.2]),
      baseInput({ name: "Shared Concept" }),
    )

    // D1 re-check: recheckEntities filters by tenant_id = 't1', so 't2-ent' is dropped.
    // A new entity must be created for t1.
    expect(result.id).not.toBe("t2-ent")
    // Only t1's new entity exists in t1; t2's entity was already there.
    expect(
      (
        sqlite.query("SELECT count(*) AS n FROM entities WHERE tenant_id = 't1'").get() as {
          n: number
        }
      ).n,
    ).toBe(1)
    // Critically: t2's entity is NOT modified.
    const t2row = getEntity(sqlite, "t2-ent")
    expect(t2row?.canonical_name).toBe("Shared Concept")
    expect(JSON.parse(t2row?.aliases ?? "[]") as string[]).toHaveLength(0)
  })

  // ── 4. Idempotency: re-running extraction creates no new dupes ────────────────

  test("re-running extraction is idempotent — deterministic key hit on second run, no new row", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)
    const entity = baseInput({ name: "Project X", kind: "project", chunkIds: ["c1"] })

    // First run: creates entity.
    const r1 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([]), p),
      makeEmbed([0.3, 0.4]),
      entity,
    )
    expect(countEntities(sqlite)).toBe(1)

    // Second run (same input): deterministic key hits, no vector query needed.
    // Use a high-score fake to prove vector-dedup is NOT invoked (key wins).
    const r2 = await upsertEntityWithVectorDedup(
      graph,
      // Would cause a vector-dedup merge if Phase 1 didn't short-circuit.
      new ScopedVectorize(staticFakeIndex([{ id: "some-other-id", score: 0.99 }]), p),
      makeEmbed([0.3, 0.4]),
      entity,
    )

    expect(r2.id).toBe(r1.id) // same row, deterministic hit
    expect(countEntities(sqlite)).toBe(1) // no new row
  })

  // ── 5. Within-batch ordering: two equal entities in same run → one row ────────

  test("within-batch ordering: second entity matches first's immediately-upserted vector and collapses to one row", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)

    // Stateful index: starts empty, accumulates upserts, returns them on next query at 0.9.
    const index = statefulFakeIndex(0.9)
    const sv = new ScopedVectorize(index, p)

    // Entity 1: "Acme Corporation" — no prior vector, creates new row, upserts vector.
    const r1 = await upsertEntityWithVectorDedup(
      graph,
      sv,
      makeEmbed([0.5, 0.5]),
      baseInput({ name: "Acme Corporation", kind: "org", chunkIds: ["c1"] }),
    )
    expect(r1.embedded).toBe(true)
    expect(countEntities(sqlite)).toBe(1)

    // Entity 2: "Acme Corp" — stateful index now has r1's vector → score 0.9 ≥ 0.85.
    const r2 = await upsertEntityWithVectorDedup(
      graph,
      sv,
      makeEmbed([0.51, 0.49]),
      baseInput({ name: "Acme Corp", kind: "org", chunkIds: ["c2"] }),
    )

    expect(r2.id).toBe(r1.id) // collapsed into same entity
    expect(countEntities(sqlite)).toBe(1) // single row

    const row = getEntity(sqlite, r1.id)
    // Both "Acme Corp" surface name should be in aliases.
    const aliases = JSON.parse(row?.aliases ?? "[]") as string[]
    expect(aliases).toContain("Acme Corp")
    // mention_count from both batches.
    expect(row?.mention_count).toBe(2)
  })

  // ── 6. Kind mismatch: same score but different kind → NOT merged ───────────────

  test("above-threshold score but different kind → entities stay separate", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)

    const r1 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([]), p),
      makeEmbed([0.1, 0.2]),
      baseInput({ name: "Quantum Labs", kind: "org", chunkIds: ["c1"] }),
    )

    // Same score ≥ 0.85 but querying entity is of kind "project", not "org".
    const r2 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([{ id: r1.id, score: 0.95 }]), p),
      makeEmbed([0.11, 0.21]),
      baseInput({ name: "Quantum Project", kind: "project", chunkIds: ["c2"] }),
    )

    expect(r2.id).not.toBe(r1.id)
    expect(countEntities(sqlite)).toBe(2)
  })

  // ── 7. Scope mismatch: same score + same kind but different scope → NOT merged ──

  test("above-threshold score but different scope partition → entities stay separate", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)

    const r1 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([]), p),
      makeEmbed([0.1, 0.2]),
      baseInput({ name: "Client Widget", kind: "concept", scope: "clientA", chunkIds: ["c1"] }),
    )

    // Score ≥ 0.85 but the new entity is in "clientB" scope — cross-scope merge must not happen.
    const r2 = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([{ id: r1.id, score: 0.95 }]), p),
      makeEmbed([0.11, 0.21]),
      baseInput({ name: "Client Widget", kind: "concept", scope: "clientB", chunkIds: ["c2"] }),
    )

    // Different scope partition → different deterministic key → different rows.
    expect(r2.id).not.toBe(r1.id)
    expect(countEntities(sqlite)).toBe(2)
  })

  // ── 8. Embed unavailable: graceful degrade → new entity created without vector ──

  test("when embed returns null the function gracefully creates a new entity (degrade path)", async () => {
    const p = principal({ tenantId: "t1" })
    const graph = new ScopedGraph(db, p)

    const result = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(staticFakeIndex([]), p),
      makeEmbed(null), // embed unavailable
      baseInput({ name: "No Vector Entity" }),
    )

    expect(result.embedded).toBe(false)
    expect(countEntities(sqlite)).toBe(1) // row still created
  })
})

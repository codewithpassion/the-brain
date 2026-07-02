import { env } from "cloudflare:test"
import {
  type BrainBindings,
  type DreamDedupServices,
  DreamRunStore,
  runDreamDedup,
  ScopedDB,
  ScopedGraph,
  ScopedVectorize,
  upsertEntityWithVectorDedup,
} from "@brain/db"
import { EMBEDDING_MODEL, ENTITY_GRAPH, EXTRACT_MODEL, type Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"

/**
 * THE Dream-dedup canary (v2 W1/D4) — runs `runDreamDedup` against REAL local D1 inside workerd
 * with a stubbed entity Vectorize index (canned neighbor matches + stored-vector getByIds + recorded
 * deletes) + a stubbed `gen` (canned same-entity verdicts), so it is offline-deterministic. Covers
 * the original behaviors AND the review fix round:
 *   (a) near-dup merge — mentions re-pointed, loser soft-deleted, neighbor relation re-points, a
 *       traverse from the neighbor reaches the WINNER (loser hidden);
 *   (b) NON-VACUOUS cross-tenant pair NEVER merged (D1 re-check drops the leaked id);
 *   (c) same-name/kind, different scope → surfaced by re-check yet never merged;
 *   (d) budget stop → paused with stopReason='budget' + resumable; resume completes;
 *   (e) same-day re-run no-ops;
 *   (f) gen-degrade (null verdict) → skipped;
 *   (g) collision path (shared mention + colliding relation + self-loop) merges cleanly AND writes a
 *       REVERSIBLE audit diff (deleted colliders + re-pointed ids + prior winner counters);
 *   (h) same-run merge CHAIN folds all duplicates into the smallest-id winner with fresh recount;
 *   (i) re-extraction of a MERGED surface form redirects to the live winner (no resurrection, no
 *       duplicate) — findEntityByKey + upsertEntityWithVectorDedup;
 *   (j) sweep-start vector reconciliation issues deleteByIds for stranded losers;
 *   (k) spend is split by model (embed→EMBEDDING_MODEL, gen→EXTRACT_MODEL) and stats carry neurons;
 *   (l) a current stored vector is REUSED (getByIds), not re-embedded;
 *   (m) cursor paging past a small pageSize completes the tail; a maxItemsPerInvocation cap pauses
 *       with stopReason='page' and the workflow-style re-invoke loop converges to success;
 *   (n) pickWinner uses the FRESH self after an earlier same-run merge (item 4) — the survivor's
 *       identity flips vs a stale self, isolating the exact line item 4 changed.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const STAMP = "2026-06-25T00:00:00.000Z"

const systemAdmin = (tenantId: string): Principal => ({
  tenantId,
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

const seedEntity = async (opts: {
  id: string
  tenantId: string
  name: string
  kind?: string
  scope?: string | null
  mentionCount?: number
  createdAt?: string
  /** Set to mark the row already merged INTO this winner id (a Dream-dedup loser tombstone). */
  mergedInto?: string | null
  /** Vector-staleness inputs: set to a stamp ≥ updatedAt to make the stored vector "current". */
  embeddedAt?: string | null
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
                           mention_count, scope, visibility, merged_into, embedded_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', ?, ?, 'world', ?, ?, ?, ?)`,
  )
    .bind(
      opts.id,
      opts.tenantId,
      opts.kind ?? "concept",
      opts.name,
      `${opts.name} description`,
      opts.mentionCount ?? 0,
      opts.scope ?? null,
      opts.mergedInto ?? null,
      opts.embeddedAt ?? null,
      opts.createdAt ?? STAMP,
      opts.createdAt ?? STAMP,
    )
    .run()
}

const seedMention = async (opts: {
  id: string
  tenantId: string
  entityId: string
  sourceId: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entity_mentions (id, tenant_id, entity_id, source_kind, source_id, created_at)
     VALUES (?, ?, ?, 'chunk', ?, ?)`,
  )
    .bind(opts.id, opts.tenantId, opts.entityId, opts.sourceId, STAMP)
    .run()
}

const seedRelation = async (opts: {
  id: string
  tenantId: string
  fromId: string
  toId: string
  kind?: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entity_relations (id, tenant_id, from_entity_id, to_entity_id, kind, confidence,
                                   evidence_chunk_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0.9, '[]', ?, ?)`,
  )
    .bind(opts.id, opts.tenantId, opts.fromId, opts.toId, opts.kind ?? "relates", STAMP, STAMP)
    .run()
}

const count = async (sql: string, binds: unknown[]): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

/** Deterministic embed: any text → a fixed unit vector (the fake index ignores it anyway). */
const embedStub = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array(1024).fill(0))

/**
 * A configurable fake entity Vectorize index. `matches` is what every `query` returns; `vectors`
 * backs `getByIds` (stored-vector reuse); `deleted` records every `deleteByIds` id (reconciliation
 * + per-merge cleanup assertions).
 */
const fakeEntityIndex = (opts: {
  matches?: { id: string; score: number }[]
  vectors?: Record<string, number[]>
  deleted?: string[]
}): Vectorize =>
  ({
    query: async () => ({ count: (opts.matches ?? []).length, matches: opts.matches ?? [] }),
    getByIds: async (ids: string[]) =>
      ids.filter((id) => opts.vectors?.[id]).map((id) => ({ id, values: opts.vectors?.[id] })),
    deleteByIds: async (ids: string[]) => {
      if (opts.deleted) opts.deleted.push(...ids)
      return { mutationId: "m" }
    },
  }) as unknown as Vectorize

/**
 * A STATEFUL fake index whose `query` returns the next entry of a queue per call — lets a test force
 * exactly who-merges-whom across a chain (item 4 fresh-self isolation). `getByIds` returns nothing
 * (always embed); `deleteByIds` is recorded.
 */
const queuedEntityIndex = (
  queue: { id: string; score: number }[][],
  deleted?: string[],
): Vectorize => {
  let call = 0
  return {
    query: async () => {
      const m = queue[call++] ?? []
      return { count: m.length, matches: m }
    },
    getByIds: async () => [],
    deleteByIds: async (ids: string[]) => {
      if (deleted) deleted.push(...ids)
      return { mutationId: "m" }
    },
  } as unknown as Vectorize
}

/**
 * `gen` stub: two entities are "the same" iff BOTH `name="..."` fields render the Workers concept.
 * `mode:'null'` degrades every verdict (the gen-degrade path).
 */
const genStub =
  (mode: "workers" | "null" = "workers") =>
  async (prompt: string): Promise<string | null> => {
    if (mode === "null") return null
    const names = [...prompt.matchAll(/name="([^"]*)"/g)].map((m) => m[1] ?? "")
    const same = names.length === 2 && names.every((n) => n.includes("Workers"))
    return JSON.stringify({ same, confidence: same ? 0.95 : 0.1, rationale: "stub" })
  }

const dedupServices = (
  tenantId: string,
  index: Vectorize,
  gen: (prompt: string) => Promise<string | null>,
): DreamDedupServices => {
  const p = systemAdmin(tenantId)
  const rawDb = raw()
  return {
    db: new ScopedDB(rawDb, p),
    graph: new ScopedGraph(rawDb, p),
    entityVectors: new ScopedVectorize(index, p),
    ai: { embed: embedStub, gen },
    runs: new DreamRunStore(rawDb, p),
    principal: p,
  }
}

beforeAll(async () => {
  // (a) happy path — A (winner, 2 mentions) + B (loser, 1) + neighbor N→B.
  await seedEntity({ id: "xa-a", tenantId: "xa", name: "Cloudflare Workers", mentionCount: 2 })
  await seedEntity({ id: "xa-b", tenantId: "xa", name: "CF Workers", mentionCount: 1 })
  await seedEntity({ id: "xa-n", tenantId: "xa", name: "Radium" })
  await seedMention({ id: "xa-m1", tenantId: "xa", entityId: "xa-a", sourceId: "c1" })
  await seedMention({ id: "xa-m2", tenantId: "xa", entityId: "xa-a", sourceId: "c2" })
  await seedMention({ id: "xa-m3", tenantId: "xa", entityId: "xa-b", sourceId: "c3" })
  await seedRelation({ id: "xa-r1", tenantId: "xa", fromId: "xa-n", toId: "xa-b" })

  // (b) adversarial cross-tenant.
  await seedEntity({ id: "xb-a", tenantId: "xbx", name: "Cloudflare Workers", mentionCount: 5 })
  await seedEntity({ id: "xb-b", tenantId: "xby", name: "Cloudflare Workers", mentionCount: 1 })

  // (c) same tenant, DIFFERENT scope.
  await seedEntity({
    id: "xc-a",
    tenantId: "xc",
    name: "Cloudflare Workers",
    scope: "alpha",
    mentionCount: 2,
  })
  await seedEntity({
    id: "xc-b",
    tenantId: "xc",
    name: "Cloudflare Workers",
    scope: "beta",
    mentionCount: 1,
  })

  // (d) budget/resume — three distinct entities.
  await seedEntity({ id: "xd-1", tenantId: "xd", name: "Radium" })
  await seedEntity({ id: "xd-2", tenantId: "xd", name: "Polonium" })
  await seedEntity({ id: "xd-3", tenantId: "xd", name: "Uranium" })

  // (e) same-day no-op.
  await seedEntity({ id: "xe-a", tenantId: "xe", name: "Cloudflare Workers", mentionCount: 2 })
  await seedEntity({ id: "xe-b", tenantId: "xe", name: "CF Workers", mentionCount: 1 })

  // (f) gen-degrade.
  await seedEntity({ id: "xf-a", tenantId: "xf", name: "Cloudflare Workers", mentionCount: 2 })
  await seedEntity({ id: "xf-b", tenantId: "xf", name: "CF Workers", mentionCount: 1 })

  // (g) collision path.
  await seedEntity({ id: "xg-a", tenantId: "xg", name: "Cloudflare Workers", mentionCount: 2 })
  await seedEntity({ id: "xg-b", tenantId: "xg", name: "CF Workers", mentionCount: 1 })
  await seedEntity({ id: "xg-n", tenantId: "xg", name: "Radium" })
  await seedMention({ id: "xg-m1", tenantId: "xg", entityId: "xg-a", sourceId: "own" })
  await seedMention({ id: "xg-m2", tenantId: "xg", entityId: "xg-a", sourceId: "shared" })
  await seedMention({ id: "xg-m3", tenantId: "xg", entityId: "xg-b", sourceId: "shared" })
  await seedMention({ id: "xg-m4", tenantId: "xg", entityId: "xg-b", sourceId: "loser" })
  await seedRelation({ id: "xg-r1", tenantId: "xg", fromId: "xg-a", toId: "xg-n", kind: "relates" })
  await seedRelation({ id: "xg-r2", tenantId: "xg", fromId: "xg-b", toId: "xg-n", kind: "relates" })
  await seedRelation({ id: "xg-r3", tenantId: "xg", fromId: "xg-b", toId: "xg-a", kind: "relates" })

  // (h) merge chain — three "Workers" duplicates; all fold into the smallest-id winner xh-a.
  await seedEntity({ id: "xh-a", tenantId: "xh", name: "Cloudflare Workers", mentionCount: 1 })
  await seedEntity({ id: "xh-b", tenantId: "xh", name: "CF Workers", mentionCount: 1 })
  await seedEntity({ id: "xh-c", tenantId: "xh", name: "Workers (CF)", mentionCount: 1 })
  await seedMention({ id: "xh-m1", tenantId: "xh", entityId: "xh-a", sourceId: "s1" })
  await seedMention({ id: "xh-m2", tenantId: "xh", entityId: "xh-b", sourceId: "s2" })
  await seedMention({ id: "xh-m3", tenantId: "xh", entityId: "xh-c", sourceId: "s3" })

  // (i) re-extraction resurrection — loser xi-l already merged INTO winner xi-w; loser holds the key.
  await seedEntity({ id: "xi-w", tenantId: "xi", name: "Cloudflare Workers", mentionCount: 3 })
  await seedEntity({
    id: "xi-l",
    tenantId: "xi",
    name: "CF Workers",
    mentionCount: 1,
    mergedInto: "xi-w",
  })

  // (j) reconciliation — a stranded loser whose vector must be re-deleted at sweep start.
  await seedEntity({ id: "xj-w", tenantId: "xj", name: "Alpha", mentionCount: 2 })
  await seedEntity({
    id: "xj-l",
    tenantId: "xj",
    name: "Alpha alias",
    mentionCount: 1,
    mergedInto: "xj-w",
  })

  // (k) spend-by-model — a stale pair that embeds + gen-confirms + merges.
  await seedEntity({ id: "xk-a", tenantId: "xk", name: "Cloudflare Workers", mentionCount: 2 })
  await seedEntity({ id: "xk-b", tenantId: "xk", name: "CF Workers", mentionCount: 1 })

  // (l) stored-vector reuse — both entities have a CURRENT vector (embedded_at ≥ updated_at).
  await seedEntity({
    id: "xl-a",
    tenantId: "xl",
    name: "Cloudflare Workers",
    mentionCount: 2,
    embeddedAt: STAMP,
  })
  await seedEntity({
    id: "xl-b",
    tenantId: "xl",
    name: "CF Workers",
    mentionCount: 1,
    embeddedAt: STAMP,
  })

  // (m) paging — five distinct (non-merging) entities.
  for (let i = 1; i <= 5; i++) {
    await seedEntity({ id: `xm-${i}`, tenantId: "xm", name: `Distinct ${i}` })
  }

  // (n) fresh-self isolation (item 4): P(1)→merges into Q(2); Q's FRESH count (3) then ties R(3) and
  // wins on smaller id. With a STALE self (Q's page snapshot = 2) the loser R(3) would win instead —
  // so the survivor's identity flips on exactly the line item 4 changed.
  await seedEntity({ id: "xn-a", tenantId: "xn", name: "Cloudflare Workers", mentionCount: 1 })
  await seedEntity({ id: "xn-c", tenantId: "xn", name: "CF Workers", mentionCount: 2 })
  await seedEntity({ id: "xn-e", tenantId: "xn", name: "Workers Runtime", mentionCount: 3 })
  await seedMention({ id: "xn-p1", tenantId: "xn", entityId: "xn-a", sourceId: "pn1" })
  await seedMention({ id: "xn-q1", tenantId: "xn", entityId: "xn-c", sourceId: "qn1" })
  await seedMention({ id: "xn-q2", tenantId: "xn", entityId: "xn-c", sourceId: "qn2" })
  await seedMention({ id: "xn-r1", tenantId: "xn", entityId: "xn-e", sourceId: "rn1" })
  await seedMention({ id: "xn-r2", tenantId: "xn", entityId: "xn-e", sourceId: "rn2" })
  await seedMention({ id: "xn-r3", tenantId: "xn", entityId: "xn-e", sourceId: "rn3" })
})

describe("dream dedup canary (D4 + fix round) — real local D1 in workerd", () => {
  test("(a) merges a near-dup pair: mentions re-pointed, loser soft-deleted, traverse reaches winner", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xa-a", score: 0.98 },
        { id: "xa-b", score: 0.97 },
        { id: "xa-n", score: 0.9 },
      ],
    })
    const result = await runDreamDedup(dedupServices("xa", index, genStub("workers")), {
      runId: "dedup-xa-1",
    })
    expect(result.status).toBe("success")
    expect(result.stats.merged).toBe(1)
    expect(result.stats.pairsExamined).toBeGreaterThanOrEqual(1)

    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xa' AND id='xa-b' AND merged_into='xa-a'",
        [],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_mentions WHERE tenant_id='xa' AND entity_id='xa-a'",
        [],
      ),
    ).toBe(3)
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_mentions WHERE tenant_id='xa' AND entity_id='xa-b'",
        [],
      ),
    ).toBe(0)
    expect(
      await count("SELECT mention_count AS n FROM entities WHERE tenant_id='xa' AND id='xa-a'", []),
    ).toBe(3)
    // Loser's canonical_name folded into the winner's aliases (FTS/name search stays alive).
    const aliasRow = await env_.DB.prepare(
      "SELECT aliases FROM entities WHERE tenant_id='xa' AND id='xa-a'",
    ).first<{ aliases: string }>()
    expect(aliasRow?.aliases).toContain("CF Workers")

    const graph = new ScopedGraph(raw(), systemAdmin("xa"))
    const reached = new Set(
      (await graph.traverse(ENTITY_GRAPH, "xa-n", { depth: 3, direction: "both" })).flatMap((p) => [
        p.from_id,
        p.to_id,
      ]),
    )
    expect(reached.has("xa-a")).toBe(true)
    expect(reached.has("xa-b")).toBe(false)
  })

  test("(b) NON-VACUOUS: the stub leaks a cross-tenant id, the D1 re-check drops it — never merged", async () => {
    const p = systemAdmin("xbx")
    const index = fakeEntityIndex({
      matches: [
        { id: "xb-a", score: 0.98 },
        { id: "xb-b", score: 0.99 },
      ],
    })
    const scoped = new ScopedVectorize(index, p)
    const matches = await scoped.query({ values: new Array(1024).fill(0), topK: 10 })
    expect(matches.map((m) => m.id).sort()).toEqual(["xb-a", "xb-b"])

    const result = await runDreamDedup(dedupServices("xbx", index, genStub("workers")), {
      runId: "dedup-xbx-1",
    })
    expect(result.stats.merged).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE id='xb-a' AND merged_into IS NOT NULL",
        [],
      ),
    ).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE id='xb-b' AND merged_into IS NOT NULL",
        [],
      ),
    ).toBe(0)
  })

  test("(c) same-name/kind in DIFFERENT scopes is surfaced by the re-check yet never merged", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xc-a", score: 0.98 },
        { id: "xc-b", score: 0.99 },
      ],
    })
    const graph = new ScopedGraph(raw(), systemAdmin("xc"))
    const rechecked = await graph.recheckEntities(["xc-a", "xc-b"])
    expect(rechecked.map((e) => e.id).sort()).toEqual(["xc-a", "xc-b"])

    const result = await runDreamDedup(dedupServices("xc", index, genStub("workers")), {
      runId: "dedup-xc-1",
    })
    expect(result.stats.merged).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xc' AND merged_into IS NOT NULL",
        [],
      ),
    ).toBe(0)
  })

  test("(d) a budget stop yields status 'paused'/stopReason='budget' + resumable; a resume completes", async () => {
    const index = fakeEntityIndex({})
    const stop = await runDreamDedup(dedupServices("xd", index, genStub("workers")), {
      runId: "dedup-xd-resume",
      maxNeurons: 0.001,
      pageSize: 10,
    })
    expect(stop.status).toBe("paused")
    expect(stop.stopReason).toBe("budget")
    expect(stop.entitiesRemaining).toBeGreaterThan(0)

    const resume = await runDreamDedup(dedupServices("xd", index, genStub("workers")), {
      runId: "dedup-xd-resume",
    })
    expect(resume.resumed).toBe(true)
    expect(resume.status).toBe("success")
    expect(resume.entitiesRemaining).toBe(0)
    expect(
      (await new DreamRunStore(raw(), systemAdmin("xd")).get("dedup-xd-resume"))?.cursor,
    ).toBeNull()
  })

  test("(e) same-day re-run no-ops (success, no extra merges)", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xe-a", score: 0.98 },
        { id: "xe-b", score: 0.97 },
      ],
    })
    const first = await runDreamDedup(dedupServices("xe", index, genStub("workers")), {
      runId: "dedup-xe-1",
    })
    expect(first.noop).toBe(false)
    expect(first.stats.merged).toBe(1)

    const second = await runDreamDedup(dedupServices("xe", index, genStub("workers")), {
      runId: "dedup-xe-1",
    })
    expect(second.noop).toBe(true)
    expect(second.status).toBe("success")
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xe' AND merged_into IS NOT NULL",
        [],
      ),
    ).toBe(1)
  })

  test("(f) gen-degrade (null verdict) → the pair is skipped, never merged", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xf-a", score: 0.98 },
        { id: "xf-b", score: 0.97 },
      ],
    })
    const result = await runDreamDedup(dedupServices("xf", index, genStub("null")), {
      runId: "dedup-xf-1",
    })
    expect(result.stats.merged).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xf' AND merged_into IS NOT NULL",
        [],
      ),
    ).toBe(0)
  })

  test("(g) collision path merges cleanly AND writes a reversible audit diff", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xg-a", score: 0.98 },
        { id: "xg-b", score: 0.97 },
        { id: "xg-n", score: 0.9 },
      ],
    })
    const result = await runDreamDedup(dedupServices("xg", index, genStub("workers")), {
      runId: "dedup-xg-1",
    })
    expect(result.status).toBe("success")
    expect(result.stats.merged).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xg' AND id='xg-b' AND merged_into='xg-a'",
        [],
      ),
    ).toBe(1)
    // Winner owns 3 distinct mentions (own + shared + loser); shared counted ONCE.
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_mentions WHERE tenant_id='xg' AND entity_id='xg-a'",
        [],
      ),
    ).toBe(3)
    expect(
      await count("SELECT mention_count AS n FROM entities WHERE tenant_id='xg' AND id='xg-a'", []),
    ).toBe(3)
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_relations WHERE tenant_id='xg' AND from_entity_id='xg-a' AND to_entity_id='xg-n' AND kind='relates'",
        [],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_relations WHERE tenant_id='xg' AND from_entity_id='xg-a' AND to_entity_id='xg-a'",
        [],
      ),
    ).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_relations WHERE tenant_id='xg' AND (from_entity_id='xg-b' OR to_entity_id='xg-b')",
        [],
      ),
    ).toBe(0)

    // The audit diff is rich enough to reverse the merge (D-i5).
    const auditRow = await env_.DB.prepare(
      "SELECT diff FROM memory_audit WHERE tenant_id='xg' AND action='dream.dedup.merge'",
    ).first<{ diff: string }>()
    expect(auditRow).not.toBeNull()
    const diff = JSON.parse(auditRow?.diff ?? "{}")
    expect(diff.winnerId).toBe("xg-a")
    expect(diff.loserId).toBe("xg-b")
    expect(
      Array.isArray(diff.deletedRelations) && diff.deletedRelations.length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      Array.isArray(diff.deletedMentions) && diff.deletedMentions.length,
    ).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(diff.repointedRelationIds)).toBe(true)
    expect(Array.isArray(diff.repointedMentionIds)).toBe(true)
    expect(typeof diff.priorWinnerMentionCount).toBe("number")
    expect(Array.isArray(diff.priorWinnerAliases)).toBe(true)
  })

  test("(h) a same-run merge chain folds all duplicates into the smallest-id winner (fresh recount)", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xh-a", score: 0.98 },
        { id: "xh-b", score: 0.97 },
        { id: "xh-c", score: 0.96 },
      ],
    })
    const result = await runDreamDedup(dedupServices("xh", index, genStub("workers")), {
      runId: "dedup-xh-1",
    })
    expect(result.status).toBe("success")
    expect(result.stats.merged).toBe(2)
    // xh-a (smallest id) is the sole survivor; b and c fold into it.
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xh' AND merged_into IS NULL",
        [],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xh' AND id='xh-a' AND merged_into IS NULL",
        [],
      ),
    ).toBe(1)
    // All three mentions folded onto the winner — only possible if each merge recounted on FRESH state.
    expect(
      await count("SELECT mention_count AS n FROM entities WHERE tenant_id='xh' AND id='xh-a'", []),
    ).toBe(3)
  })

  test("(i) re-extraction of a MERGED surface form redirects to the winner (no resurrection/duplicate)", async () => {
    const graph = new ScopedGraph(raw(), systemAdmin("xi"))
    // findEntityByKey on the loser's still-held UNIQUE key redirects to the live winner.
    const keyed = await graph.findEntityByKey("CF Workers", "concept", null)
    expect(keyed?.id).toBe("xi-w")

    // A full re-extraction of that surface form lands on the winner — no third row created.
    const index = fakeEntityIndex({})
    const res = await upsertEntityWithVectorDedup(
      graph,
      new ScopedVectorize(index, systemAdmin("xi")),
      embedStub,
      {
        name: "CF Workers",
        kind: "concept",
        aliases: [],
        description: "re-extracted",
        chunkIds: ["reext-1"],
        scope: null,
        visibility: "world",
        teamId: null,
      },
    )
    expect(res.id).toBe("xi-w")
    expect(await count("SELECT count(*) AS n FROM entities WHERE tenant_id='xi'", [])).toBe(2)
  })

  test("(j) sweep-start reconciliation issues deleteByIds for a stranded loser vector", async () => {
    const deleted: string[] = []
    const index = fakeEntityIndex({ deleted })
    await runDreamDedup(dedupServices("xj", index, genStub("workers")), { runId: "dedup-xj-1" })
    // The pre-existing merged loser xj-l had its (possibly stale) vector re-deleted at sweep start.
    expect(deleted).toContain("xj-l")
  })

  test("(k) spend is split by model (embed vs gen) and run stats carry neurons", async () => {
    const index = fakeEntityIndex({
      matches: [
        { id: "xk-a", score: 0.98 },
        { id: "xk-b", score: 0.97 },
      ],
    })
    const result = await runDreamDedup(dedupServices("xk", index, genStub("workers")), {
      runId: "dedup-xk-1",
    })
    expect(result.stats.merged).toBe(1)
    expect(result.stats.neurons).toBeGreaterThan(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM token_spend WHERE tenant_id='xk' AND surface='dream' AND model=?",
        [EMBEDDING_MODEL],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM token_spend WHERE tenant_id='xk' AND surface='dream' AND model=?",
        [EXTRACT_MODEL],
      ),
    ).toBe(1)
  })

  test("(l) a current stored vector is REUSED (getByIds), never re-embedded", async () => {
    // Both entities are non-stale (embedded_at ≥ updated_at) with stored vectors → no embed spend.
    const index = fakeEntityIndex({
      matches: [
        { id: "xl-a", score: 0.98 },
        { id: "xl-b", score: 0.97 },
      ],
      vectors: { "xl-a": new Array(1024).fill(0), "xl-b": new Array(1024).fill(0) },
    })
    const result = await runDreamDedup(dedupServices("xl", index, genStub("workers")), {
      runId: "dedup-xl-1",
    })
    expect(result.stats.merged).toBe(1)
    // Reuse ⇒ recordEmbed never ran ⇒ no EMBEDDING_MODEL spend row (gen row still present).
    expect(
      await count("SELECT count(*) AS n FROM token_spend WHERE tenant_id='xl' AND model=?", [
        EMBEDDING_MODEL,
      ]),
    ).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM token_spend WHERE tenant_id='xl' AND surface='dream' AND model=?",
        [EXTRACT_MODEL],
      ),
    ).toBe(1)
  })

  test("(m) cursor paging completes the tail; a per-invocation cap pauses 'page' and the loop converges", async () => {
    const index = fakeEntityIndex({}) // no candidates → every entity is a cheap skip

    // pageSize smaller than the set → the driver loops pages until a short one; completes cleanly.
    const paged = await runDreamDedup(dedupServices("xm", index, genStub("workers")), {
      runId: "dedup-xm-paged",
      pageSize: 2,
    })
    expect(paged.status).toBe("success")
    expect(paged.stats.entitiesExamined).toBe(5)

    // maxItemsPerInvocation cap → paused with stopReason='page'; a workflow-style loop converges.
    let guard = 0
    let last = await runDreamDedup(dedupServices("xm", index, genStub("workers")), {
      runId: "dedup-xm-chunked",
      pageSize: 2,
      maxItemsPerInvocation: 2,
    })
    expect(last.stopReason).toBe("page")
    while (last.stopReason === "page" && guard++ < 20) {
      last = await runDreamDedup(dedupServices("xm", index, genStub("workers")), {
        runId: "dedup-xm-chunked",
        pageSize: 2,
        maxItemsPerInvocation: 2,
      })
    }
    expect(last.status).toBe("success")
    expect(last.stats.entitiesExamined).toBe(5)
  })

  test("(n) pickWinner uses the FRESH self after an earlier same-run merge (item 4 isolation)", async () => {
    // Queue forces: P's query → Q, Q's query → R (R is skipped as a loser, never queries).
    const index = queuedEntityIndex([
      [{ id: "xn-c", score: 0.97 }], // P (xn-a) → candidate Q
      [{ id: "xn-e", score: 0.97 }], // Q (xn-c) → candidate R
    ])
    const result = await runDreamDedup(dedupServices("xn", index, genStub("workers")), {
      runId: "dedup-xn-1",
    })
    expect(result.status).toBe("success")
    expect(result.stats.merged).toBe(2)
    // Survivor is Q (xn-c), NOT R (xn-e): only true if Q's FRESH post-merge count (3) beat R at the
    // tie-break. A stale self (2) would have let R win. Exactly one live entity, holding all 6 mentions.
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xn' AND merged_into IS NULL",
        [],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='xn' AND id='xn-c' AND merged_into IS NULL",
        [],
      ),
    ).toBe(1)
    expect(
      await count("SELECT mention_count AS n FROM entities WHERE tenant_id='xn' AND id='xn-c'", []),
    ).toBe(6)
  })
})

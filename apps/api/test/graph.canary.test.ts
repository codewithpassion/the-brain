import { env } from "cloudflare:test"
import {
  type BrainBindings,
  ScopedGraph,
  type ScopedServices,
  ScopedVectorize,
  searchEntities,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { DOC_GRAPH } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { runEntityExtraction } from "../src/entity-extraction"

/**
 * THE Phase-4 graph-isolation canary — converts the Phase-1 `[P4]` "BFS cross-tenant graph hop"
 * `test.todo` into a real green canary. Runs against REAL local D1 inside workerd (the same
 * harness as the Phase-1 isolation suite), exercising the generalized BFS + entity search.
 *
 * NON-VACUOUS throughout: the adversarial cross-tenant edge/entity is seeded AND shown to exist
 * (raw count) BEFORE proving tenant A's traverse / searchEntities never surfaces tenant B's
 * node. The BFS leak path is genuine — a `doc_links` row in tenant B whose `from_id` is one of
 * tenant A's page ids — so the only thing stopping the hop is the `tenant_id` predicate on the
 * edge AND the node gate on both JOINed endpoints (drop-don't-error: an empty walk, never a 403).
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "gA",
  userId: "uA",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read"],
  readOnly: false,
  ...overrides,
})

const seedPage = async (opts: { id: string; tenantId: string; slug: string }): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO pages (id, tenant_id, slug, type, title, visibility, compiled_truth, frontmatter,
                        created_at, updated_at)
     VALUES (?, ?, ?, 'note', ?, 'world', '', '{}', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')`,
  )
    .bind(opts.id, opts.tenantId, opts.slug, opts.id)
    .run()
}

const seedDocLink = async (opts: {
  id: string
  tenantId: string
  fromId: string
  toId: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO doc_links (id, tenant_id, from_id, to_id, link_type, link_source, context, created_at)
     VALUES (?, ?, ?, ?, 'relates', 'manual', '', '2026-06-25T00:00:00.000Z')`,
  )
    .bind(opts.id, opts.tenantId, opts.fromId, opts.toId)
    .run()
}

const seedEntity = async (opts: { id: string; tenantId: string; name: string }): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
                           mention_count, visibility, created_at, updated_at)
     VALUES (?, ?, 'person', ?, '[]', ?, '[]', 0, 'world', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')`,
  )
    .bind(opts.id, opts.tenantId, opts.name, `${opts.name} bio`)
    .run()
}

const countRows = async (sql: string, binds: unknown[]): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

beforeAll(async () => {
  // Tenant A doc-graph chain: gA-1 → gA-2 → gA-3.
  await seedPage({ id: "gA-1", tenantId: "gA", slug: "shared-slug" })
  await seedPage({ id: "gA-2", tenantId: "gA", slug: "a-two" })
  await seedPage({ id: "gA-3", tenantId: "gA", slug: "a-three" })
  await seedDocLink({ id: "gA-e12", tenantId: "gA", fromId: "gA-1", toId: "gA-2" })
  await seedDocLink({ id: "gA-e23", tenantId: "gA", fromId: "gA-2", toId: "gA-3" })

  // Tenant B doc-graph chain with a COLLIDING slug: gB-1 → gB-2.
  await seedPage({ id: "gB-1", tenantId: "gB", slug: "shared-slug" })
  await seedPage({ id: "gB-2", tenantId: "gB", slug: "b-two" })
  await seedDocLink({ id: "gB-e12", tenantId: "gB", fromId: "gB-1", toId: "gB-2" })

  // THE ADVERSARIAL EDGE: a tenant-B edge whose from_id is a tenant-A page id. If the BFS ever
  // dropped the edge `tenant_id` predicate, tenant A's frontier (which holds gA-1/gA-2/gA-3)
  // would hop straight into tenant B's gB-2 through this row.
  await seedDocLink({ id: "gB-cross", tenantId: "gB", fromId: "gA-2", toId: "gB-2" })

  // Colliding-name entities across tenants for the searchEntities canary.
  await seedEntity({ id: "ent-A", tenantId: "gA", name: "Marie Curie" })
  await seedEntity({ id: "ent-B", tenantId: "gB", name: "Marie Curie" })
})

/** A fake entity Vectorize index that ALWAYS surfaces both tenants' colliding entity ids. */
const adversarialEntityIndex = {
  query: async () => ({
    count: 2,
    matches: [
      { id: "ent-A", score: 0.95 },
      { id: "ent-B", score: 0.97 },
    ],
  }),
} as unknown as Vectorize

describe("graph isolation canary (invariants 3, 8, 19) — real local D1 in workerd", () => {
  test("non-vacuous: the adversarial cross-tenant edge + tenant-B node actually exist", async () => {
    expect(
      await countRows(
        "SELECT count(*) AS n FROM doc_links WHERE id = 'gB-cross' AND tenant_id = 'gB' AND from_id = 'gA-2'",
        [],
      ),
    ).toBe(1)
    expect(
      await countRows("SELECT count(*) AS n FROM pages WHERE id = 'gB-2' AND tenant_id = 'gB'", []),
    ).toBe(1)
  })

  test("BFS never crosses tenant_id at any depth (tenant A traverse stops inside tenant A)", async () => {
    const graph = new ScopedGraph(raw(), principal({ tenantId: "gA" }))
    const reached = new Set(
      (await graph.traverse(DOC_GRAPH, "gA-1", { depth: 5, direction: "both" })).flatMap((p) => [
        p.from_id,
        p.to_id,
      ]),
    )
    // It DID walk its own graph...
    expect(reached.has("gA-2")).toBe(true)
    expect(reached.has("gA-3")).toBe(true)
    // ...but never crossed into tenant B, despite the adversarial edge off gA-2.
    expect(reached.has("gB-1")).toBe(false)
    expect(reached.has("gB-2")).toBe(false)
  })

  test("a colliding slug resolves to the principal's OWN tenant node, not tenant B's", async () => {
    const graphA = new ScopedGraph(raw(), principal({ tenantId: "gA" }))
    const graphB = new ScopedGraph(raw(), principal({ tenantId: "gB", userId: "uB" }))
    expect(await graphA.resolveNodeId(DOC_GRAPH, "shared-slug")).toBe("gA-1")
    expect(await graphB.resolveNodeId(DOC_GRAPH, "shared-slug")).toBe("gB-1")
  })

  test("searchEntities: an adversarial fake leaks tenant B's entity; the D1 re-check drops it", async () => {
    const principalA = principal({ tenantId: "gA" })
    const graph = new ScopedGraph(raw(), principalA)
    const entityVectors = new ScopedVectorize(adversarialEntityIndex, principalA)

    // Non-vacuous guard: the fake MUST surface the cross-tenant entity id.
    const matches = await entityVectors.query({ values: new Array(1024).fill(0), topK: 10 })
    expect(matches.map((m) => m.id).sort()).toEqual(["ent-A", "ent-B"])

    const hits = await searchEntities(
      { graph, entityVectors, ai: { embed: async () => [new Array(1024).fill(0)] } },
      "Marie Curie",
      { topK: 10 },
    )
    expect(hits.map((h) => h.id)).toEqual(["ent-A"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// runEntityExtraction round-trip (real D1) — proves the whole write path actually
// runs and is idempotent under re-extract. Exercises upsertEntity / relate / mention
// / clearPriorExtraction / markEntityEmbedded end to end (own tenant namespace).
// ─────────────────────────────────────────────────────────────────────────────

const seedChunk = async (opts: {
  id: string
  tenantId: string
  documentId: string
  content: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO chunks (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
                         content, embedding_model, embedding_dims, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, 'world', 0, ?, '@cf/baai/bge-m3', 1024, '2026-06-25T00:00:00.000Z')`,
  )
    .bind(opts.id, opts.tenantId, opts.documentId, opts.content)
    .run()
}

const KG_JSON = JSON.stringify({
  entities: [
    { name: "Marie Curie", kind: "person", aliases: ["Curie"], description: "physicist" },
    { name: "Radium", kind: "concept", aliases: [], description: "an element" },
  ],
  relationships: [
    { source: "Marie Curie", target: "Radium", relKind: "discovered", confidence: 0.9 },
  ],
})

/** A minimal ScopedServices sufficient for runEntityExtraction (real graph, stub AI/vectors). */
const extractionServices = (tenantId: string): ScopedServices => {
  const p = principal({ tenantId })
  const stub = {
    graph: new ScopedGraph(raw(), p),
    entityVectors: new ScopedVectorize(
      {
        upsert: async () => ({ mutationId: "m" }),
        query: async () => ({ matches: [], count: 0 }),
      } as unknown as Vectorize,
      p,
    ),
    ai: {
      genExtract: async () => KG_JSON,
      embed: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
      transcribe: async () => ({ text: "stub transcript", neurons: 0 }),
    },
  }
  return stub as unknown as ScopedServices
}

const count = async (sql: string, binds: unknown[]): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

describe("runEntityExtraction round-trip (real local D1 in workerd)", () => {
  beforeAll(async () => {
    await seedChunk({
      id: "gX-doc:0",
      tenantId: "gX",
      documentId: "gX-doc",
      content: "Marie Curie discovered Radium.",
    })
    await seedChunk({
      id: "gX-doc:1",
      tenantId: "gX",
      documentId: "gX-doc",
      content: "Radium is radioactive.",
    })
  })

  test("extracts entities/relations/mentions, embeds, and is idempotent under re-extract", async () => {
    const services = extractionServices("gX")

    const first = await runEntityExtraction(services, "gX-doc")
    expect(first.status).toBe("indexed")
    expect(first.entitiesUpserted).toBe(2)
    expect(first.relationsUpserted).toBe(1)
    expect(await count("SELECT count(*) AS n FROM entities WHERE tenant_id = 'gX'", [])).toBe(2)
    expect(
      await count("SELECT count(*) AS n FROM entity_relations WHERE tenant_id = 'gX'", []),
    ).toBe(1)
    const mentionsAfterFirst = await count(
      "SELECT count(*) AS n FROM entity_mentions WHERE tenant_id = 'gX'",
      [],
    )
    expect(mentionsAfterFirst).toBeGreaterThan(0)
    // markEntityEmbedded ran (embed stub returned vectors).
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id = 'gX' AND embedded_at IS NOT NULL",
        [],
      ),
    ).toBe(2)

    // The created entity is findable via the keyword arm (entity_fts trigger fired on write).
    const hits = await searchEntities(
      {
        graph: services.graph,
        entityVectors: services.entityVectors,
        ai: { embed: async () => null },
      },
      "Radium",
      { topK: 5 },
    )
    expect(hits.map((h) => h.name)).toContain("Radium")

    // Re-extract: deterministic key dedup + mention uniq → no duplication.
    const second = await runEntityExtraction(services, "gX-doc")
    expect(second.status).toBe("indexed")
    expect(await count("SELECT count(*) AS n FROM entities WHERE tenant_id = 'gX'", [])).toBe(2)
    expect(
      await count("SELECT count(*) AS n FROM entity_relations WHERE tenant_id = 'gX'", []),
    ).toBe(1)
    expect(
      await count("SELECT count(*) AS n FROM entity_mentions WHERE tenant_id = 'gX'", []),
    ).toBe(mentionsAfterFirst)
  })

  test("is NON-FATAL when extraction yields nothing (genExtract → null)", async () => {
    await seedChunk({ id: "gY-doc:0", tenantId: "gY", documentId: "gY-doc", content: "text" })
    const p = principal({ tenantId: "gY" })
    const services = {
      graph: new ScopedGraph(raw(), p),
      entityVectors: new ScopedVectorize(
        { upsert: async () => ({}), query: async () => ({ matches: [] }) } as unknown as Vectorize,
        p,
      ),
      ai: { genExtract: async () => null, embed: async () => null },
    } as unknown as ScopedServices
    const result = await runEntityExtraction(services, "gY-doc")
    // never throws; no entities created.
    expect(result.entitiesUpserted).toBe(0)
    expect(await count("SELECT count(*) AS n FROM entities WHERE tenant_id = 'gY'", [])).toBe(0)
  })
})

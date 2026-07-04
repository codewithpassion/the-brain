import { env } from "cloudflare:test"
import {
  type BrainBindings,
  type DreamReflectServices,
  DreamRunStore,
  EntityPageStore,
  entityPageSlug,
  mintInsightPage,
  runDreamReflection,
  ScopedDB,
  ScopedGraph,
  ScopedR2,
  ScopedVectorize,
  selectReflectionTargets,
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"

/**
 * THE v3/W2 entity-pages + idea-pages + anti-loop canary (real local D1 in workerd). Proves:
 *   - entity-page visibility INHERITS the entity's tier and is NEVER private (entities are {world,team});
 *   - the agent authors under one versioning/audit (W-i3) + the human editor-in-chief wins (don't-clobber);
 *   - live mention/relation sections (computed, not stored);
 *   - D4 merge re-points the loser's page → a redirect to the winner's entity page;
 *   - ANTI-LOOP (W-i4, NON-VACUOUS): a mention from an agent-authored (entity/insight) page never
 *     feeds reflection, while an identical mention from a human (wiki) page does;
 *   - insight pages are linkable + backlinked (Sources [[slug]] → real doc_links);
 *   - a dream reflection over an entity mints its insight page + updates its entity page (author=system);
 *   - tenant isolation throughout.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const STAMP = "2026-06-25T00:00:00.000Z"

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  tenantId: "eA",
  userId: "system",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
  ...overrides,
})

const entityStore = (o: Partial<Principal> = {}) => new EntityPageStore(raw(), principal(o))
const wiki = (o: Partial<Principal> = {}) => new WikiStore(raw(), principal(o))
const count = async (sql: string, binds: unknown[] = []): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

const seedEntity = async (o: {
  id: string
  tenantId: string
  kind?: string
  name: string
  description?: string
  visibility?: string
  teamId?: string | null
  scope?: string | null
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
                           mention_count, scope, visibility, team_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', 0, ?, ?, ?, ?, ?)`,
  )
    .bind(
      o.id,
      o.tenantId,
      o.kind ?? "concept",
      o.name,
      o.description ?? `${o.name} description`,
      o.scope ?? null,
      o.visibility ?? "world",
      o.teamId ?? null,
      STAMP,
      STAMP,
    )
    .run()
}

const seedMention = async (o: {
  id: string
  tenantId: string
  entityId: string
  sourceKind: string
  sourceId: string
  createdAt?: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entity_mentions (id, tenant_id, entity_id, source_kind, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(o.id, o.tenantId, o.entityId, o.sourceKind, o.sourceId, o.createdAt ?? STAMP)
    .run()
}

const seedRelation = async (o: {
  id: string
  tenantId: string
  from: string
  to: string
  kind: string
}): Promise<void> => {
  await env_.DB.prepare(
    `INSERT INTO entity_relations (id, tenant_id, from_entity_id, to_entity_id, kind, confidence, evidence_chunk_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0.9, '[]', ?, ?)`,
  )
    .bind(o.id, o.tenantId, o.from, o.to, o.kind, STAMP, STAMP)
    .run()
}

describe("entity pages — visibility inheritance, authorship, live sections", () => {
  test("mint inherits the entity's tier (never private) + records the system author + entity_id", async () => {
    await seedEntity({ id: "eW", tenantId: "eV", kind: "person", name: "Ada Lovelace" })
    await seedEntity({
      id: "eT",
      tenantId: "eV",
      kind: "org",
      name: "Team Co",
      visibility: "team",
      teamId: "teamZ",
    })
    const worldStore = entityStore({ tenantId: "eV" })
    const teamStore = entityStore({ tenantId: "eV", teamIds: ["teamZ"] })

    const w = await worldStore.mintOrUpdate("eW", {
      body: "# Ada\n\nPioneer.",
      systemAuthored: true,
    })
    expect(w?.slug).toBe("entities/person/ada-lovelace")
    const wp = await wiki({ tenantId: "eV" }).getPage(w?.slug ?? "")
    expect(wp?.page.visibility).toBe("world")
    expect(wp?.page.ingestedVia).toBe("entity")
    expect(wp?.page.entityId).toBe("eW")
    expect(wp?.revisions[0]?.authorUserId).toBe("system")

    const t = await teamStore.mintOrUpdate("eT", { body: "# Team Co", systemAuthored: true })
    const tp = await wiki({ tenantId: "eV", teamIds: ["teamZ"] }).getPage(t?.slug ?? "")
    expect(tp?.page.visibility).toBe("team") // inherited, NOT private
    // No entity page is ever private (entities are {world,team} only).
    expect(
      await count(
        "SELECT count(*) AS n FROM pages WHERE ingested_via='entity' AND visibility='private'",
      ),
    ).toBe(0)
  })

  test("a team entity IS maintained by the tenant system principal (teamIds:[]); tier widens team→world", async () => {
    // The dream/system principal is on NO team — it must still maintain team-visibility entity pages.
    await seedEntity({
      id: "tm",
      tenantId: "eTM",
      kind: "org",
      name: "Team Widget",
      visibility: "team",
      teamId: "teamQ",
    })
    const system = entityStore({ tenantId: "eTM", userId: "system", teamIds: [] })
    const minted = await system.mintOrUpdate("tm", { body: "# Team Widget", systemAuthored: true })
    expect(minted).not.toBeNull()
    // The page inherits the entity's team tier (visible to a team member, minted despite teamIds:[]).
    const asMember = wiki({ tenantId: "eTM", teamIds: ["teamQ"] })
    expect((await asMember.getPage("entities/org/team-widget"))?.page.visibility).toBe("team")

    // Entity promotes team→world (monotonic); the next system write WIDENS the page tier.
    await env_.DB.prepare(
      "UPDATE entities SET visibility='world', team_id=NULL WHERE id='tm' AND tenant_id='eTM'",
    ).run()
    await system.mintOrUpdate("tm", { body: "# Team Widget (now world)", systemAuthored: true })
    expect(
      (await wiki({ tenantId: "eTM" }).getPage("entities/org/team-widget"))?.page.visibility,
    ).toBe("world")
  })

  test("the human editor-in-chief wins: a later system write is skipped (don't-clobber, W-i3)", async () => {
    await seedEntity({ id: "eH", tenantId: "eH1", kind: "concept", name: "Widget" })
    const sys = entityStore({ tenantId: "eH1", userId: "system" })
    const minted = await sys.mintOrUpdate("eH", { body: "v1 by dream", systemAuthored: true })
    const slug = minted?.slug ?? ""
    // A human edits the entity page directly (author = a real user) via the entity store.
    const human = entityStore({ tenantId: "eH1", userId: "human-1" })
    await human.mintOrUpdate("eH", { body: "v2 by human", systemAuthored: false })
    // The dream tries again → SKIPPED (human edited more recently).
    const again = await sys.mintOrUpdate("eH", { body: "v3 by dream", systemAuthored: true })
    expect(again?.skippedHumanEdited).toBe(true)
    expect((await wiki({ tenantId: "eH1" }).getPage(slug))?.body).toBe("v2 by human")
  })

  test("live sections: mentions + relations resolve to the other entity's page slug", async () => {
    await seedEntity({ id: "sA", tenantId: "eS", kind: "person", name: "Grace Hopper" })
    await seedEntity({ id: "sB", tenantId: "eS", kind: "concept", name: "COBOL" })
    await seedMention({
      id: "sm1",
      tenantId: "eS",
      entityId: "sA",
      sourceKind: "chunk",
      sourceId: "c1",
    })
    await seedRelation({ id: "sr1", tenantId: "eS", from: "sA", to: "sB", kind: "created" })
    // The mention's source chunk must exist + be visible for the section to surface it (isolation gate).
    await env_.DB.prepare(
      `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content, embedding_model, embedding_dims, updated_at)
       VALUES ('c1', 'eS', 'd1', 'world', 0, 'grace note', '@cf/baai/bge-m3', 1024, ?)`,
    )
      .bind(STAMP)
      .run()
    const store = entityStore({ tenantId: "eS" })
    await store.mintOrUpdate("sA", { body: "# Grace", systemAuthored: true })
    const page = await wiki({ tenantId: "eS" }).getPage("entities/person/grace-hopper")
    expect(page?.entity?.mentions.length).toBe(1)
    expect(page?.entity?.relations[0]?.slug).toBe(entityPageSlug("concept", "COBOL"))
    expect(page?.entity?.relations[0]?.direction).toBe("out")
  })

  test("lazy stub: an entities/ slug with a live entity but no page returns a synthesizable stub", async () => {
    await seedEntity({ id: "eL", tenantId: "eLz", kind: "person", name: "Alan Turing" })
    const stub = await wiki({ tenantId: "eLz" }).getPage("entities/person/alan-turing")
    expect(stub?.stub).toBe(true)
    expect(stub?.page.id).toBe("") // not minted yet
    expect(stub?.entity?.canonicalName).toBe("Alan Turing")
  })
})

describe("D4 merge re-points the loser's entity page to a redirect", () => {
  test("repointMergedPage turns the loser page into a redirect to the winner's entity page", async () => {
    await seedEntity({ id: "mW", tenantId: "eM", kind: "org", name: "Cloudflare Workers" })
    await seedEntity({ id: "mL", tenantId: "eM", kind: "org", name: "CF Workers" })
    const store = entityStore({ tenantId: "eM" })
    await store.mintOrUpdate("mL", { body: "# CF Workers", systemAuthored: true })
    const loserSlug = entityPageSlug("org", "CF Workers")
    const winnerSlug = entityPageSlug("org", "Cloudflare Workers")

    const res = await store.repointMergedPage("mL", "mW")
    expect(res.repointed).toBe(true)
    expect(res.winnerSlug).toBe(winnerSlug)
    const redirected = await wiki({ tenantId: "eM" }).getPage(loserSlug)
    expect(redirected?.page.type).toBe("redirect")
    expect(redirected?.body).toContain(`[[${winnerSlug}]]`)
  })

  test("a WORLD loser folded into a TEAM winner leaves a TEAM-visible redirect (no leak)", async () => {
    await seedEntity({
      id: "twW",
      tenantId: "eMR",
      kind: "org",
      name: "Team Winner",
      visibility: "team",
      teamId: "tX",
    })
    await seedEntity({ id: "twL", tenantId: "eMR", kind: "org", name: "World Loser" }) // world
    const system = entityStore({ tenantId: "eMR", userId: "system", teamIds: [] })
    await system.mintOrUpdate("twL", { body: "# World Loser", systemAuthored: true })
    const loserSlug = entityPageSlug("org", "World Loser")
    // Mirror production order: the entity was merged (soft-deleted) BEFORE the page re-point, so the
    // loser entity no longer yields a lazy stub — the redirect page is the only thing at that slug.
    await env_.DB.prepare(
      "UPDATE entities SET merged_into='twW' WHERE id='twL' AND tenant_id='eMR'",
    ).run()

    const res = await system.repointMergedPage("twL", "twW")
    expect(res.repointed).toBe(true)
    // The redirect points at a TEAM winner → it must itself be team-visible, never world.
    const asMember = wiki({ tenantId: "eMR", teamIds: ["tX"] })
    expect((await asMember.getPage(loserSlug))?.page.visibility).toBe("team")
    // A non-member (was able to see the world loser before) can no longer see the redirect.
    expect(
      await wiki({ tenantId: "eMR", userId: "outsider", teamIds: [] }).getPage(loserSlug),
    ).toBeNull()
  })
})

describe("entity-page mentions are visibility-gated (no cross-user source leak)", () => {
  test("a private-source mention of a world entity does NOT appear in another user's sections", async () => {
    await seedEntity({ id: "mv", tenantId: "eMV", kind: "person", name: "Marie Skłodowska" })
    // A PRIVATE chunk owned by u1 + a WORLD chunk, each mentioning the world entity.
    await env_.DB.prepare(
      `INSERT INTO chunks (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
                           content, embedding_model, embedding_dims, updated_at)
       VALUES ('pc', 'eMV', 'pd', NULL, NULL, 'u1', 'private', 0, 'private note', '@cf/baai/bge-m3', 1024, ?),
              ('wc', 'eMV', 'wd', NULL, NULL, NULL, 'world', 0, 'world note', '@cf/baai/bge-m3', 1024, ?)`,
    )
      .bind(STAMP, STAMP)
      .run()
    await seedMention({
      id: "vm1",
      tenantId: "eMV",
      entityId: "mv",
      sourceKind: "chunk",
      sourceId: "pc",
    })
    await seedMention({
      id: "vm2",
      tenantId: "eMV",
      entityId: "mv",
      sourceKind: "chunk",
      sourceId: "wc",
    })
    await entityStore({ tenantId: "eMV", userId: "system" }).mintOrUpdate("mv", {
      body: "# Marie",
      systemAuthored: true,
    })
    const slug = entityPageSlug("person", "Marie Skłodowska")

    // Another user (u2) sees ONLY the world-chunk mention — never u1's private-chunk source id.
    const asU2 = await wiki({ tenantId: "eMV", userId: "u2" }).getPage(slug)
    const u2Sources = new Set(asU2?.entity?.mentions.map((m) => m.sourceId))
    expect(u2Sources.has("wc")).toBe(true)
    expect(u2Sources.has("pc")).toBe(false) // the private source is gated out

    // The owner (u1) sees both.
    const asU1 = await wiki({ tenantId: "eMV", userId: "u1" }).getPage(slug)
    const u1Sources = new Set(asU1?.entity?.mentions.map((m) => m.sourceId))
    expect(u1Sources.has("pc")).toBe(true)
    expect(u1Sources.has("wc")).toBe(true)
  })
})

describe("anti-loop (W-i4) — agent-authored page mentions never feed reflection; human ones do", () => {
  test("a mention from an ingested_via='entity' page is excluded; from a 'wiki' page it counts", async () => {
    // Two entities, each with exactly one recent mention in the window — but sourced from pages of
    // DIFFERENT provenance. Only the human (wiki) page's mention should make its entity a target.
    await seedEntity({ id: "aAgent", tenantId: "eLoop", kind: "concept", name: "Agent Topic" })
    await seedEntity({ id: "aHuman", tenantId: "eLoop", kind: "concept", name: "Human Topic" })
    // Mint an agent (entity) page + a human (wiki) page to source the mentions from.
    const agentPage = await entityStore({ tenantId: "eLoop" }).mintOrUpdate("aAgent", {
      body: "# Agent Topic",
      systemAuthored: true,
    })
    const humanWikiPage = await wiki({ tenantId: "eLoop", userId: "u1" }).savePage({
      slug: "notes/human-topic",
      type: "note",
      body: "human note",
    })
    const agentPageId =
      (await wiki({ tenantId: "eLoop" }).getPage(agentPage?.slug ?? ""))?.page.id ?? ""
    const since = "2026-06-01T00:00:00.000Z"
    const inWindow = "2026-06-25T00:00:00.000Z"
    await seedMention({
      id: "mAgent",
      tenantId: "eLoop",
      entityId: "aAgent",
      sourceKind: "page",
      sourceId: agentPageId,
      createdAt: inWindow,
    })
    await seedMention({
      id: "mHuman",
      tenantId: "eLoop",
      entityId: "aHuman",
      sourceKind: "page",
      sourceId: humanWikiPage.pageId,
      createdAt: inWindow,
    })

    const targets = await selectReflectionTargets(raw(), principal({ tenantId: "eLoop" }), {
      since,
      limit: 10,
    })
    const keys = new Set(targets.map((t) => t.key))
    expect(keys.has("e:aHuman")).toBe(true) // human wiki-page mention counts
    expect(keys.has("e:aAgent")).toBe(false) // agent entity-page mention is excluded (anti-loop)
  })
})

describe("insight pages — linkable + backlinked (Sources [[slug]] → real doc_links)", () => {
  test("mintInsightPage creates an ingested_via='insight' page whose Sources become backlinks", async () => {
    // A target page the insight will cite.
    await wiki({ tenantId: "eI", userId: "u1" }).savePage({
      slug: "kb/pricing",
      type: "note",
      visibility: "world",
      body: "pricing facts",
    })
    await mintInsightPage(raw(), principal({ tenantId: "eI" }), {
      slugKey: "pricing",
      title: "Pricing",
      body: "# Insight: Pricing\n\nStuff.\n\n## Sources\n- [[kb/pricing]]\n",
    })
    const insight = await wiki({ tenantId: "eI" }).getPage("insights/pricing")
    expect(insight?.page.ingestedVia).toBe("insight")
    // The Source [[kb/pricing]] resolved to a real doc_link → a backlink on the cited page.
    const cited = await wiki({ tenantId: "eI" }).getPage("kb/pricing")
    expect(cited?.backlinks.some((b) => b.fromId === insight?.page.id)).toBe(true)
  })
})

describe("tenant isolation", () => {
  test("an entity page in tenant A is invisible from tenant B", async () => {
    await seedEntity({ id: "iso", tenantId: "isoA", kind: "person", name: "Secret Person" })
    await entityStore({ tenantId: "isoA" }).mintOrUpdate("iso", {
      body: "secret",
      systemAuthored: true,
    })
    const slug = entityPageSlug("person", "Secret Person")
    expect((await wiki({ tenantId: "isoA" }).getPage(slug))?.body).toBe("secret")
    expect(await wiki({ tenantId: "isoB", userId: "u9" }).getPage(slug)).toBeNull()
  })
})

// ── Integration: a dream reflection over an entity mints its insight page + entity page ──

const vec1024 = (): number[] => new Array(1024).fill(0)
const fakeIndex = (matches: { id: string; score: number }[]) =>
  ({
    query: async () => ({ count: matches.length, matches }),
    upsert: async () => ({ mutationId: "m" }),
  }) as unknown as Vectorize

const reflectServices = (tenantId: string): DreamReflectServices => {
  const p = principal({ tenantId })
  const rawDb = raw()
  return {
    db: new ScopedDB(rawDb, p),
    vectors: new ScopedVectorize(fakeIndex([{ id: "rc-1", score: 0.95 }]), p),
    entityVectors: new ScopedVectorize(fakeIndex([]), p),
    graph: new ScopedGraph(rawDb, p),
    wiki: new WikiStore(rawDb, p),
    blobs: new ScopedR2(env_.BODIES, p),
    ai: {
      embed: async () => [vec1024()],
      embedForIndex: async (texts: string[]) => texts.map(() => vec1024()),
      gen: async () => "Ada pioneered computing. [cited]",
      genExtract: async () => null,
      rerank: async (_q: string, c: { text: string }[], k: number) =>
        c.map((_x, i) => ({ index: i, score: 0 })).slice(0, k),
      transcribe: async () => ({ text: "stub", neurons: 0 }),
    },
    raw: rawDb,
    runs: new DreamRunStore(rawDb, p),
    principal: p,
  }
}

const seedDoc = async (o: { id: string; tenantId: string; slug: string; path: string }) => {
  await env_.DB.prepare(
    `INSERT INTO documents (id, tenant_id, user_id, slug, path, status, fingerprint, created_at)
     VALUES (?, ?, 'seed', ?, ?, 'indexed', ?, ?)`,
  )
    .bind(o.id, o.tenantId, o.slug, o.path, `fp-${o.id}`, STAMP)
    .run()
}
const seedChunk = async (o: {
  id: string
  tenantId: string
  documentId: string
  content: string
}) => {
  await env_.DB.prepare(
    `INSERT INTO chunks (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
                         content, embedding_model, embedding_dims, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, 'world', 0, ?, '@cf/baai/bge-m3', 1024, ?)`,
  )
    .bind(o.id, o.tenantId, o.documentId, o.content, STAMP)
    .run()
}

describe("dream reflection maintains the entity page + insight page (author=system)", () => {
  beforeAll(async () => {
    // An entity with a recent chunk-sourced mention (real doc → counts as a reflection target).
    await seedEntity({ id: "rc-e", tenantId: "eR", kind: "person", name: "Ada Byron" })
    await seedDoc({ id: "rc-doc", tenantId: "eR", slug: "ada-doc", path: "/brain/topics/ada" })
    await seedChunk({
      id: "rc-1",
      tenantId: "eR",
      documentId: "rc-doc",
      content: "Ada Byron pioneered computing.",
    })
    await seedMention({
      id: "rc-m",
      tenantId: "eR",
      entityId: "rc-e",
      sourceKind: "chunk",
      sourceId: "rc-1",
      createdAt: "2026-06-25T00:00:00.000Z",
    })
  })

  test("reflecting over the entity writes its insight page + entity page, both system-authored", async () => {
    const result = await runDreamReflection(reflectServices("eR"), { runId: "eR-reflect-1" })
    expect(result.status).toBe("success")

    const slugKey = "ada-byron" // slugify("Ada Byron")
    const insight = await wiki({ tenantId: "eR" }).getPage(`insights/${slugKey}`)
    expect(insight?.page.ingestedVia).toBe("insight")
    // W3 (Option A): the insight page reuses the EXISTING insight document as its backing doc.
    expect(
      await count(
        "SELECT count(*) AS n FROM pages WHERE tenant_id='eR' AND slug=? AND document_id IS NOT NULL",
        [`insights/${slugKey}`],
      ),
    ).toBe(1)

    const entityPage = await wiki({ tenantId: "eR" }).getPage(entityPageSlug("person", "Ada Byron"))
    expect(entityPage?.page.ingestedVia).toBe("entity")
    expect(entityPage?.revisions[0]?.authorUserId).toBe("system") // dream authored (W-i3)
    // The entity page links to its insight page.
    expect(entityPage?.links.resolved.some((l) => l.toId === insight?.page.id)).toBe(true)
  })
})

import { env } from "cloudflare:test"
import {
  type BrainBindings,
  deleteBackingDoc,
  EntityPageStore,
  entityPageSlug,
  ScopedDB,
  ScopedGraph,
  ScopedR2,
  type ScopedServices,
  ScopedVectorize,
  type SearchDeps,
  searchOp,
  selectReflectionTargets,
  syncBackingDoc,
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { describe, expect, test } from "vitest"
import { runBatchIngest } from "../src/ingest"

/**
 * THE v3/W3 backing-document canary (real local D1 in workerd). Proves pages become searchable via a
 * backing `documents` row that rides the ingest spine, AND the lifecycle + anti-loop invariants:
 *   - save → backing doc (slug=page slug, sourceKind='page', /wiki/<slug>) + chunks;
 *   - edit → the SAME doc is superseded (not duplicated); move → the doc's slug+path follow;
 *   - delete → the doc + its chunks + vectors are gone;
 *   - a backing doc is never listed by list_documents (it's an internal index);
 *   - ANTI-LOOP (W-i4): a HUMAN wiki page's backing doc IS KG-extracted → feeds reflection; an AGENT
 *     entity page's backing doc is searchable but KG-SKIPPED → creates NO chunk-mentions, so the
 *     dream's own synthesis can never feed the graph.
 */

const env_ = env as unknown as BrainBindings
const raw = () => drizzle(env_.DB)
const STAMP = "2026-06-25T00:00:00.000Z"

const principal = (o: Partial<Principal> = {}): Principal => ({
  tenantId: "bd",
  userId: "u1",
  teamIds: [],
  role: "admin",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
  ...o,
})

const vec = (): number[] => new Array(1024).fill(0.1)
const fakeVectorize = () => {
  const store = new Set<string>()
  return {
    index: {
      upsert: async (vs: { id: string }[]) => {
        for (const v of vs) store.add(v.id)
        return { mutationId: "m", count: vs.length, ids: vs.map((v) => v.id) }
      },
      query: async () => ({ count: 0, matches: [] }),
      deleteByIds: async (ids: string[]) => {
        for (const id of ids) store.delete(id)
        return { mutationId: "m", count: ids.length }
      },
    } as unknown as Vectorize,
    store,
  }
}

/** KG stub: extracts a single fixed entity so we can prove the human-vs-agent extraction contrast. */
const kgJson = (name: string) =>
  JSON.stringify({
    entities: [{ name, kind: "concept", aliases: [], description: `${name} desc` }],
    relationships: [],
  })

const buildServices = (
  tenantId: string,
  vzn: Vectorize,
  kgName: string,
  teamIds: string[] = [],
): ScopedServices => {
  const p = principal({ tenantId, teamIds })
  const db = raw()
  return {
    db: new ScopedDB(db, p),
    vectors: new ScopedVectorize(vzn, p),
    entityVectors: new ScopedVectorize(vzn, p),
    graph: new ScopedGraph(db, p),
    wiki: new WikiStore(db, p),
    blobs: new ScopedR2(env_.BODIES, p),
    ai: {
      embed: async (t: string[]) => t.map(() => vec()),
      embedForIndex: async (t: string[]) => t.map(() => vec()),
      gen: async () => null,
      genExtract: async () => kgJson(kgName),
      rerank: async (_q: string, c: { text: string }[], k: number) =>
        c.map((_x, i) => ({ index: i, score: 0 })).slice(0, k),
      transcribe: async () => ({ text: "stub", neurons: 0 }),
    },
  } as unknown as ScopedServices
}

const count = async (sql: string, binds: unknown[] = []): Promise<number> => {
  const res = await env_.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()
  return res?.n ?? 0
}

const seedEntity = async (id: string, tenantId: string, kind: string, name: string) => {
  await env_.DB.prepare(
    `INSERT INTO entities (id, tenant_id, kind, canonical_name, aliases, description, source_chunk_ids,
                           mention_count, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', 0, 'world', ?, ?)`,
  )
    .bind(id, tenantId, kind, name, `${name} desc`, STAMP, STAMP)
    .run()
}

describe("backing-doc lifecycle — save / edit / move / delete follow the page", () => {
  test("save creates a backing doc (slug=page slug) + chunks; edit supersedes; delete cascades", async () => {
    const vz = fakeVectorize()
    const services = buildServices("bdL", vz.index, "Ignored")
    const w = services.wiki

    // SAVE → backing doc + chunks.
    const saved = await w.savePage({
      slug: "guides/setup",
      type: "note",
      visibility: "world",
      body: "The setup guide covers installation and configuration.",
    })
    await syncBackingDoc(services, saved.pageId, (p) => runBatchIngest(services, p).then(() => {}))

    // Exactly ONE backing doc, slug=page slug, sourceKind='page', /wiki/ namespace, origin NULL (human).
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='bdL' AND source_kind='page' AND slug='guides/setup' AND path='/wiki/guides/setup' AND origin IS NULL",
      ),
    ).toBe(1)
    const docId = (
      await env_.DB.prepare(
        "SELECT id FROM documents WHERE tenant_id='bdL' AND slug='guides/setup'",
      ).first<{ id: string }>()
    )?.id
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE document_id=?", [docId]),
    ).toBeGreaterThan(0)
    // The page links its backing doc.
    expect(
      await count("SELECT count(*) AS n FROM pages WHERE id=? AND document_id=?", [
        saved.pageId,
        docId,
      ]),
    ).toBe(1)
    // A backing doc is NEVER surfaced by list_documents.
    expect((await services.db.listDocuments()).some((d) => d.slug === "guides/setup")).toBe(false)

    // SKIP-UNCHANGED: re-syncing with NO content change is a no-op — the injected ingest MUST NOT run
    // (it throws if called) and the chunk rows are untouched (no re-embed). Deliverable 2's perf claim.
    const chunksBefore = await env_.DB.prepare(
      "SELECT id FROM chunks WHERE document_id=? ORDER BY id",
    )
      .bind(docId)
      .all<{ id: string }>()
    const resync = await syncBackingDoc(services, saved.pageId, () => {
      throw new Error("skip-unchanged violated: re-ingested an unchanged page")
    })
    expect(resync?.changed).toBe(false)
    const chunksAfter = await env_.DB.prepare(
      "SELECT id FROM chunks WHERE document_id=? ORDER BY id",
    )
      .bind(docId)
      .all<{ id: string }>()
    expect(chunksAfter.results.map((r) => r.id)).toEqual(chunksBefore.results.map((r) => r.id))

    // EDIT → the SAME doc is superseded (not duplicated); chunk set replaced.
    await w.savePage({
      slug: "guides/setup",
      type: "note",
      visibility: "world",
      body: "The setup guide now also covers upgrades and rollback.",
    })
    await syncBackingDoc(services, saved.pageId, (p) => runBatchIngest(services, p).then(() => {}))
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='bdL' AND slug='guides/setup'",
      ),
    ).toBe(1) // still ONE doc
    expect(
      await count(
        "SELECT count(*) AS n FROM chunks WHERE tenant_id='bdL' AND content LIKE '%rollback%'",
      ),
    ).toBeGreaterThan(0)

    // DELETE → the backing doc + its chunks are gone (soft-deleted).
    const del = await w.deletePage("guides/setup")
    if (del.pageId !== null) await deleteBackingDoc(services, del.pageId)
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='bdL' AND slug='guides/setup' AND deleted_at IS NULL",
      ),
    ).toBe(0)
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE document_id=? AND deleted_at IS NULL", [
        docId,
      ]),
    ).toBe(0)
  })

  test("move re-points the backing doc's slug + path to the new page slug", async () => {
    const vz = fakeVectorize()
    const services = buildServices("bdM", vz.index, "Ignored")
    const w = services.wiki
    const saved = await w.savePage({
      slug: "old-home",
      type: "note",
      visibility: "world",
      body: "home page body",
    })
    await syncBackingDoc(services, saved.pageId, (p) => runBatchIngest(services, p).then(() => {}))

    const moved = await w.movePage("old-home", "new-home")
    await syncBackingDoc(services, moved.pageId, (p) => runBatchIngest(services, p).then(() => {}))
    // The backing doc (same id) now carries the NEW slug + path; citations resolve to the new page.
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='bdM' AND source_kind='page' AND slug='new-home' AND path='/wiki/new-home'",
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='bdM' AND source_kind='page' AND slug='old-home'",
      ),
    ).toBe(0)
  })

  test("narrowing world→private (same body) drops the wider-tier chunks — no visibility-downgrade leak", async () => {
    const vz = fakeVectorize()
    const services = buildServices("bdN", vz.index, "Ignored")
    const saved = await services.wiki.savePage({
      slug: "secret/plan",
      type: "note",
      visibility: "world",
      body: "the secret plan details",
    })
    await syncBackingDoc(services, saved.pageId, (p) => runBatchIngest(services, p).then(() => {}))
    const docId = (
      await env_.DB.prepare(
        "SELECT id FROM documents WHERE tenant_id='bdN' AND slug='secret/plan'",
      ).first<{
        id: string
      }>()
    )?.id
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE document_id=? AND visibility='world'", [
        docId,
      ]),
    ).toBeGreaterThan(0)

    // Narrow to private with the SAME body → the tier-salted fingerprint changes → re-ingest.
    await services.wiki.savePage({
      slug: "secret/plan",
      type: "note",
      visibility: "private",
      body: "the secret plan details",
    })
    const resync = await syncBackingDoc(services, saved.pageId, (p) =>
      runBatchIngest(services, p).then(() => {}),
    )
    expect(resync?.changed).toBe(true) // NOT skipped despite the unchanged body
    // NO wider-tier chunk survives; the chunks are now private + carry the author (so the author can search).
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE document_id=? AND visibility='world'", [
        docId,
      ]),
    ).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM chunks WHERE document_id=? AND visibility='private' AND user_id='u1'",
        [docId],
      ),
    ).toBeGreaterThan(0)
  })

  test("delete then recreate at the same slug is searchable again (resurrects the backing doc)", async () => {
    const vz = fakeVectorize()
    const services = buildServices("bdD", vz.index, "Ignored")
    const saved = await services.wiki.savePage({
      slug: "rec/page",
      type: "note",
      visibility: "world",
      body: "original body",
    })
    await syncBackingDoc(services, saved.pageId, (p) => runBatchIngest(services, p).then(() => {}))
    const docId = (
      await env_.DB.prepare(
        "SELECT id FROM documents WHERE tenant_id='bdD' AND slug='rec/page'",
      ).first<{
        id: string
      }>()
    )?.id

    // Delete → the backing doc soft-deletes (still holds the slug + fingerprint).
    const del = await services.wiki.deletePage("rec/page")
    if (del.pageId !== null) await deleteBackingDoc(services, del.pageId)
    expect(
      await count("SELECT count(*) AS n FROM documents WHERE id=? AND deleted_at IS NOT NULL", [
        docId,
      ]),
    ).toBe(1)

    // Recreate at the SAME slug → the page resurrects (same id/documentId); sync must RESURRECT the
    // backing doc (supersede), NOT a fresh insert that would collide on the unique slug/fp indexes.
    const recreated = await services.wiki.savePage({
      slug: "rec/page",
      type: "note",
      visibility: "world",
      body: "brand new body",
    })
    const res = await syncBackingDoc(services, recreated.pageId, (p) =>
      runBatchIngest(services, p).then(() => {}),
    )
    expect(res?.changed).toBe(true)
    expect(res?.documentId).toBe(docId) // resurrected the SAME doc, not a new one
    // Live + indexed + the new content is searchable again.
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE id=? AND deleted_at IS NULL AND status='indexed'",
        [docId],
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT count(*) AS n FROM chunks WHERE document_id=? AND deleted_at IS NULL AND content LIKE '%brand new%'",
        [docId],
      ),
    ).toBeGreaterThan(0)
  })

  test("a team page's backing-doc chunks inherit the page's team visibility (search isolation)", async () => {
    const vz = fakeVectorize()
    const services = buildServices("bdT", vz.index, "Ignored", ["teamK"])
    const saved = await services.wiki.savePage({
      slug: "team/secret",
      type: "note",
      visibility: "team",
      body: "team-only backing content",
    })
    await syncBackingDoc(services, saved.pageId, (p) => runBatchIngest(services, p).then(() => {}))
    // The searchable copy is isolated exactly like the page (W2's "visibility on the copy" lesson):
    // chunks carry visibility='team' + the teamId, and NONE are world-visible.
    expect(
      await count(
        `SELECT count(*) AS n FROM chunks c JOIN documents d ON d.id=c.document_id
         WHERE d.tenant_id='bdT' AND d.slug='team/secret' AND c.visibility='team' AND c.team_id='teamK'`,
      ),
    ).toBeGreaterThan(0)
    expect(
      await count(
        `SELECT count(*) AS n FROM chunks c JOIN documents d ON d.id=c.document_id
         WHERE d.tenant_id='bdT' AND d.slug='team/secret' AND c.visibility='world'`,
      ),
    ).toBe(0)
  })
})

describe("D4 merge reaps the loser entity page's stale backing doc", () => {
  test("after a merge + repoint, the loser page's backing doc + chunks are gone from search", async () => {
    const vz = fakeVectorize()
    const services = buildServices("bdMg", vz.index, "Ignored")
    await seedEntity("loserE", "bdMg", "org", "Loser Co")
    await seedEntity("winnerE", "bdMg", "org", "Winner Co")
    const eps = new EntityPageStore(raw(), principal({ tenantId: "bdMg" }))
    const minted = await eps.mintOrUpdate("loserE", {
      body: "# Loser Co\n\nsearchable pre-merge content",
      systemAuthored: true,
    })
    await syncBackingDoc(services, minted?.pageId ?? "", (p) =>
      runBatchIngest(services, p).then(() => {}),
    )
    const docId = (
      await env_.DB.prepare("SELECT document_id AS id FROM pages WHERE id=?")
        .bind(minted?.pageId ?? "")
        .first<{ id: string }>()
    )?.id
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE document_id=? AND deleted_at IS NULL", [
        docId,
      ]),
    ).toBeGreaterThan(0) // searchable before the merge

    // Merge loser→winner + repoint the page (what the dedup sweep does), then reap the backing doc.
    await services.graph.mergeEntities("winnerE", "loserE")
    const rp = await eps.repointMergedPage("loserE", "winnerE")
    expect(rp.loserPageId).toBeDefined()
    await syncBackingDoc(services, rp.loserPageId ?? "", (p) =>
      runBatchIngest(services, p).then(() => {}),
    )
    // The loser's backing doc + chunks are soft-deleted → no longer searchable, can't cite the redirect.
    expect(
      await count("SELECT count(*) AS n FROM documents WHERE id=? AND deleted_at IS NULL", [docId]),
    ).toBe(0)
    expect(
      await count("SELECT count(*) AS n FROM chunks WHERE document_id=? AND deleted_at IS NULL", [
        docId,
      ]),
    ).toBe(0)
    // The redirect page no longer points at a dead doc.
    expect(
      await count("SELECT count(*) AS n FROM pages WHERE id=? AND document_id IS NULL", [
        rp.loserPageId ?? "",
      ]),
    ).toBe(1)
  })
})

describe("citation reverse-map (W3, Option A) — a page-backed doc hit cites the PAGE slug", () => {
  test("a search hit in an insight DOCUMENT cites the linked insight PAGE, not the raw doc slug", async () => {
    // The insight page reuses the EXISTING insight doc (no duplicate). Doc slug 'insight-rev-abc' but
    // the page slug is 'insights/rev' — a hit must cite the PAGE (reverse-map via pages.document_id).
    await env_.DB.prepare(
      `INSERT INTO documents (id, tenant_id, user_id, slug, path, status, fingerprint, origin, created_at)
       VALUES ('idoc', 'bdR', 'system', 'insight-rev-abc', '/brain/insights/rev', 'indexed', 'fp-idoc', 'dream', ?)`,
    )
      .bind(STAMP)
      .run()
    await env_.DB.prepare(
      `INSERT INTO chunks (id, tenant_id, document_id, visibility, chunk_index, content, embedding_model, embedding_dims, updated_at)
       VALUES ('idoc:0', 'bdR', 'idoc', 'world', 0, 'reverseneedle insight content', '@cf/baai/bge-m3', 1024, ?)`,
    )
      .bind(STAMP)
      .run()
    await env_.DB.prepare(
      `INSERT INTO pages (id, tenant_id, slug, type, title, visibility, compiled_truth, frontmatter,
                          ingested_via, document_id, created_at, updated_at)
       VALUES ('ipage', 'bdR', 'insights/rev', 'insight', 'Rev', 'world', 'body', '{}', 'insight', 'idoc', ?, ?)`,
    )
      .bind(STAMP, STAMP)
      .run()

    const p = principal({ tenantId: "bdR" })
    const deps: SearchDeps = {
      db: new ScopedDB(raw(), p),
      vectors: new ScopedVectorize(
        {
          query: async () => ({ count: 1, matches: [{ id: "idoc:0", score: 0.95 }] }),
        } as unknown as Vectorize,
        p,
      ),
      ai: { embed: async () => [vec()], gen: async () => null, rerank: async () => [] },
      budget: { check: async () => {} },
      recall: { append: async () => {} },
    }
    const out = (await searchOp.handler(
      { deps, principal: p },
      { query: "reverseneedle", topK: 5 },
    )) as {
      hits: { slug: string }[]
    }
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.hits[0]?.slug).toBe("insights/rev") // the PAGE slug, NOT 'insight-rev-abc'
  })
})

describe("backing-doc anti-loop (W-i4) — human page feeds the graph, agent page never does", () => {
  test("a human wiki page's backing doc IS KG-extracted (→ reflection target); an entity page's is NOT", async () => {
    // HUMAN: a wiki page whose backing doc KG-extracts entity 'Widgeticus' → it becomes a target.
    const vzH = fakeVectorize()
    const servicesH = buildServices("bdH", vzH.index, "Widgeticus")
    const savedH = await servicesH.wiki.savePage({
      slug: "notes/widgets",
      type: "note",
      visibility: "world",
      body: "A long note about industrial widgets and their many uses in the field.",
    })
    await syncBackingDoc(servicesH, savedH.pageId, (p) =>
      runBatchIngest(servicesH, p).then(() => {}),
    )
    // KG ran over the human page's backing doc → a chunk-mention exists → the entity is a reflection target.
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_mentions WHERE tenant_id='bdH' AND source_kind='chunk'",
      ),
    ).toBeGreaterThan(0)
    const targetsH = await selectReflectionTargets(raw(), principal({ tenantId: "bdH" }), {
      since: null,
      limit: 10,
    })
    expect(targetsH.some((t) => t.label === "Widgeticus")).toBe(true)

    // AGENT: an entity page whose backing doc is searchable but KG-SKIPPED → NO chunk-mentions, so
    // 'Gadgetron' is never extracted and never becomes a reflection target (no dream→graph loop).
    const vzA = fakeVectorize()
    const servicesA = buildServices("bdA", vzA.index, "Gadgetron")
    await seedEntity("subjX", "bdA", "person", "Subject X")
    const eps = new EntityPageStore(raw(), principal({ tenantId: "bdA" }))
    const minted = await eps.mintOrUpdate("subjX", {
      body: "Subject X frequently works with Gadgetron systems across many projects.",
      systemAuthored: true,
    })
    await syncBackingDoc(servicesA, minted?.pageId ?? "", (p) =>
      runBatchIngest(servicesA, p).then(() => {}),
    )
    // Backing doc + chunks exist (searchable)...
    expect(
      await count(
        "SELECT count(*) AS n FROM documents WHERE tenant_id='bdA' AND source_kind='page' AND slug=? AND origin='wiki-agent'",
        [entityPageSlug("person", "Subject X")],
      ),
    ).toBe(1)
    // ...but KG was SKIPPED: no chunk-mentions, and 'Gadgetron' was never extracted → not a target.
    expect(
      await count(
        "SELECT count(*) AS n FROM entity_mentions WHERE tenant_id='bdA' AND source_kind='chunk'",
      ),
    ).toBe(0)
    expect(
      await count(
        "SELECT count(*) AS n FROM entities WHERE tenant_id='bdA' AND canonical_name='Gadgetron'",
      ),
    ).toBe(0)
    const targetsA = await selectReflectionTargets(raw(), principal({ tenantId: "bdA" }), {
      since: null,
      limit: 10,
    })
    expect(targetsA.some((t) => t.label === "Gadgetron")).toBe(false)
  })
})

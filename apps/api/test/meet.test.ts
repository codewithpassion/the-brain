/**
 * Tests for `POST /ingest/meet` (gdrive-watcher receiver): 503 unconfigured, 401 bad bearer,
 * happy path with content, duplicate activityId, and pending stub without content.
 */
import { env } from "cloudflare:test"
import {
  type BrainBindings,
  ScopedDB,
  ScopedGraph,
  ScopedR2,
  type ScopedServices,
  ScopedVectorize,
  WikiStore,
} from "@brain/db"
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src/index"
import { seedOrg } from "./seed"

const TENANT = "meetOrg"
const TOKEN = "meet-test-token"
const baseEnv = env as unknown as BrainBindings
const env_ = { ...baseEnv, MEET_INGEST_TOKEN: TOKEN, MEET_INGEST_TENANT_ID: TENANT }

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

const fakeVectorize = {
  upsert: async (vectors: { id: string }[]) => ({
    mutationId: "fake",
    count: vectors.length,
    ids: vectors.map((v) => v.id),
  }),
  query: async () => ({ count: 0, matches: [] }),
} as unknown as Vectorize

const makeServices = (e: BrainBindings, principal: Principal): ScopedServices => ({
  db: new ScopedDB(drizzle(e.DB), principal),
  vectors: new ScopedVectorize(fakeVectorize, principal),
  entityVectors: new ScopedVectorize(fakeVectorize, principal),
  graph: new ScopedGraph(drizzle(e.DB), principal),
  wiki: new WikiStore(drizzle(e.DB), principal),
  blobs: new ScopedR2(e.BODIES, principal),
  ai: {
    embed: async (texts) => texts.map(() => vec1024()),
    embedForIndex: async (texts) => texts.map(() => vec1024()),
    gen: async () => "",
    genExtract: async () => null,
    rerank: async (_q, candidates, topK) =>
      candidates.map((_c, i) => ({ index: i, score: 0 })).slice(0, topK),
    transcribe: async () => ({ text: "", neurons: 0 }),
  },
})

const app = createApp({ makeServices, inlineIngest: true })

const makeCtx = () => {
  const tasks: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext
  return { ctx, flush: () => Promise.all(tasks) }
}

const post = async (
  body: unknown,
  opts: { auth?: string | null; e?: unknown } = {},
): Promise<Response> => {
  const { ctx, flush } = makeCtx()
  const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth
  const res = await app.request(
    "/ingest/meet",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    },
    opts.e ?? env_,
    ctx,
  )
  await flush()
  return res
}

const dispatch = {
  activityId: "act-1",
  fileId: "file-1",
  fileTitle: "Weekly sync",
  docType: "document",
  time: "2026-10-20T09:30:00Z",
  content: "# Weekly sync\n\nWe decided to ship needle-meet on Friday.",
}

beforeAll(async () => {
  await seedOrg(TENANT, "meet-slug")
})

describe("POST /ingest/meet", () => {
  test("503 when the env vars are missing", async () => {
    const res = await post(dispatch, { e: baseEnv })
    expect(res.status).toBe(503)
  })

  test("401 on missing or wrong bearer", async () => {
    expect((await post(dispatch, { auth: null })).status).toBe(401)
    expect((await post(dispatch, { auth: "Bearer nope" })).status).toBe(401)
  })

  test("400 on an invalid body", async () => {
    expect((await post({ activityId: "x" })).status).toBe(400)
    expect((await post({ ...dispatch, docType: "pdf" })).status).toBe(400)
  })

  test("with content: indexed, slug meet/<activityId>, tags and path set", async () => {
    const res = await post(dispatch)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string; documentId: string; slug: string }
    expect(out.status).toBe("indexed")
    expect(out.slug).toBe("meet/act-1")
    const doc = await env.DB.prepare(
      "SELECT tenant_id, title, tags, path, status FROM documents WHERE id = ?",
    )
      .bind(out.documentId)
      .first<{ tenant_id: string; title: string; tags: string; path: string; status: string }>()
    expect(doc?.tenant_id).toBe(TENANT)
    expect(doc?.title).toBe("Weekly sync")
    expect(doc?.status).toBe("indexed")
    expect(doc?.path).toBe("/meetings/2026-10-20/Weekly sync")
    expect(JSON.parse(doc?.tags ?? "[]")).toEqual(["meet", "document"])
  })

  test("repeat activityId returns duplicate (200)", async () => {
    const res = await post({ ...dispatch, content: "# Edited\n\nDifferent body." })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { status: string; slug: string }
    expect(out.status).toBe("duplicate")
    expect(out.slug).toBe("meet/act-1")
  })

  test("without content: 202 stored-pending-content, tagged, not indexed", async () => {
    const { content: _omit, ...noContent } = { ...dispatch, activityId: "act-2", docType: "mp4" }
    const res = await post(noContent)
    expect(res.status).toBe(202)
    const out = (await res.json()) as { status: string; documentId: string; slug: string }
    expect(out.status).toBe("stored-pending-content")
    const doc = await env.DB.prepare("SELECT tags, status FROM documents WHERE id = ?")
      .bind(out.documentId)
      .first<{ tags: string; status: string }>()
    expect(JSON.parse(doc?.tags ?? "[]")).toEqual(["meet", "mp4", "pending-content"])
    expect(doc?.status).toBe("skipped")

    // The same activity arriving later with content still ingests.
    const later = await post({ ...dispatch, activityId: "act-2", content: "# Later\n\nBody." })
    expect(later.status).toBe(200)
    expect(((await later.json()) as { status: string }).status).toBe("indexed")
  })
})

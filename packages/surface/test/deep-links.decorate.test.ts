import { describe, expect, test } from "bun:test"
import { brainDeepLinks } from "@brain/shared"
import { decorateWithUrls } from "../src/catalog"

/**
 * `decorateWithUrls` — the catalog's post-invoke deep-link stamper. This guards the stringly-typed
 * op-name switch: a typo'd case would silently fall through to `default: return out`, so every
 * decorated family gets an explicit assertion here (the workerd canary then proves the real op
 * output shapes match these casts). Representative outputs are hand-built — decoration is a pure
 * function of (opName, output, links), independent of the DB.
 */
const B = "https://d.test"
const links = brainDeepLinks(B)

describe("decorateWithUrls — one assertion per decorated family", () => {
  test("search: each hit → document url", () => {
    const out = decorateWithUrls("search", { hits: [{ documentId: "d1" }] }, links) as {
      hits: { url?: string }[]
    }
    expect(out.hits[0]?.url).toBe(`${B}/documents/d1`)
  })

  test("query: decorates identically to search (shares SEARCH_OP.output)", () => {
    const out = decorateWithUrls("query", { hits: [{ documentId: "d1" }] }, links) as {
      hits: { url?: string }[]
    }
    expect(out.hits[0]?.url).toBe(`${B}/documents/d1`)
  })

  test("think: each citation → document url (citations carry documentId)", () => {
    const out = decorateWithUrls(
      "think",
      { citations: [{ slug: "s", chunkId: "c", documentId: "d2" }] },
      links,
    ) as { citations: { url?: string }[] }
    expect(out.citations[0]?.url).toBe(`${B}/documents/d2`)
  })

  test("get_document: flat url", () => {
    const out = decorateWithUrls("get_document", { id: "d3" }, links) as { url?: string }
    expect(out.url).toBe(`${B}/documents/d3`)
  })

  test("list_documents: each doc → document url", () => {
    const out = decorateWithUrls("list_documents", { documents: [{ id: "d4" }] }, links) as {
      documents: { url?: string }[]
    }
    expect(out.documents[0]?.url).toBe(`${B}/documents/d4`)
  })

  test("wiki_get_page: page → wiki url (slug is nested at page.page.slug)", () => {
    const out = decorateWithUrls(
      "wiki_get_page",
      { page: { page: { slug: "guides/x" } } },
      links,
    ) as { page: { url?: string } }
    expect(out.page.url).toBe(`${B}/wiki/guides/x`)
  })

  test("wiki_get_page: null page passes through (no throw, no url)", () => {
    const out = decorateWithUrls("wiki_get_page", { page: null }, links) as { page: null }
    expect(out.page).toBeNull()
  })

  test("wiki_list_pages: each entry → wiki url", () => {
    const out = decorateWithUrls("wiki_list_pages", { pages: [{ slug: "a/b" }] }, links) as {
      pages: { url?: string }[]
    }
    expect(out.pages[0]?.url).toBe(`${B}/wiki/a/b`)
  })

  test("memory_get: memory → memory url", () => {
    const out = decorateWithUrls("memory_get", { memory: { slug: "agent/p" } }, links) as {
      memory: { url?: string }
    }
    expect(out.memory.url).toBe(`${B}/memory/agent/p`)
  })

  test("memory_get: null memory passes through", () => {
    const out = decorateWithUrls("memory_get", { memory: null }, links) as { memory: null }
    expect(out.memory).toBeNull()
  })

  test("memory_list: each item → memory url", () => {
    const out = decorateWithUrls("memory_list", { memories: [{ slug: "m" }] }, links) as {
      memories: { url?: string }[]
    }
    expect(out.memories[0]?.url).toBe(`${B}/memory/m`)
  })

  test("search_entities: each hit → entity wiki url (name is canonicalName)", () => {
    const out = decorateWithUrls(
      "search_entities",
      { hits: [{ kind: "person", name: "Ada Lovelace" }] },
      links,
    ) as { hits: { url?: string }[] }
    expect(out.hits[0]?.url).toBe(`${B}/wiki/entities/person/ada-lovelace`)
  })

  test("list_entities: each entity → entity wiki url", () => {
    const out = decorateWithUrls(
      "list_entities",
      { entities: [{ kind: "org", canonicalName: "Acme Corp" }] },
      links,
    ) as { entities: { url?: string }[] }
    expect(out.entities[0]?.url).toBe(`${B}/wiki/entities/org/acme-corp`)
  })

  test("list_sessions: each session → session url", () => {
    const out = decorateWithUrls("list_sessions", { sessions: [{ id: "s1" }] }, links) as {
      sessions: { url?: string }[]
    }
    expect(out.sessions[0]?.url).toBe(`${B}/sessions/s1`)
  })
})

describe("decorateWithUrls — pass-through cases", () => {
  test("no base (local dev) → output byte-identical, no `url` key emitted", () => {
    const out = decorateWithUrls("get_document", { id: "d" }, brainDeepLinks(undefined)) as Record<
      string,
      unknown
    >
    expect("url" in out).toBe(false)
  })

  test("think citations keep documentId but gain no url when base is absent", () => {
    // documentId is added unconditionally by the search handler (needed to build the url); url
    // itself is gated on the base — so with no DASHBOARD_URL a citation has documentId and no url.
    const out = decorateWithUrls(
      "think",
      { citations: [{ slug: "s", chunkId: "c", documentId: "d" }] },
      brainDeepLinks(undefined),
    ) as { citations: Record<string, unknown>[] }
    expect(out.citations[0]?.documentId).toBe("d")
    expect("url" in (out.citations[0] ?? {})).toBe(false)
  })

  test("unknown / non-retrieval op → output returned unchanged", () => {
    const input = { forgotten: true }
    expect(decorateWithUrls("forget_fact", input, links)).toEqual(input)
  })

  test("non-object output → returned as-is", () => {
    expect(decorateWithUrls("get_document", null, links)).toBeNull()
  })
})

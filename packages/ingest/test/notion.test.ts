import { describe, expect, test } from "bun:test"
import { runImporterContract } from "../src/sources/contract"
import {
  createNotionImporter,
  type NotionClient,
  type NotionPageContent,
  type NotionPageRef,
} from "../src/sources/notion"

/**
 * NotionSource importer contract suite. All Notion I/O is a STUB client (the DI seam) — no live
 * HTTP. Proves the resumable-enumeration contract, the slug/fingerprint/path/tag mapping, the
 * `since` passthrough, archived/empty skips, and pagination across listing refills.
 */

interface DocItem {
  sourceSessionId: string
  client: string
  fingerprint: string
  content: string
  path: string
  tags: string[]
}

const para = (text: string) => ({
  type: "paragraph",
  paragraph: { rich_text: [{ plain_text: text }] },
})

/** A stub client backed by an in-memory page map + a paginated listing. */
const stubClient = (
  pages: NotionPageContent[],
  opts: { pageSize?: number; capture?: (since?: string) => void } = {},
): NotionClient => {
  const pageSize = opts.pageSize ?? 1000
  const refs: NotionPageRef[] = pages.map((p) => ({
    id: p.id,
    lastEditedTime: p.lastEditedTime,
    ...(p.archived !== undefined ? { archived: p.archived } : {}),
  }))
  return {
    listChangedPages: async ({ since, cursor }) => {
      opts.capture?.(since)
      const start = cursor ? Number(cursor) : 0
      const slice = refs.slice(start, start + pageSize)
      const next = start + pageSize < refs.length ? String(start + pageSize) : null
      return { pages: slice, nextCursor: next }
    },
    getPageContent: async (pageId) => {
      const page = pages.find((p) => p.id === pageId)
      if (page === undefined) throw new Error(`stub: unknown page ${pageId}`)
      return page
    },
  }
}

describe("createNotionImporter", () => {
  test("maps a page to slug / fingerprint / path / tags and prepends the title", async () => {
    const client = stubClient([
      {
        id: "abc123",
        lastEditedTime: "2026-07-01T10:00:00.000Z",
        parentPath: ["Engineering", "Specs"],
        properties: {
          Name: { type: "title", title: [{ plain_text: "Design Doc" }] },
          Stage: { type: "select", select: { name: "Active" } },
        },
        blocks: [para("Body text.")],
      },
    ])
    const items = (await runImporterContract(createNotionImporter(client))) as unknown as DocItem[]
    expect(items).toHaveLength(1)
    const it = items[0] as DocItem
    expect(it.sourceSessionId).toBe("notion:abc123")
    expect(it.client).toBe("notion")
    expect(it.fingerprint).toBe("notion:abc123:2026-07-01T10:00:00.000Z")
    expect(it.path).toBe("/Engineering/Specs")
    expect(it.tags).toEqual(["Active"])
    expect(it.content).toBe("# Design Doc\n\nBody text.")
  })

  test("root pages (no parent chain) map to path '/'", async () => {
    const client = stubClient([
      { id: "root1", lastEditedTime: "2026-07-01T00:00:00.000Z", blocks: [para("hi")] },
    ])
    const items = (await runImporterContract(createNotionImporter(client))) as unknown as DocItem[]
    expect((items[0] as DocItem).path).toBe("/")
  })

  test("archived and empty pages are skipped", async () => {
    const client = stubClient([
      { id: "live", lastEditedTime: "t1", blocks: [para("real")] },
      { id: "gone", lastEditedTime: "t2", archived: true, blocks: [para("dead")] },
      { id: "blank", lastEditedTime: "t3", blocks: [] },
    ])
    const items = (await runImporterContract(createNotionImporter(client))) as unknown as DocItem[]
    expect(items.map((i) => i.sourceSessionId)).toEqual(["notion:live"])
  })

  test("surfaces archived pages to onArchived (delete marker) instead of emitting them", async () => {
    const client = stubClient([
      { id: "live", lastEditedTime: "t1", blocks: [para("real")] },
      { id: "gone", lastEditedTime: "t2", archived: true, blocks: [para("dead")] },
    ])
    const archived: string[] = []
    const items = (await runImporterContract(
      createNotionImporter(client, { onArchived: async (id) => void archived.push(id) }),
    )) as unknown as DocItem[]
    expect(items.map((i) => i.sourceSessionId)).toEqual(["notion:live"])
    expect(archived).toEqual(["gone"])
  })

  test("passes `since` through to the client (delta poll)", async () => {
    let seen: string | undefined
    const client = stubClient([{ id: "p", lastEditedTime: "t", blocks: [para("x")] }], {
      capture: (since) => (seen = since),
    })
    await runImporterContract(createNotionImporter(client, { since: "2026-06-30T00:00:00.000Z" }))
    expect(seen).toBe("2026-06-30T00:00:00.000Z")
  })

  test("paginates across listing refills without violating the cursor contract", async () => {
    const pages: NotionPageContent[] = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      lastEditedTime: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      blocks: [para(`page ${i}`)],
    }))
    // pageSize 4 (listing refills) × BATCH_SIZE 10 (emit batches) exercises both loops.
    const client = stubClient(pages, { pageSize: 4 })
    const items = (await runImporterContract(createNotionImporter(client))) as unknown as DocItem[]
    expect(items).toHaveLength(25)
    expect(new Set(items.map((i) => i.sourceSessionId)).size).toBe(25)
  })

  test("an empty workspace terminates immediately (begin → null cursor)", async () => {
    const items = await runImporterContract(createNotionImporter(stubClient([])))
    expect(items).toEqual([])
  })
})

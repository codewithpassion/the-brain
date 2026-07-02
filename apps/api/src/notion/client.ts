/**
 * Concrete Notion API client (docs/notion-integration-plan.md §5) — the deploy-time implementation
 * of the `NotionClient` DI seam from `@brain/ingest`. All Notion HTTP lives here; tests inject a
 * stub `NotionClient` instead, so this file is never hit in the canary (invariant: no live HTTP in
 * tests). A small internal throttle spaces requests to Notion's ~3 req/s limit (a big page fans
 * out into many block-children requests).
 *
 * `exchangeNotionCode` performs the OAuth code→token exchange for the public `/notion/callback`.
 */
import { NOTION_TOKEN_URL } from "@brain/db"
import type { NotionBlock, NotionClient, NotionPageContent, NotionPageRef } from "@brain/ingest"

const NOTION_API = "https://api.notion.com/v1"
const NOTION_VERSION = "2022-06-28"
const MIN_INTERVAL_MS = 350 // ~3 req/s
const BLOCK_PAGE_SIZE = 100
const SEARCH_PAGE_SIZE = 50

type FetchImpl = typeof fetch

interface NotionApiClientDeps {
  token: string
  fetchImpl?: FetchImpl
  /** Minimum spacing between Notion requests (ms); defaults to ~3 req/s. */
  minIntervalMs?: number
}

/** A tiny serialized throttle: each acquire resolves no sooner than `interval` after the last. */
const makeThrottle = (intervalMs: number) => {
  let chain: Promise<void> = Promise.resolve()
  let last = 0
  return (): Promise<void> => {
    chain = chain.then(async () => {
      const now = Date.now()
      const wait = Math.max(0, last + intervalMs - now)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      last = Date.now()
    })
    return chain
  }
}

export const createNotionApiClient = (deps: NotionApiClientDeps): NotionClient => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const throttle = makeThrottle(deps.minIntervalMs ?? MIN_INTERVAL_MS)

  const call = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    await throttle()
    const res = await fetchImpl(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${deps.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      throw new Error(`notion: ${init?.method ?? "GET"} ${path} → ${res.status}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  /** Recursively fetch a block's children, attaching nested children in place. */
  const fetchChildren = async (blockId: string): Promise<NotionBlock[]> => {
    const out: NotionBlock[] = []
    let cursor: string | undefined
    do {
      const qs = new URLSearchParams({ page_size: String(BLOCK_PAGE_SIZE) })
      if (cursor) qs.set("start_cursor", cursor)
      const page = await call(`/blocks/${blockId}/children?${qs.toString()}`)
      const results = Array.isArray(page.results) ? (page.results as NotionBlock[]) : []
      for (const block of results) {
        if (block.has_children === true && typeof block.id === "string") {
          block.children = await fetchChildren(block.id)
        }
        out.push(block)
      }
      cursor =
        page.has_more === true && typeof page.next_cursor === "string"
          ? page.next_cursor
          : undefined
    } while (cursor !== undefined)
    return out
  }

  return {
    listChangedPages: async ({ since, cursor }) => {
      const body: Record<string, unknown> = {
        filter: { value: "page", property: "object" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: SEARCH_PAGE_SIZE,
      }
      if (cursor) body.start_cursor = cursor
      const res = await call("/search", { method: "POST", body: JSON.stringify(body) })
      const results = Array.isArray(res.results) ? (res.results as Record<string, unknown>[]) : []

      const pages: NotionPageRef[] = []
      let crossedBoundary = false
      for (const page of results) {
        const id = typeof page.id === "string" ? page.id : undefined
        const lastEditedTime =
          typeof page.last_edited_time === "string" ? page.last_edited_time : undefined
        if (id === undefined || lastEditedTime === undefined) continue
        // Sorted desc by last_edited_time: once we pass `since`, everything after is older too.
        if (since !== undefined && lastEditedTime < since) {
          crossedBoundary = true
          continue
        }
        const archived = page.archived === true || page.in_trash === true
        pages.push({ id, lastEditedTime, archived })
      }

      const hasMore = res.has_more === true && typeof res.next_cursor === "string"
      // Stop paging once we've crossed the `since` boundary (all remaining pages are older).
      const nextCursor = hasMore && !crossedBoundary ? (res.next_cursor as string) : null
      return { pages, nextCursor }
    },

    getPageContent: async (pageId): Promise<NotionPageContent> => {
      const page = await call(`/pages/${pageId}`)
      const blocks = await fetchChildren(pageId)
      return {
        id: pageId,
        lastEditedTime:
          typeof page.last_edited_time === "string"
            ? page.last_edited_time
            : new Date().toISOString(),
        archived: page.archived === true || page.in_trash === true,
        properties:
          typeof page.properties === "object" && page.properties !== null
            ? (page.properties as Record<string, unknown>)
            : {},
        // ACKED DEVIATION: deep parent-chain → path AND the database-name → tag/path mapping are
        // deferred. Both require an extra `databases.retrieve` / parent-walk call per page (the page
        // object only carries the parent database_id, not its title), so they're polish, not v1.
        // Property tags (select / multi_select / status) already flow via `extractPageTags`.
        parentPath: [],
        blocks,
      }
    },
  }
}

// ── OAuth code → token exchange (for /notion/callback) ───────────────────────────────────────────

export interface NotionTokenGrant {
  accessToken: string
  refreshToken: string | null
  workspaceId: string
  workspaceName: string | null
  botId: string | null
}

/**
 * Exchange an OAuth `code` for a bot token grant (Basic `client_id:client_secret`). Throws on a
 * non-2xx or a malformed response so the callback can fail closed.
 */
export const exchangeNotionCode = async (params: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  fetchImpl?: FetchImpl
}): Promise<NotionTokenGrant> => {
  const fetchImpl = params.fetchImpl ?? fetch
  const basic = btoa(`${params.clientId}:${params.clientSecret}`)
  const res = await fetchImpl(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  })
  if (!res.ok) throw new Error(`notion: token exchange → ${res.status}`)
  const json = (await res.json()) as Record<string, unknown>
  const accessToken = typeof json.access_token === "string" ? json.access_token : undefined
  const workspaceId = typeof json.workspace_id === "string" ? json.workspace_id : undefined
  if (accessToken === undefined || workspaceId === undefined) {
    throw new Error("notion: token exchange returned no access_token/workspace_id")
  }
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    workspaceId,
    workspaceName: typeof json.workspace_name === "string" ? json.workspace_name : null,
    botId: typeof json.bot_id === "string" ? json.bot_id : null,
  }
}

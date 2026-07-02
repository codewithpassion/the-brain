import { describe, expect, test } from "vitest"
import { createNotionApiClient, exchangeNotionCode } from "../src/notion/client"

/**
 * Concrete Notion HTTP client unit gate — request shaping + response mapping against a FAKE fetch
 * (no live HTTP, throttle disabled). The end-to-end poll path is covered by the poll canary's stub
 * client; this locks the wire details (auth headers, search body, block recursion, token exchange).
 */

type FetchArgs = { url: string; init: RequestInit | undefined }

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

describe("createNotionApiClient", () => {
  test("listChangedPages POSTs /search with auth + version headers and maps results", async () => {
    const calls: FetchArgs[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse({
        results: [
          { id: "p1", last_edited_time: "2026-07-01T00:00:00.000Z" },
          { id: "p2", last_edited_time: "2026-07-01T01:00:00.000Z", in_trash: true },
        ],
        has_more: false,
        next_cursor: null,
      })
    }) as unknown as typeof fetch

    const client = createNotionApiClient({ token: "tok", fetchImpl: fake, minIntervalMs: 0 })
    const res = await client.listChangedPages({})

    expect(calls[0]?.url).toBe("https://api.notion.com/v1/search")
    expect(calls[0]?.init?.method).toBe("POST")
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["Notion-Version"]).toBe("2022-06-28")
    expect(res.pages).toEqual([
      { id: "p1", lastEditedTime: "2026-07-01T00:00:00.000Z", archived: false },
      { id: "p2", lastEditedTime: "2026-07-01T01:00:00.000Z", archived: true },
    ])
    expect(res.nextCursor).toBeNull()
  })

  test("getPageContent fetches the page + recursively fetches block children", async () => {
    const fake = (async (url: string) => {
      if (url === "https://api.notion.com/v1/pages/pg") {
        return jsonResponse({ last_edited_time: "2026-07-01T00:00:00.000Z", properties: {} })
      }
      if (url.startsWith("https://api.notion.com/v1/blocks/pg/children")) {
        return jsonResponse({
          results: [{ id: "b1", type: "toggle", has_children: true, toggle: {} }],
          has_more: false,
          next_cursor: null,
        })
      }
      if (url.startsWith("https://api.notion.com/v1/blocks/b1/children")) {
        return jsonResponse({
          results: [{ id: "b2", type: "paragraph", paragraph: {} }],
          has_more: false,
          next_cursor: null,
        })
      }
      throw new Error(`unexpected url ${url}`)
    }) as unknown as typeof fetch

    const client = createNotionApiClient({ token: "tok", fetchImpl: fake, minIntervalMs: 0 })
    const page = await client.getPageContent("pg")
    expect(page.blocks).toHaveLength(1)
    expect(page.blocks[0]?.children).toHaveLength(1)
    expect(page.blocks[0]?.children?.[0]?.id).toBe("b2")
  })
})

describe("exchangeNotionCode", () => {
  test("sends Basic auth + maps the token grant", async () => {
    const calls: FetchArgs[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse({
        access_token: "ntn_secret",
        refresh_token: "ntn_refresh",
        workspace_id: "ws1",
        workspace_name: "My WS",
        bot_id: "bot1",
      })
    }) as unknown as typeof fetch

    const grant = await exchangeNotionCode({
      clientId: "cid",
      clientSecret: "csecret",
      code: "the-code",
      redirectUri: "https://x.dev/notion/callback",
      fetchImpl: fake,
    })

    expect(calls[0]?.url).toBe("https://api.notion.com/v1/oauth/token")
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${btoa("cid:csecret")}`)
    expect(grant).toEqual({
      accessToken: "ntn_secret",
      refreshToken: "ntn_refresh",
      workspaceId: "ws1",
      workspaceName: "My WS",
      botId: "bot1",
    })
  })

  test("throws when the grant is missing access_token/workspace_id", async () => {
    const fake = (async () => jsonResponse({ token_type: "bearer" })) as unknown as typeof fetch
    await expect(
      exchangeNotionCode({
        clientId: "c",
        clientSecret: "s",
        code: "x",
        redirectUri: "https://x.dev/cb",
        fetchImpl: fake,
      }),
    ).rejects.toThrow()
  })
})

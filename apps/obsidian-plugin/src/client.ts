/**
 * BrainClient — typed HTTP client for the Brain API.
 *
 * Transport decisions:
 *   - `think`, `search`, `get_backlinks`: direct REST endpoints (POST /think, POST /search,
 *     POST /graph/backlinks). These exist as first-class Hono routes and accept/return the same
 *     JSON as the tRPC procedure input/output schemas, directly unwrapped.
 *   - `memory_set`: tRPC mutation (no direct REST route). Wire format per tRPC v11 httpBatchLink
 *     without transformer: POST /trpc/memory_set?batch=1, body {"0":<input>},
 *     response [{result:{data:<output>}}].
 *   - `okf_export`: tRPC query (no direct REST route). Wire format: GET /trpc/okf_export?batch=1
 *     &input=URIEncoded(JSON({"0":<input>})), same batch response envelope.
 *
 * Auth: `Authorization: Bearer bk_<key>` only. bk_ keys are tenant-bound in the DB; no
 * X-Brain-Tenant header is needed (and none is sent — the server resolves tenant from the key).
 *
 * Mobile rule: all network calls use `requestUrl` from the `obsidian` package (not `fetch`),
 * which routes through Obsidian's own networking layer and avoids CORS restrictions.
 */
import { requestUrl } from "obsidian"

// ── Input / output types ────────────────────────────────────────────────────

export interface SearchHit {
  id: string
  documentId: string
  slug: string
  score: number
  snippet: string
}

export interface ThinkInput {
  query: string
  topK?: number
  scope?: string
  path?: string
  tag?: string
}

export interface ThinkOutput {
  answer: string
  evidence: SearchHit[]
  citations: Array<{ slug: string; chunkId: string }>
  gaps: string[]
  warnings: string[]
}

export interface SearchInput {
  query: string
  topK?: number
  scope?: string
  path?: string
  tag?: string
}

export interface SearchOutput {
  hits: SearchHit[]
}

export interface BacklinksInput {
  target: string
}

export interface BacklinksLink {
  fromId: string
  toId: string
  linkType: string
  context: string
}

export interface BacklinksOutput {
  links: BacklinksLink[]
}

export interface MemorySetInput {
  slug: string
  type: string
  body: string
  title?: string
  description?: string
  resource?: string
  tags?: string[]
  visibility?: "private" | "team" | "world"
  scope?: string
  teamId?: string
}

export interface MemorySetOutput {
  slug: string
  pageId: string
  version: number
  changed: boolean
}

export interface OkfExportInput {
  path?: string
  prefix?: boolean
}

export interface OkfExportFile {
  path: string
  content: string
}

export interface OkfExportOutput {
  okfVersion: string
  count: number
  files: OkfExportFile[]
}

// ── tRPC v11 batch envelope (no transformer → plain JSON, no {json:…} wrapping) ──

type TrpcBatch<T> = [{ result: { data: T } }]

// ── BrainClient ──────────────────────────────────────────────────────────────

export class BrainClient {
  private readonly baseUrl: string
  private readonly authHeader: string

  constructor(baseUrl: string, apiKey: string) {
    // Normalise: strip trailing slash so paths concatenate cleanly.
    this.baseUrl = baseUrl.replace(/\/$/, "")
    this.authHeader = `Bearer ${apiKey}`
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
    }
  }

  // ── REST endpoints ──────────────────────────────────────────────────────────

  /** POST /think — hybrid search + cited synthesis. */
  async think(input: ThinkInput): Promise<ThinkOutput> {
    return this.postRest<ThinkOutput>("/think", input)
  }

  /** POST /search — cheap hybrid search. */
  async search(input: SearchInput): Promise<SearchOutput> {
    return this.postRest<SearchOutput>("/search", input)
  }

  /** POST /graph/backlinks — pages that link to the given slug. */
  async getBacklinks(input: BacklinksInput): Promise<BacklinksOutput> {
    return this.postRest<BacklinksOutput>("/graph/backlinks", input)
  }

  // ── tRPC endpoints (no direct REST route) ───────────────────────────────────

  /**
   * tRPC mutation: POST /trpc/memory_set?batch=1
   * Request body: {"0": <MemorySetInput>}
   * Response: [{result:{data:<MemorySetOutput>}}]
   */
  async memorySet(input: MemorySetInput): Promise<MemorySetOutput> {
    return this.trpcMutation<MemorySetInput, MemorySetOutput>("memory_set", input)
  }

  /**
   * tRPC query: GET /trpc/okf_export?batch=1&input=URIEncoded({"0":<OkfExportInput>})
   * Response: [{result:{data:<OkfExportOutput>}}]
   */
  async okfExport(input: OkfExportInput = {}): Promise<OkfExportOutput> {
    return this.trpcQuery<OkfExportInput, OkfExportOutput>("okf_export", input)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async postRest<T>(path: string, body: unknown): Promise<T> {
    const resp = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      throw: false,
    })
    if (resp.status >= 400) {
      throw new Error(`Brain API ${path} (${resp.status.toString()}): ${resp.text}`)
    }
    return resp.json as T
  }

  private async trpcMutation<I, O>(procedure: string, input: I): Promise<O> {
    const resp = await requestUrl({
      url: `${this.baseUrl}/trpc/${procedure}?batch=1`,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ "0": input }),
      throw: false,
    })
    if (resp.status >= 400) {
      throw new Error(`Brain tRPC ${procedure} (${resp.status.toString()}): ${resp.text}`)
    }
    const batch = resp.json as TrpcBatch<O>
    return batch[0].result.data
  }

  private async trpcQuery<I, O>(procedure: string, input: I): Promise<O> {
    const encodedInput = encodeURIComponent(JSON.stringify({ "0": input }))
    const resp = await requestUrl({
      url: `${this.baseUrl}/trpc/${procedure}?batch=1&input=${encodedInput}`,
      method: "GET",
      // GET: no Content-Type (no body).
      headers: { Authorization: this.authHeader },
      throw: false,
    })
    if (resp.status >= 400) {
      throw new Error(`Brain tRPC ${procedure} (${resp.status.toString()}): ${resp.text}`)
    }
    const batch = resp.json as TrpcBatch<O>
    return batch[0].result.data
  }
}

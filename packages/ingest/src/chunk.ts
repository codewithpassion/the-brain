import { MAX_BODY_BYTES, MAX_CHUNKS_PER_DOC } from "@brain/shared"

/**
 * Heading-aware chunking, strategy-routed by source type (PRD §4.4).
 *
 * Two ported chunkers, both deterministic:
 *
 *   - `paragraph` (default for `text/markdown` / `text/plain` / sessions): greedy
 *     paragraph-packing toward `CHUNK_TARGET` (~1200 chars), never splitting a
 *     paragraph unless it exceeds `2× target`, NO overlap (gbrain `chunkText`).
 *     Markdown ATX headings are tracked into a `heading_path` breadcrumb.
 *
 *   - `sliding` (default for `application/pdf` / `…docx` / long `text/html`):
 *     sliding window `maxTokens=512` / `overlap=64`, sentence-aware (breaks at
 *     `". "` past the halfway mark) for `toMarkdown` prose output (cf-graph
 *     `chunkText`).
 *
 * `token_count` is the §4.3 estimate `ceil(content.length / 4)`.
 *
 * `chunk_index` is GLOBAL and sequential (`0..n-1`) over the whole document; the
 * Batch-Ingest Workflow (Phase 2c) materializes the deterministic `nanoid` chunk
 * ids and may re-index per document part (see `planParts`).
 *
 * DRIFT NOTE (heading_path): §4.4's cited gbrain `chunkText` is *pure*
 * paragraph-packing — "heading-aware" there means CARRYING the breadcrumb, not
 * breaking on headings. We follow that lower-drift reading: packing crosses
 * heading boundaries, and a chunk's `heading_path` is the heading context active
 * at its FIRST paragraph. `sliding` operates on prose without markdown structure,
 * so it derives no breadcrumb (`heading_path = null`), matching §4.4's "where the
 * chunker can derive it (markdown headings)."
 */

/** Strategy selected for a document (PRD §4.4). */
export type ChunkStrategy = "paragraph" | "sliding"

/** One produced chunk — the lean, deterministic shape the workflow stamps onto a `chunks` row. */
export interface Chunk {
  /** Global sequential index over the document, `0..n-1`. */
  chunkIndex: number
  content: string
  /** Markdown heading breadcrumb (`"A > B > C"`), or `null` when none can be derived. */
  headingPath: string | null
  /** Token estimate, `ceil(content.length / 4)` (§4.3). */
  tokenCount: number
}

export interface ChunkOptions {
  /** Explicit strategy; when omitted it is derived from `contentType`. */
  strategy?: ChunkStrategy
  /** Used to derive the default strategy when `strategy` is omitted. */
  contentType?: string
  /** Paragraph-packing target in chars (default `CHUNK_TARGET`). */
  targetChars?: number
  /** Sliding window size in tokens (default `SLIDING_MAX_TOKENS`). */
  maxTokens?: number
  /** Sliding overlap in tokens (default `SLIDING_OVERLAP`). */
  overlap?: number
}

// ── Chunker constants (PRD §4.4 — gbrain TARGET≈1200, cf-graph 512/64) ────────
/** Greedy paragraph-packing target (chars). */
export const CHUNK_TARGET = 1200
/** Sliding window size (tokens). */
export const SLIDING_MAX_TOKENS = 512
/** Sliding window overlap (tokens). */
export const SLIDING_OVERLAP = 64
/** Token estimate divisor (§4.3 `ceil(len/4)`). */
const CHARS_PER_TOKEN = 4

const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN)

/** Content types whose `toMarkdown` output is long prose and routes to `sliding`. */
const SLIDING_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/html",
])

const baseContentType = (contentType: string): string =>
  (contentType.split(";")[0] ?? "").trim().toLowerCase()

const defaultStrategy = (contentType: string | undefined): ChunkStrategy =>
  contentType !== undefined && SLIDING_TYPES.has(baseContentType(contentType))
    ? "sliding"
    : "paragraph"

interface RawPiece {
  content: string
  headingPath: string | null
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*$/

/**
 * Split an oversized paragraph (> `limit`) into pieces ≤ `limit`, preferring the
 * last whitespace boundary in each window and hard-splitting on a char boundary
 * when there is none (long URLs / base64), so progress is always made.
 */
const splitOversized = (block: string, limit: number): string[] => {
  const out: string[] = []
  let rest = block
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    // Index of the LAST whitespace in the window (a ws followed only by non-ws to its end).
    const ws = window.search(/\s(?=\S*$)/)
    const cut = ws > limit / 2 ? ws : limit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) out.push(rest)
  return out.filter((p) => p.length > 0)
}

/**
 * Parse markdown into paragraph pieces, each tagged with the heading breadcrumb
 * active at its start. Headings update a level-stack; an oversized paragraph is
 * pre-split (so packing never emits a chunk far over target).
 */
const toParagraphPieces = (markdown: string, hardLimit: number): RawPiece[] => {
  const blocks = markdown.split(/\n[ \t]*\n/)
  const stack: { level: number; text: string }[] = []
  const pieces: RawPiece[] = []
  for (const raw of blocks) {
    const block = raw.trim()
    if (block.length === 0) continue
    const firstLine = block.split("\n")[0] ?? ""
    const heading = ATX_HEADING.exec(firstLine)
    if (heading !== null) {
      const level = (heading[1] ?? "").length
      const title = heading[2] ?? ""
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop()
      stack.push({ level, text: title })
    }
    const headingPath = stack.length > 0 ? stack.map((s) => s.text).join(" > ") : null
    if (block.length > hardLimit) {
      for (const piece of splitOversized(block, hardLimit))
        pieces.push({ content: piece, headingPath })
    } else {
      pieces.push({ content: block, headingPath })
    }
  }
  return pieces
}

/** Greedy paragraph-packing toward `target` chars, no overlap (gbrain `chunkText`). */
const paragraphChunks = (markdown: string, target: number): RawPiece[] => {
  const pieces = toParagraphPieces(markdown, target * 2)
  const out: RawPiece[] = []
  let buf = ""
  let bufHeading: string | null = null
  for (const piece of pieces) {
    if (buf.length === 0) {
      buf = piece.content
      bufHeading = piece.headingPath
    } else if (buf.length + 2 + piece.content.length <= target) {
      buf = `${buf}\n\n${piece.content}`
    } else {
      out.push({ content: buf, headingPath: bufHeading })
      buf = piece.content
      bufHeading = piece.headingPath
    }
  }
  if (buf.length > 0) out.push({ content: buf, headingPath: bufHeading })
  return out
}

/** Sentence-aware sliding window (cf-graph `chunkText`). Token sizes are char-estimated (×4). */
const slidingChunks = (text: string, maxTokens: number, overlap: number): RawPiece[] => {
  const windowChars = maxTokens * CHARS_PER_TOKEN
  const overlapChars = overlap * CHARS_PER_TOKEN
  const len = text.length
  if (len <= windowChars) {
    const only = text.trim()
    return only.length > 0 ? [{ content: only, headingPath: null }] : []
  }
  const out: RawPiece[] = []
  let pos = 0
  while (pos < len) {
    let end = Math.min(pos + windowChars, len)
    if (end < len) {
      const half = pos + Math.floor(windowChars / 2)
      const boundary = text.slice(half, end).lastIndexOf(". ")
      if (boundary >= 0) end = half + boundary + 1
    }
    const content = text.slice(pos, end).trim()
    if (content.length > 0) out.push({ content, headingPath: null })
    if (end >= len) break
    const nextPos = end - overlapChars
    pos = nextPos > pos ? nextPos : end
  }
  return out
}

/**
 * Chunk a markdown document deterministically. Returns the full, ordered chunk
 * list (`chunk_index` 0..n-1) and NEVER truncates — the `MAX_CHUNKS_PER_DOC` /
 * `MAX_BODY_BYTES` ceilings are enforced by splitting into document parts via
 * `planParts` (the §4.3 split-on-chunk-boundary rule). Empty / whitespace-only
 * input yields `[]` (the workflow's empty-extraction → `failed` branch, §4.11).
 */
export const chunkDocument = (markdown: string, opts: ChunkOptions = {}): Chunk[] => {
  if (markdown.trim().length === 0) return []
  const strategy = opts.strategy ?? defaultStrategy(opts.contentType)
  const pieces =
    strategy === "sliding"
      ? slidingChunks(
          markdown,
          opts.maxTokens ?? SLIDING_MAX_TOKENS,
          opts.overlap ?? SLIDING_OVERLAP,
        )
      : paragraphChunks(markdown, opts.targetChars ?? CHUNK_TARGET)
  return pieces.map((piece, index) => ({
    chunkIndex: index,
    content: piece.content,
    headingPath: piece.headingPath,
    tokenCount: estimateTokens(piece.content),
  }))
}

/** A contiguous run of chunks that becomes one `documents` row (un-split docs → one part). */
export interface ChunkPart {
  /** 0-based part index (citations resolve to `(parent_document_id, part_index)`, §4.3). */
  partIndex: number
  /** Inclusive start index into the `chunkDocument` output. */
  chunkStart: number
  /** Exclusive end index into the `chunkDocument` output. */
  chunkEnd: number
  /** Number of chunks in this part (`chunkEnd - chunkStart`). */
  chunkCount: number
  /** UTF-8 byte length of the concatenated chunk content in this part. */
  byteLength: number
}

export interface PlanPartsOptions {
  /** Max chunks per part (default `MAX_CHUNKS_PER_DOC`). */
  maxChunks?: number
  /** Max UTF-8 body bytes per part (default `MAX_BODY_BYTES`). */
  maxBytes?: number
}

/**
 * Plan the deterministic split of a document's chunks into parts that each
 * respect BOTH ceilings (§4.3): `MAX_CHUNKS_PER_DOC` and `MAX_BODY_BYTES`. Splits
 * only on chunk boundaries (never mid-chunk). A document under both ceilings
 * returns a single part. A single chunk whose own content exceeds `maxBytes`
 * cannot be split further, so it occupies its own part. The workflow materializes
 * each part as a `documents` row sharing `parent_document_id` + `part_index`.
 */
export const planParts = (chunks: Chunk[], opts: PlanPartsOptions = {}): ChunkPart[] => {
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS_PER_DOC
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES
  const encoder = new TextEncoder()
  const parts: ChunkPart[] = []
  let start = 0
  let count = 0
  let bytes = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (chunk === undefined) continue
    const chunkBytes = encoder.encode(chunk.content).length
    if (count > 0 && (count + 1 > maxChunks || bytes + chunkBytes > maxBytes)) {
      parts.push({
        partIndex: parts.length,
        chunkStart: start,
        chunkEnd: i,
        chunkCount: count,
        byteLength: bytes,
      })
      start = i
      count = 0
      bytes = 0
    }
    count++
    bytes += chunkBytes
  }
  if (count > 0) {
    parts.push({
      partIndex: parts.length,
      chunkStart: start,
      chunkEnd: chunks.length,
      chunkCount: count,
      byteLength: bytes,
    })
  }
  return parts
}

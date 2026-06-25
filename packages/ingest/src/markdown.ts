import { MARKDOWN_PREVIEW_MAX } from "@brain/shared"
import { normalize } from "./normalize"

/**
 * Extraction to markdown + the D1 preview (PRD §4.0 / §4.3 / §4.9).
 *
 * v1 pure scope handles the two passthrough text types — `text/markdown` and
 * `text/plain` — which §4.3 reads directly via `obj.text()` (no extraction). For
 * those, extraction is just `normalize` (line endings / BOM / edge whitespace).
 *
 * Binary + HTML (`application/pdf`, `…docx`, `text/html`, …) are DELIBERATELY
 * not handled here: §4.0 chose Cloudflare's `ai.toMarkdown` (a Workers runtime
 * binding) and explicitly REJECTED client-side parsers. A local HTML/PDF parser
 * in this pure layer would be drift. Those types are extracted in the
 * Batch-Ingest Workflow's `extract-text` step (Phase 2c); here we surface a
 * typed `UnsupportedContentTypeError` so that path can branch on it.
 */

/** Thrown by `toMarkdown` for content types that require the CF document converter. */
export class UnsupportedContentTypeError extends Error {
  override readonly name = "UnsupportedContentTypeError"
  readonly contentType: string
  constructor(contentType: string) {
    super(
      `Content type "${contentType}" is not handled by the pure ingest layer; binary/HTML extraction runs in the Batch-Ingest Workflow via ai.toMarkdown (§4.0).`,
    )
    this.contentType = contentType
  }
}

/** Strip any `; charset=…` parameters and normalize a content-type to its lowercase base. */
const baseContentType = (contentType: string): string =>
  (contentType.split(";")[0] ?? "").trim().toLowerCase()

/** Content types extracted by direct passthrough + `normalize` (no converter needed). */
const PASSTHROUGH_TYPES = new Set(["text/markdown", "text/plain"])

/**
 * Extract markdown from a text body. Passthrough + `normalize` for
 * `text/markdown` / `text/plain`; throws `UnsupportedContentTypeError` for any
 * type that requires the CF converter (handled in the workflow).
 */
export const toMarkdown = (input: string, contentType: string): string => {
  if (PASSTHROUGH_TYPES.has(baseContentType(contentType))) return normalize(input)
  throw new UnsupportedContentTypeError(contentType)
}

/**
 * The D1 `documents.markdown_preview`: the first ≤ `MARKDOWN_PREVIEW_MAX` (2000)
 * characters of the extracted markdown (invariant 13 — the full body stays in
 * R2; D1 holds only the preview). §4.3: `markdown.slice(0, 2000)`.
 */
export const markdownPreview = (markdown: string): string => markdown.slice(0, MARKDOWN_PREVIEW_MAX)

/**
 * Wiki image media (G1) — the PURE, binding-free half: content-type whitelist, extension/type
 * inference, base64 decode + size validation, and the stable id/key/markdown shaping. The R2 write
 * itself lives in the `wiki_upload_image` surface invoker (which owns `ScopedR2`); this module is
 * unit-testable in isolation and shared by the op invoker + the API GET route (id validation).
 *
 * Storage decisions (docs/gap-analysis-2026-08-18.md §"Image pipeline design"): bytes live at
 * `wiki/media/<uuid>.<ext>` under `ScopedR2`, contentType in httpMetadata, `MAX_BODY_BYTES` cap, and
 * NO D1 media table. Stored markdown carries a stable root-relative `/wiki-media/<id>` (never an
 * API-origin or expiring URL).
 */
import { MAX_BODY_BYTES } from "@brain/shared"

/** Allowed wiki-image content types → the canonical stored file extension. */
const IMAGE_TYPE_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** Filename extension (lowercased, no dot) → canonical content type, for inference when absent. */
const EXT_TO_IMAGE_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** The four accepted image content types (for the op's Zod enum + docs). */
export const WIKI_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const

export interface WikiImageInput {
  filename: string
  /** Base64-encoded bytes (a `data:` URI prefix is tolerated and stripped). */
  data: string
  alt?: string
  contentType?: string
}

export interface PreparedWikiImage {
  /** `<uuid>.<ext>` — the value embedded in the `/wiki-media/<id>` URL. */
  id: string
  /** Tenant-RELATIVE R2 key: `wiki/media/<id>` (ScopedR2 prefixes the tenant). */
  key: string
  contentType: string
  bytes: Uint8Array
  /** `![alt||filename](/wiki-media/<id>)` — the snippet to embed in a page body. */
  markdown: string
}

/** A validation failure carrying the HTTP-ish status the caller maps (415 unsupported / 413 too big). */
export class WikiImageError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "WikiImageError"
  }
}

const extOf = (filename: string): string | null => {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename.trim())
  return m ? (m[1] as string).toLowerCase() : null
}

/** Decode base64 → bytes (workerd `atob`). Tolerates a leading `data:...;base64,` prefix. */
const decodeBase64 = (data: string): Uint8Array => {
  const b64 =
    data.startsWith("data:") && data.includes(",") ? data.slice(data.indexOf(",") + 1) : data
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Validate + shape one wiki image upload. Resolves the content type (explicit whitelisted type wins,
 * else inferred from the filename extension), decodes the base64 body, enforces the `MAX_BODY_BYTES`
 * cap on the DECODED size, then mints a stable `<uuid>.<ext>` id + its R2 key + the markdown snippet.
 * Throws `WikiImageError` (415 / 413 / 422) on any rejection; performs NO I/O.
 */
export const prepareWikiImage = (input: WikiImageInput): PreparedWikiImage => {
  let contentType = input.contentType?.trim().toLowerCase()
  if (contentType !== undefined && contentType.length > 0) {
    if (!(contentType in IMAGE_TYPE_TO_EXT)) {
      throw new WikiImageError(415, `unsupported image content type "${input.contentType}"`)
    }
  } else {
    const ext = extOf(input.filename)
    const inferred = ext !== null ? EXT_TO_IMAGE_TYPE[ext] : undefined
    if (inferred === undefined) {
      throw new WikiImageError(
        415,
        `cannot infer image type from filename "${input.filename}" — provide contentType (png|jpeg|gif|webp)`,
      )
    }
    contentType = inferred
  }
  const ext = IMAGE_TYPE_TO_EXT[contentType] as string

  const bytes = decodeBase64(input.data)
  if (bytes.byteLength === 0) throw new WikiImageError(422, "empty image body")
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new WikiImageError(
      413,
      `image is ${bytes.byteLength} bytes — exceeds the ${MAX_BODY_BYTES}-byte cap`,
    )
  }

  const id = `${crypto.randomUUID()}.${ext}`
  const key = `wiki/media/${id}`
  const altText = (input.alt ?? "").trim() || input.filename.trim()
  const markdown = `![${altText}](/wiki-media/${id})`
  return { id, key, contentType, bytes, markdown }
}

/**
 * Guard for the API GET route: accept only a minted `<uuid>.<ext>` id (no slashes, no `..`), so a
 * traversal or a foreign key shape can never reach R2. The extension set matches what upload mints.
 */
export const isValidWikiMediaId = (id: string): boolean =>
  /^[A-Za-z0-9-]+\.(png|jpe?g|gif|webp)$/.test(id)

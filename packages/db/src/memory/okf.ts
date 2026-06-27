/**
 * OKF (Open Knowledge Format v0.1) bundle import/export for agent memory
 * (docs/okf-memory-plan.md §7). A serialization layer that COMPOSES the public `MemoryStore`
 * API — it never touches D1 directly.
 *
 * A bundle is a list of `{ path, content }` files. Each concept is one markdown file whose
 * identity is its path minus `.md` (the `slug`), with YAML frontmatter (`type` required) +
 * a markdown body. `index.md` (bundle root, carries `okf_version`) and `log.md` (change
 * history) are reserved structural files, NEVER concepts.
 *
 * Frontmatter codec: each key is emitted as `key: <json-value>`. JSON is a strict subset of
 * YAML, so the output is valid, readable YAML any OKF tool parses, and it round-trips
 * losslessly through `parseDocument`. The parser also tolerates bare scalars and unquoted
 * flow arrays (`tags: [a, b]`) from externally-authored bundles.
 */
import type { MemoryStore } from "./store"

export const OKF_VERSION = "0.1"

/** One file in an OKF bundle. */
export interface OkfFile {
  path: string
  content: string
}

export interface OkfExportResult {
  okfVersion: string
  count: number
  files: OkfFile[]
}

/** The outcome of a single file in an import. */
export interface OkfImportItem {
  path: string
  status: "imported" | "skipped" | "failed"
  /** Why it was skipped/failed: 'reserved' | 'not-markdown' | 'empty' | 'no-type' | an error message. */
  reason?: string
  /** The concept slug, when imported. */
  slug?: string
}

export interface OkfImportResult {
  imported: number
  skipped: number
  failed: number
  /** `okf_version` declared in the bundle's `index.md`, when present. */
  okfVersion: string | null
  items: OkfImportItem[]
}

/** A parsed concept document. */
export interface ParsedDocument {
  frontmatter: Record<string, unknown>
  body: string
}

// Closing fence consumes the `---` line AND an optional single blank separator line, so the
// readable `---\n…\n---\n\nbody` we emit round-trips to exactly `body` (and a no-blank-line
// externally-authored bundle parses too).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n(?:\r?\n)?/

const stripQuotes = (s: string): string => {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** Parse a YAML-ish scalar: JSON first (lossless for our own output), then bare-string fallbacks. */
const parseScalar = (raw: string): unknown => {
  const t = raw.trim()
  if (t.length === 0) return ""
  try {
    return JSON.parse(t)
  } catch {
    // unquoted flow array, e.g. `[sales, revenue]`
    if (t.startsWith("[") && t.endsWith("]")) {
      return t
        .slice(1, -1)
        .split(",")
        .map((part) => stripQuotes(part.trim()))
        .filter((part) => part.length > 0)
    }
    return stripQuotes(t)
  }
}

const BLOCK_ITEM_RE = /^\s*-\s+(.*)$/

/**
 * Split a concept file into `{ frontmatter, body }`. No leading frontmatter ⇒ empty frontmatter.
 *
 * Handles the flat OKF frontmatter shape from any tool: `key: scalar`, inline flow arrays
 * (`tags: [a, b]`), AND block sequences —
 *   tags:
 *     - sales
 *     - revenue
 * — which our own export does not emit but externally-authored bundles commonly do. Anything
 * more exotic (nested maps, multiline scalars) degrades to a string rather than crashing.
 */
export const parseDocument = (content: string): ParsedDocument => {
  const m = FRONTMATTER_RE.exec(content)
  if (m === null) return { frontmatter: {}, body: content }
  const body = content.slice(m[0].length)
  const frontmatter: Record<string, unknown> = {}
  const lines = (m[1] ?? "").split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    i++
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (key.length === 0) continue
    const rest = line.slice(idx + 1).trim()
    if (rest.length > 0) {
      frontmatter[key] = parseScalar(rest)
      continue
    }
    // Empty value: collect any following `  - item` lines as a block sequence.
    const items: unknown[] = []
    while (i < lines.length) {
      const itemMatch = BLOCK_ITEM_RE.exec(lines[i] ?? "")
      if (itemMatch === null) break
      items.push(parseScalar(itemMatch[1] ?? ""))
      i++
    }
    frontmatter[key] = items.length > 0 ? items : ""
  }
  return { frontmatter, body }
}

/** Serialize frontmatter as `key: <json>` lines (`type` first), dropping `undefined`. */
export const serializeFrontmatter = (fm: Record<string, unknown>): string => {
  const keys = Object.keys(fm)
  const ordered = ["type", ...keys.filter((k) => k !== "type")]
  const lines = ordered
    .filter((k) => fm[k] !== undefined)
    .map((k) => `${k}: ${JSON.stringify(fm[k])}`)
  return `---\n${lines.join("\n")}\n---\n`
}

/** Serialize one concept (frontmatter block + a blank line + body). */
export const serializeConcept = (fm: Record<string, unknown>, body: string): string =>
  `${serializeFrontmatter(fm)}\n${body}`

/** Normalize a bundle file path to a forward-slash relative path (no `./` or leading `/`). */
const normalizePath = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim()

const basename = (path: string): string => path.split("/").pop() ?? path
const RESERVED = new Set(["index.md", "log.md"])
const MD_EXT_RE = /\.(md|markdown)$/i

/**
 * Export memory items under `path` (or all) as an OKF bundle: one `<slug>.md` per live concept,
 * a bundle-root `index.md` (carries `okf_version` + a concept index), and a `log.md` rendered
 * from each concept's version history.
 */
export const exportOkfBundle = async (
  store: MemoryStore,
  opts: { path?: string; prefix?: boolean } = {},
): Promise<OkfExportResult> => {
  const items = await store.listMemory({
    prefix: opts.prefix ?? false,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  })
  const files: OkfFile[] = items.map((item) => ({
    path: `${item.slug}.md`,
    content: serializeConcept(item.frontmatter, item.body),
  }))

  const indexBody = ["# Memory bundle", "", ...items.map((i) => `- [${i.slug}](${i.slug}.md)`), ""]
  files.unshift({
    path: "index.md",
    content: serializeConcept(
      { okf_version: OKF_VERSION, type: "bundle", count: items.length },
      indexBody.join("\n"),
    ),
  })

  const logLines: string[] = ["# Change log", ""]
  for (const item of items) {
    const history = await store.getMemoryHistory(item.slug)
    logLines.push(`## ${item.slug}`)
    for (const rev of history) {
      logLines.push(`- v${rev.version} (${rev.reason ?? "set"}) — ${rev.createdAt}`)
    }
    logLines.push("")
  }
  files.push({ path: "log.md", content: `---\ntype: log\n---\n\n${logLines.join("\n")}` })

  return { okfVersion: OKF_VERSION, count: items.length, files }
}

/** Read `okf_version` from a bundle's `index.md` frontmatter, if present. */
const bundleOkfVersion = (files: OkfFile[]): string | null => {
  const index = files.find((f) => basename(normalizePath(f.path)).toLowerCase() === "index.md")
  if (index === undefined) return null
  const v = parseDocument(index.content).frontmatter.okf_version
  return typeof v === "string" ? v : null
}

/**
 * Import an OKF bundle: each concept file is upserted (so every import is itself versioned +
 * audited). Concept id = the path minus its `.md`/`.markdown` extension. Resilient — one bad
 * file never aborts the bundle; every file gets a recorded outcome:
 *   - skipped 'reserved'  → `index.md`/`log.md` (bundle structure, not concepts)
 *   - skipped 'not-markdown' / 'empty' / 'no-type' → not a valid OKF concept
 *   - failed '<error>'    → the upsert threw (e.g. scope/auth), captured, not propagated
 *   - imported            → with its resolved slug
 */
export const importOkfBundle = async (
  store: MemoryStore,
  files: OkfFile[],
): Promise<OkfImportResult> => {
  const items: OkfImportItem[] = []
  for (const file of files) {
    const path = normalizePath(file.path)
    const base = basename(path).toLowerCase()
    if (RESERVED.has(base)) {
      items.push({ path: file.path, status: "skipped", reason: "reserved" })
      continue
    }
    if (!MD_EXT_RE.test(path)) {
      items.push({ path: file.path, status: "skipped", reason: "not-markdown" })
      continue
    }
    if (file.content.trim().length === 0) {
      items.push({ path: file.path, status: "skipped", reason: "empty" })
      continue
    }
    const slug = path.replace(MD_EXT_RE, "")
    const { frontmatter, body } = parseDocument(file.content)
    if (typeof frontmatter.type !== "string" || frontmatter.type.trim().length === 0) {
      items.push({ path: file.path, status: "skipped", reason: "no-type" })
      continue
    }
    const visibility =
      typeof frontmatter.visibility === "string" ? frontmatter.visibility : undefined
    try {
      await store.upsertMemory({
        slug,
        frontmatter,
        body,
        ...(visibility !== undefined ? { visibility } : {}),
      })
      items.push({ path: file.path, status: "imported", slug })
    } catch (err) {
      items.push({
        path: file.path,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return {
    imported: items.filter((i) => i.status === "imported").length,
    skipped: items.filter((i) => i.status === "skipped").length,
    failed: items.filter((i) => i.status === "failed").length,
    okfVersion: bundleOkfVersion(files),
    items,
  }
}

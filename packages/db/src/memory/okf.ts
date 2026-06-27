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

export interface OkfImportResult {
  imported: number
  skipped: string[]
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

/** Split a concept file into `{ frontmatter, body }`. No leading frontmatter ⇒ empty frontmatter. */
export const parseDocument = (content: string): ParsedDocument => {
  const m = FRONTMATTER_RE.exec(content)
  if (m === null) return { frontmatter: {}, body: content }
  const body = content.slice(m[0].length)
  const frontmatter: Record<string, unknown> = {}
  for (const line of (m[1] ?? "").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (key.length === 0) continue
    frontmatter[key] = parseScalar(line.slice(idx + 1))
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

const basename = (path: string): string => path.split("/").pop() ?? path
const RESERVED = new Set(["index.md", "log.md"])

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

/**
 * Import an OKF bundle: each non-reserved concept file is upserted (so every import is itself
 * versioned + audited). Concept id = file path minus `.md`. Reserved files (`index.md`/`log.md`)
 * and files without a valid non-empty `type` are skipped (the skip list names them).
 */
export const importOkfBundle = async (
  store: MemoryStore,
  files: OkfFile[],
): Promise<OkfImportResult> => {
  let imported = 0
  const skipped: string[] = []
  for (const file of files) {
    if (RESERVED.has(basename(file.path))) {
      skipped.push(file.path)
      continue
    }
    const slug = file.path.replace(/\.md$/i, "")
    const { frontmatter, body } = parseDocument(file.content)
    if (typeof frontmatter.type !== "string" || frontmatter.type.trim().length === 0) {
      skipped.push(file.path) // not a valid OKF concept (no `type`)
      continue
    }
    const visibility =
      typeof frontmatter.visibility === "string" ? frontmatter.visibility : undefined
    await store.upsertMemory({
      slug,
      frontmatter,
      body,
      ...(visibility !== undefined ? { visibility } : {}),
    })
    imported++
  }
  return { imported, skipped }
}

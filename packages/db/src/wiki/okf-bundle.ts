/**
 * Wiki OKF bundle export (v3/W5 increment 2a) — serialize a wiki namespace/subtree as an OKF bundle
 * for download. PURE packaging over the SAME lane-agnostic serializers memory export uses
 * (`serializeConcept`/`OKF_VERSION` from `memory/okf.ts`); the gated page read lives in
 * `WikiStore.exportBundle`. Memory's `okf_export`/`okf_import` + `MemoryStore` are untouched.
 *
 * Read-only + caller-scoped: the export runs as the CALLER (NO system coercion — it returns a
 * download to the person who already sees these pages), and each file preserves `visibility` in its
 * frontmatter for round-trip fidelity. (Increment 2b's IMPORT is where visibility gets floored — an
 * untrusted-ingress concern that does not apply to a read-only export.)
 */
import {
  basename,
  bundleOkfVersion,
  MD_EXT_RE,
  normalizePath,
  OKF_VERSION,
  type OkfExportResult,
  type OkfFile,
  type OkfImportItem,
  parseDocument,
  RESERVED,
  serializeConcept,
} from "../memory/okf"

/** One wiki page as the bundle builder needs it (already visibility-gated by the store). */
export interface BundlePage {
  slug: string
  type: string
  title: string
  tags: string[]
  visibility: string
  body: string
}

/** One revision line for `log.md`. */
export interface BundleRevision {
  version: number
  reason: string | null
  createdAt: string
}

/**
 * Build the OKF bundle files from the gated pages + their revisions. Mirrors the memory bundle:
 * a reserved `index.md` first (okf_version + concept list), one `<slug>.md` per page (frontmatter =
 * type/title/tags/visibility + body), and a `log.md` rendered from each page's revision history.
 */
export const buildWikiBundle = (
  pagesInBundle: BundlePage[],
  revisionsBySlug: Map<string, BundleRevision[]>,
): OkfExportResult => {
  const files: OkfFile[] = pagesInBundle.map((p) => ({
    path: `${p.slug}.md`,
    content: serializeConcept(
      { type: p.type, title: p.title, tags: p.tags, visibility: p.visibility },
      p.body,
    ),
  }))

  const indexBody = [
    "# Wiki bundle",
    "",
    ...pagesInBundle.map((p) => `- [${p.slug}](${p.slug}.md)`),
    "",
  ]
  files.unshift({
    path: "index.md",
    content: serializeConcept(
      { okf_version: OKF_VERSION, type: "bundle", count: pagesInBundle.length },
      indexBody.join("\n"),
    ),
  })

  const logLines: string[] = ["# Change log", ""]
  for (const p of pagesInBundle) {
    logLines.push(`## ${p.slug}`)
    for (const rev of revisionsBySlug.get(p.slug) ?? []) {
      logLines.push(`- v${rev.version} (${rev.reason ?? "set"}) — ${rev.createdAt}`)
    }
    logLines.push("")
  }
  files.push({ path: "log.md", content: `---\ntype: log\n---\n\n${logLines.join("\n")}` })

  return { okfVersion: OKF_VERSION, count: pagesInBundle.length, files }
}

// ── OKF bundle IMPORT (W5/2b — the untrusted-ingress half) ─────────────────────────────────

/** Confinement prefix — every imported page lands under `imported/<namespace>/…`. */
export const IMPORT_ROOT = "imported"

/** Reject-early caps (control 5): checked BEFORE any write. */
export const IMPORT_CAPS = {
  maxFiles: 500,
  maxFileBytes: 256 * 1024, // 256 KB per file
  maxTotalBytes: 8 * 1024 * 1024, // 8 MB per bundle
} as const

const isExternalTarget = (t: string): boolean =>
  /^[a-z]+:\/\//i.test(t) || t.startsWith("mailto:") || t.startsWith("#")

/** Sanitize a slug's path segments: drop empties + `.`/`..` (no traversal, no leading-slash tricks). */
const safeSegments = (path: string): string =>
  path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .join("/")

/** Confine ONE link target to the bundle prefix: strip `./`|`/`|`.md`, drop `.`/`..`, then prefix. */
const confineTarget = (target: string, prefix: string): string => {
  const clean = safeSegments(target.replace(/^\.?\//, "").replace(MD_EXT_RE, ""))
  return `${prefix}/${clean}`
}

// Split on fenced/inline code so a `[[x]]` inside code is left VERBATIM (author's bytes, and the
// store's link extraction ignores code anyway) — only prose links are confined.
const CODE_SPLIT = /(```[\s\S]*?```|`[^`\n]*`)/g

const confineProse = (s: string, prefix: string): string =>
  s
    // [[target|label]] → [[<prefix>/target|label]] (external/anchor left alone)
    .replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
      const parts = inner.split("|")
      const target = (parts[0] ?? "").trim()
      if (target.length === 0 || isExternalTarget(target)) return whole
      const label = parts.slice(1).join("|")
      const confined = confineTarget(target, prefix)
      return label.length > 0 ? `[[${confined}|${label}]]` : `[[${confined}]]`
    })
    // [txt](target) internal, non-image → [txt](/<prefix>/target)  ((?<!!) skips images)
    .replace(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g, (whole, txt: string, target: string) => {
      if (isExternalTarget(target)) return whole
      return `[${txt}](/${confineTarget(target, prefix)})`
    })

/**
 * Rewrite a body's in-bundle wikilinks/relative links to the confinement prefix so `[[bar]]` resolves
 * to `imported/<ns>/bar` — NEVER globally (an imported `[[index]]` must not cross-link into your root
 * index, and a collision must never silently merge into an existing page). Code spans are untouched.
 */
export const confineWikilinks = (body: string, prefix: string): string =>
  body
    .split(CODE_SPLIT)
    .map((seg, i) => (i % 2 === 1 ? seg : confineProse(seg, prefix)))
    .join("")

/** A file ready to write (validated + confined), or a per-file skip outcome. */
export type PreparedFile =
  | { kind: "skip"; item: OkfImportItem }
  | {
      kind: "write"
      path: string
      slug: string
      type: string
      title: string
      tags: string[]
      body: string
    }

export interface PreparedBundle {
  okfVersion: string | null
  prepared: PreparedFile[]
}

/**
 * PURE bundle preparation (no DB): enforce CAPS (throws on exceed — reject before any write),
 * then per-file resilient validation mirroring `importOkfBundle` (reserved/not-md/empty/no-type
 * skipped). For a valid concept: confine the slug UNDER `imported/<namespace>/…`, confine its body's
 * links, and build a CLEAN frontmatter — `type`/`title`/`tags` only, plus `draft:true`. Bundle
 * `visibility`/`draft`/any other field are DROPPED and NEVER read (control 1: unconditional floor).
 */
export const prepareWikiBundle = (files: OkfFile[], namespace: string): PreparedBundle => {
  // CAPS (control 5) — reject the whole bundle cleanly before touching the DB.
  if (files.length > IMPORT_CAPS.maxFiles) {
    throw new Error(`import rejected: ${files.length} files exceeds max ${IMPORT_CAPS.maxFiles}`)
  }
  const encoder = new TextEncoder()
  let total = 0
  for (const f of files) {
    // UTF-8 BYTE length (not string .length, which is UTF-16 code units — multibyte would under-count).
    const bytes = encoder.encode(f.content).length
    if (bytes > IMPORT_CAPS.maxFileBytes) {
      throw new Error(
        `import rejected: '${f.path}' (${bytes}B) exceeds max ${IMPORT_CAPS.maxFileBytes}B`,
      )
    }
    total += bytes
  }
  if (total > IMPORT_CAPS.maxTotalBytes) {
    throw new Error(`import rejected: bundle ${total}B exceeds max ${IMPORT_CAPS.maxTotalBytes}B`)
  }

  const ns = safeSegments(namespace)
  const prefix = ns.length > 0 ? `${IMPORT_ROOT}/${ns}` : IMPORT_ROOT

  const prepared: PreparedFile[] = files.map((file) => {
    const path = normalizePath(file.path)
    const base = basename(path).toLowerCase()
    if (RESERVED.has(base))
      return { kind: "skip", item: { path: file.path, status: "skipped", reason: "reserved" } }
    if (!MD_EXT_RE.test(path))
      return { kind: "skip", item: { path: file.path, status: "skipped", reason: "not-markdown" } }
    if (file.content.trim().length === 0)
      return { kind: "skip", item: { path: file.path, status: "skipped", reason: "empty" } }

    const rel = safeSegments(path.replace(MD_EXT_RE, ""))
    if (rel.length === 0)
      return { kind: "skip", item: { path: file.path, status: "skipped", reason: "empty" } }
    const { frontmatter, body } = parseDocument(file.content)
    if (typeof frontmatter.type !== "string" || frontmatter.type.trim().length === 0) {
      return { kind: "skip", item: { path: file.path, status: "skipped", reason: "no-type" } }
    }
    const title = typeof frontmatter.title === "string" ? frontmatter.title : rel
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map((t) => String(t)) : []
    return {
      kind: "write",
      path: file.path,
      slug: `${prefix}/${rel}`,
      type: frontmatter.type,
      title,
      tags,
      body: confineWikilinks(body, prefix),
    }
  })

  return { okfVersion: bundleOkfVersion(files), prepared }
}

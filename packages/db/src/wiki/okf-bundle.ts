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
import { OKF_VERSION, type OkfExportResult, type OkfFile, serializeConcept } from "../memory/okf"

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

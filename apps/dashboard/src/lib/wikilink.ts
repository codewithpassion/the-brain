/**
 * Wikilink resolution for the wiki VIEW renderer. The red-vs-resolved decision hinges on matching a
 * `[[target]]` to the server's `links.pending` slug array (from `wiki_get_page`), so the slug we
 * compute here MUST be byte-identical to what the store computed when it recorded the pending link.
 *
 * `normalizeLinkTarget` / the `[[…]]` + `[txt](…)` extraction is a VERBATIM port of
 * `packages/db/src/pages/store.ts` (`normalizeLinkTarget` / `extractLinkSlugs`). It is duplicated
 * rather than imported because `@brain/db` pulls `@cloudflare/workers-types` globals that collide
 * with the dashboard's DOM lib (see `src/server/brain.ts`), so it cannot be imported client-side.
 * `wikilink.test.ts` pins the parity cases — if the store rule changes, both must change together.
 */
import { visit } from "unist-util-visit"

/**
 * Normalize an OKF link target to a candidate concept slug, or null when it is external/empty.
 * VERBATIM port of `packages/db/src/pages/store.ts:normalizeLinkTarget`.
 */
export const normalizeLinkTarget = (raw: string): string | null => {
  const target = raw.trim().split("|")[0]?.split("#")[0]?.trim() ?? ""
  if (target.length === 0) return null
  if (/^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) return null // external
  return target
    .replace(/^\.?\//, "") // leading ./ or /
    .replace(/\.md$/i, "")
    .trim()
}

/** The render decision for a link href: external (leave alone), or an internal wiki slug. */
export type WikiHref =
  | { kind: "external"; href: string }
  | { kind: "resolved"; slug: string }
  | { kind: "pending"; slug: string }

/**
 * The make-or-break resolution: turn a link href + the page's pending-slug set into the render
 * decision. An explicit `/wiki/<slug>` is honored; otherwise the store-parity `normalizeLinkTarget`
 * computes the slug. A null/empty slug (external/mailto/anchor) is left external. A slug in the
 * `pending` set is a RED link; otherwise a resolved router link. `pending` comes verbatim from
 * `wiki_get_page.links.pending`, so red-vs-resolved matches what the store recorded.
 */
export const resolveWikiHref = (rawHref: string, pending: ReadonlySet<string>): WikiHref => {
  const raw = rawHref ?? ""
  const slug = raw.startsWith("/wiki/") ? raw.slice("/wiki/".length) : normalizeLinkTarget(raw)
  if (slug === null || slug === "") return { kind: "external", href: raw }
  return pending.has(slug) ? { kind: "pending", slug } : { kind: "resolved", slug }
}

/** The human-visible label for a `[[target|label]]` (the part after `|`, else the raw target). */
export const wikilinkLabel = (inner: string): string => {
  const parts = inner.split("|")
  const label = parts.length > 1 ? parts.slice(1).join("|").trim() : ""
  return label.length > 0 ? label : (parts[0] ?? inner).trim()
}

/** `[[…]]` matcher — mirrors the store's `extractLinkSlugs` regex. */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

// Minimal mdast shapes (avoids a hard dep on @types/mdast being resolvable in tsc's program).
interface MdText {
  type: "text"
  value: string
}
interface MdLink {
  type: "link"
  url: string
  title: null
  children: MdText[]
  data?: { hProperties?: Record<string, string> }
}
interface MdParent {
  type: string
  children: (MdText | MdLink | { type: string })[]
}

/**
 * Remark plugin: rewrite `[[target|label]]` occurrences inside TEXT nodes into mdast `link` nodes.
 * Only `text` nodes are visited, so fenced/inline code is left untouched (it is a different node
 * type). The produced link carries `data-wikilink` so the renderer routes it through the wiki
 * resolver (red-vs-resolved) rather than treating it as a raw external URL.
 */
export const remarkWikiLinks = () => (tree: unknown) => {
  visit(tree as MdParent, "text", (node: MdText, index: number | undefined, parent: unknown) => {
    if (parent == null || index == null) return
    const p = parent as MdParent
    // Only split text that lives in a phrasing context (skip e.g. `code`).
    const value = node.value
    if (!value.includes("[[")) return

    WIKILINK_RE.lastIndex = 0
    const out: (MdText | MdLink)[] = []
    let last = 0
    let m: RegExpExecArray | null = WIKILINK_RE.exec(value)
    while (m !== null) {
      const inner = m[1] ?? ""
      if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) })
      // Emit a normalized `/wiki/<slug>` URL (not the raw target): a clean path survives
      // react-markdown's default urlTransform, so colon-slugs like `[[ticket:1234]]` don't render
      // dead (they'd look like a `ticket:` scheme as a bare target). Normalization is the SAME
      // store-parity `normalizeLinkTarget`, so `resolveWikiHref` recovers the exact slug + red state.
      const rawTarget = inner.split("|")[0]?.trim() ?? inner
      const slug = normalizeLinkTarget(rawTarget)
      out.push({
        type: "link",
        url: slug !== null ? `/wiki/${slug}` : rawTarget,
        title: null,
        data: { hProperties: { "data-wikilink": "1" } },
        children: [{ type: "text", value: wikilinkLabel(inner) }],
      })
      last = m.index + m[0].length
      m = WIKILINK_RE.exec(value)
    }
    if (out.length === 0) return
    if (last < value.length) out.push({ type: "text", value: value.slice(last) })
    p.children.splice(index, 1, ...out)
    return index + out.length // continue past the inserted nodes
  })
}

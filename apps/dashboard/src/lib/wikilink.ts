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
import { headingAnchor } from "@brain/shared"
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

/**
 * Slugify a wikilink's `#anchor` fragment to the id rehype-slug emits on the target heading, or null
 * when there is no fragment. This function owns the wikilink-specific splitting: the label is split
 * off FIRST (`[[slug#anchor|Label]]` → the anchor is `anchor`), then the text after the first `#`.
 * The slugging itself DELEGATES to `@brain/shared`'s `headingAnchor` so the slug rule has ONE home
 * (shared with `extractHeadings`, pinned by `heading-anchors.parity.test.ts`).
 */
export const wikilinkAnchor = (raw: string): string | null => {
  const beforeLabel = raw.split("|")[0] ?? ""
  const hashIndex = beforeLabel.indexOf("#")
  if (hashIndex === -1) return null
  const fragment = beforeLabel.slice(hashIndex + 1).trim()
  if (fragment.length === 0) return null
  return headingAnchor(fragment)
}

/** The render decision for a link href: external (leave alone), or an internal wiki slug + anchor. */
export type WikiHref =
  | { kind: "external"; href: string }
  | { kind: "resolved"; slug: string; hash?: string }
  | { kind: "pending"; slug: string; hash?: string }

/**
 * The make-or-break resolution: turn a link href + the page's pending-slug set into the render
 * decision. An explicit `/wiki/<slug>` is honored; otherwise the store-parity `normalizeLinkTarget`
 * computes the slug. A null/empty slug (external/mailto/anchor) is left external. A slug in the
 * `pending` set is a RED link; otherwise a resolved router link. `pending` comes verbatim from
 * `wiki_get_page.links.pending`, so red-vs-resolved matches what the store recorded.
 */
export const resolveWikiHref = (rawHref: string, pending: ReadonlySet<string>): WikiHref => {
  const raw = rawHref ?? ""
  // Split the `#anchor` off FIRST — before the `/wiki/` short-circuit — so `/wiki/a#b` resolves on
  // the bare slug `a` (restoring pending/red-link detection), and an anchor-only `#x` (empty path)
  // stays external. The path part is then resolved exactly as before.
  const hashIndex = raw.indexOf("#")
  const path = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
  // Normalize the `#hash` through the SAME `headingAnchor` slug rule here — the render chokepoint —
  // so the markdown-link form `[x](/wiki/a#Setup Steps)` deep-links exactly like the wikilink form
  // `[[a#Setup Steps]]`. This is the only caller of `resolveWikiHref` (Markdown.tsx's `a`), and the
  // `[[…]]` form already arrives pre-slugged from `remarkWikiLinks` → `headingAnchor` is idempotent
  // on its own output (`slug("setup-steps-1") === "setup-steps-1"`), so re-normalizing it is a no-op.
  const rawHash = hashIndex === -1 ? "" : raw.slice(hashIndex + 1)
  const hash = rawHash === "" ? "" : headingAnchor(rawHash)
  const slug = path.startsWith("/wiki/") ? path.slice("/wiki/".length) : normalizeLinkTarget(path)
  if (slug === null || slug === "") return { kind: "external", href: raw }
  if (pending.has(slug)) return { kind: "pending", slug, ...(hash !== "" ? { hash } : {}) }
  return { kind: "resolved", slug, ...(hash !== "" ? { hash } : {}) }
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
      // Carry a `#heading` fragment through as the rehype-slug id, so `[[slug#Heading]]` deep-links.
      const anchor = wikilinkAnchor(rawTarget)
      const url =
        slug !== null ? (anchor !== null ? `/wiki/${slug}#${anchor}` : `/wiki/${slug}`) : rawTarget
      out.push({
        type: "link",
        url,
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

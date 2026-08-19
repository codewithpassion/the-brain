/**
 * The ONE client-safe home for the wiki heading-anchor rule.
 *
 * Wiki heading `id`s are generated CLIENT-SIDE by `rehype-slug` at render time
 * (`apps/dashboard/src/components/Markdown.tsx`). Nothing server-side could compute them, so an MCP
 * client rewriting `#anchor` deep links had to GUESS the slug — and a wrong guess fails silently
 * (the browser finds no matching `id` and lands the reader at the top). This module is the single
 * authority for that rule so `wiki_get_page` can hand back the real ids instead.
 *
 * Why a markdown parser lives in `@brain/shared` (whose header says "pure types, constants, and Zod
 * schemas only"): `@brain/shared` is the ONLY package the browser and the Worker can both import —
 * `@brain/db` pulls `@cloudflare/workers-types` globals that collide with the dashboard's DOM lib,
 * which is exactly why `apps/dashboard/src/lib/wikilink.ts` duplicates its slug code today rather
 * than importing it. The added deps (`unified` + `remark-parse` + `remark-gfm` +
 * `mdast-util-to-string` + `github-slugger`) are all pure JS / Workers-safe / browser-safe. The
 * plugin list mirrors the dashboard's render pipeline LITERALLY so parity reasoning is obvious, and
 * `github-slugger@^2` is what `rehype-slug@6` uses internally (same major = same slug rule).
 *
 * Parity is pinned end-to-end by `apps/dashboard/test/heading-anchors.parity.test.ts`, which runs
 * the REAL `remark-parse → remark-gfm → remark-rehype → rehype-slug` pipeline and asserts the hast
 * `id`s equal `extractHeadings(...).map(h => h.id)`. If the two ever disagree, the rendered DOM is
 * ground truth and this extractor is what's wrong.
 */
import GithubSlugger from "github-slugger"
import { toString as mdastToString } from "mdast-util-to-string"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"

export interface MarkdownHeading {
  level: number
  text: string
  id: string
}

/**
 * Slugify a raw heading fragment to the `id` rehype-slug emits on that heading. A FRESH
 * `GithubSlugger` per call is REQUIRED: the class is stateful (it dedups across calls), so reusing
 * one would corrupt results. This is the slugging core moved out of `wikilink.ts`'s `wikilinkAnchor`
 * (which keeps the `[[…|…]]` label / `#` splitting around this call).
 *
 * The fresh-slugger asymmetry with `extractHeadings` (one slugger per document) is DELIBERATE: a
 * human-text `[[…#heading]]` link can only ever target the FIRST of duplicate headings, so it needs
 * the un-deduped id. `extractHeadings(...)[n].id` is precisely how a caller addresses the second.
 */
export const headingAnchor = (fragment: string): string => new GithubSlugger().slug(fragment)

// Minimal structural mdast shapes. We avoid a hard dep on `@types/mdast` being resolvable in tsc's
// program (same reasoning as `wikilink.ts`) — `mdast-util-to-string` accepts `unknown`, so slugging
// the node composes cleanly without the full type.
interface MdNode {
  type: string
  depth?: number
  children?: MdNode[]
}

// `[[…]]` matcher — mirrors `apps/dashboard/src/lib/wikilink.ts`'s `WIKILINK_RE`.
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

/**
 * Reduce `[[target|Label]]` → `Label` and `[[target]]` → `target` inside a heading's text, so the
 * slug matches what the RENDERER produces. In `Markdown.tsx` the `remarkWikiLinks` transform runs
 * BEFORE `rehype-slug`, so a heading's wikilink is already a link node carrying only its LABEL by the
 * time rehype-slug reads the text — `## See [[guides/algo|Algo]]` slugs `see-algo`, NOT the raw
 * bracketed target (`see-guidesalgoalgo`, a dead anchor). This MIRRORS `wikilink.ts`'s `wikilinkLabel`
 * rule (label after the FIRST `|`, else the target); the two must change together, and the parity
 * test — which now runs `remarkWikiLinks` in its pipeline — pins them. Kept a plain string transform
 * on purpose: pulling `unist-util-visit` / the remark plugin into `@brain/shared` is out of scope.
 */
const reduceWikiLinks = (text: string): string =>
  text.replace(WIKILINK_RE, (_all, inner: string) => {
    const parts = inner.split("|")
    const label = parts.length > 1 ? parts.slice(1).join("|").trim() : ""
    return label.length > 0 ? label : (parts[0] ?? inner).trim()
  })

/**
 * Parse a markdown body and return every heading in document order, each with the rehype-slug `id`
 * the renderer will assign. ONE `GithubSlugger` for the whole document, so duplicate headings get
 * `-1`/`-2` exactly like rehype-slug does per page.
 *
 * Correctness notes (a naive `^#+ ` regex extractor WILL drift from the rendered DOM):
 *  - rehype-slug slugs the RENDERED TEXT CONTENT, not the raw line — `## **Bold** ` + inline `code`
 *    slugs "Bold code". We parse with mdast (`remark-parse` + `remark-gfm`) and read text via
 *    `mdast-util-to-string`, matching the dashboard's plugin set. `remark-gfm` matters so a
 *    `~~strike~~` heading collapses to its text instead of staying literal.
 *  - Two `mdast-util-to-string` defaults are load-bearing and BOTH must be turned off, because each
 *    counts text that the render pipeline drops:
 *      · `includeImageAlt: false` — it INCLUDES image alt text by default, hast text content does
 *        NOT, so an image in a heading contributes nothing (`## Look ![alt](x) end` → "Look  end"
 *        → `look--end`).
 *      · `includeHtml: false` — it INCLUDES raw `html` node values by default, but remark-rehype
 *        (with react-markdown's default, no `allowDangerousHtml`) DROPS them, so `## Hello <b>x</b>`
 *        renders text "Hello x" → `hello-x`; keeping the default would slug the literal tags into a
 *        silent dead link.
 *  - We walk the WHOLE tree, not just top-level headings: headings nested in blockquotes / list items
 *    are slugged by rehype-slug too.
 *  - Headings inside fenced code blocks are never `heading` nodes, so they're skipped for free;
 *    setext (`===`/`---`) headings ARE `heading` nodes, so they're included.
 *  - A heading containing a `[[wikilink]]` renders with the wikilink's LABEL, not the raw brackets,
 *    because `Markdown.tsx` runs `remarkWikiLinks` before `rehype-slug`. `reduceWikiLinks` mirrors
 *    that here (see its note) so `## See [[a|Algo]]` slugs `see-algo`, matching the DOM.
 */
export const extractHeadings = (markdown: string): MarkdownHeading[] => {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdNode
  const slugger = new GithubSlugger()
  const headings: MarkdownHeading[] = []
  const walk = (node: MdNode): void => {
    if (node.type === "heading") {
      const text = reduceWikiLinks(
        mdastToString(node, { includeImageAlt: false, includeHtml: false }),
      )
      headings.push({ level: node.depth ?? 1, text, id: slugger.slug(text) })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return headings
}

# Wiki heading anchors — making IDs discoverable to MCP clients

**Status:** SHIPPED 2026-08-19 (brain-api + brain-dashboard deployed) ·
follow-up to `42c7e76` (heading deep links)

Prongs A, B, C shipped. **Prong D (save-time broken-anchor warnings) remains deferred.**

Two things landed beyond what this plan anticipated, both found by running the real
render pipeline rather than reasoning about it:
- **A second mdast↔hast divergence: raw inline HTML.** `mdast-util-to-string` counts
  `html` node values, but remark-rehype (no `allowDangerousHtml`) drops them. Without
  `{ includeHtml: false }`, `## Hello <b>world</b>` slugged to `hello-bworldb` instead of
  `hello-world`. Only `includeImageAlt` was predicted below.
- **Wikilink-in-heading was a live dead-anchor bug.** `Markdown.tsx` runs
  `remarkWikiLinks` BEFORE `rehype-slug`, so `## See [[guides/algo|Algo]]` renders as
  `see-algo` while raw-text extraction gave `see-guidesalgoalgo`. Fixed with a pure
  `[[target|Label]]` → `Label` reduction in `extractHeadings`, and the parity test's
  pipeline now includes `remarkWikiLinks` — making its "exact plugin set" claim true for
  the first time.

## Problem

`42c7e76` shipped `#anchor` deep links, but an MCP client (Claude Desktop) rewriting
links across a page has no way to learn the anchor IDs. It must either guess the
slugification rule or give up — and a wrong guess fails **silently**: the browser
finds no matching `id` and the reader lands at the top of the page.

The rule is genuinely unguessable for real headings. github-slugger strips punctuation
*without* collapsing the whitespace it leaves behind, so:

```
## Tue 18 Aug | PM | D0 - THE META POST (launches the series)
→ id="tue-18-aug--pm--d0---the-meta-post-launches-the-series"
       ^^          ^^     ^^^   (double/triple dashes from removed | and ( ))
```

(computed, not guessed — `new GithubSlugger().slug(…)` at `github-slugger@2`)

Plus dedup: a second `## Setup Steps` on the same page is `setup-steps-1`.

## Key insight (leads the plan) — CORRECTED 2026-08-19

For **wikilinks inside wiki pages, the ID is usually unnecessary.** `wikilinkAnchor`
(`apps/dashboard/src/lib/wikilink.ts:36`) slugifies the fragment at render time, so
`[[guides/setup#Setup Steps]]` — verbatim heading text — already resolves correctly.

**But not for headings containing `|`.** `wikilinkAnchor` splits on the first `|`
unconditionally (`raw.split("|")[0]`) to strip a `[[target|Label]]` label, so:

```
[[guides/launch#Tue 18 Aug | PM | D0 - THE META POST (launches the series)]]
→ anchor "tue-18-aug"        ← truncated at the first |, silently dead
```

(verified by running the committed function — an earlier draft of this plan claimed
this case "already resolves"; it does not.)

This is irreducibly ambiguous: nothing distinguishes a `|` inside a heading from the
label separator, and the renderer can't consult the *target* page's headings to
disambiguate. So for pipe-bearing headings there is no text form — the literal id is
the only answer, which makes **Prong B load-bearing, not just a convenience.**

Exact IDs are therefore needed for:
- any heading containing `|` (which is most of the user's actual headings)
- `[label](/wiki/slug#id)` markdown-form links (hash passes through verbatim, and a
  space-containing destination isn't a valid markdown link anyway)
- absolute URLs shared outside the wiki (Slack, docs, tickets)
- the second and later of duplicate headings (`setup-steps-1`)

---

## Prong A — Document the rule (no code; ships first, but does NOT fully unblock)

1. `WIKI_SAVE_PAGE_OP.input.body` description (`packages/db/src/wiki/ops.ts:139`) —
   currently says only "`[[slug#heading]]` deep-links to a heading". Make the contract
   explicit: **write the heading text verbatim in `[[…]]` form; it is slugified for you.**
   Note the `|` caveat — `[[a#b|Label]]` splits on the first `|`, so a heading containing
   `|` cannot use the label form (use the `headings[].id` from Prong B instead).
2. `apps/api/src/mcp/guide.ts` wiki section — same one-liner, plus "call `wiki_get_page`
   and read `headings[]` when you need a literal `#id`".

**Verify:** re-read both descriptions; a fresh client following them writes working links.

## Prong B — `wiki_get_page` returns the headings (authoritative)

New shared module `packages/shared/src/heading-anchors.ts`:

```ts
export interface MarkdownHeading { level: number; text: string; id: string }
export const extractHeadings = (markdown: string): MarkdownHeading[]
export const headingAnchor = (fragment: string): string   // moved from wikilink.ts
```

- Home is `@brain/shared` — client-safe (zod-only, no `@cloudflare/workers-types`),
  which is exactly the collision `wikilink.ts`'s header documents. `github-slugger@^2`
  is pure JS and Workers-safe (it's what `rehype-slug@6` uses internally).
- Wire into `WikiPageDetail` (`packages/db/src/wiki/store.ts:79`) + `WikiPageDetailSchema`
  as `headings: MarkdownHeading[]`, with an optional `url` per heading decorated through
  the existing `brainDeepLinks` pattern — `${wikiPage(slug)}#${id}`, omitted when
  `DASHBOARD_URL` is unset, matching the existing `url` fields on these schemas.
- **Not** added to `wiki_list_pages` — that's a sidebar listing; per-page bodies aren't loaded.
- Dashboard: `wikilinkAnchor` re-exports from shared (same function, no rule duplication).

### Parity gotchas this must get right (where it silently breaks)

- **One `GithubSlugger` per document** in `extractHeadings`, so duplicates get
  `-1`/`-2` matching rehype-slug. Note the deliberate asymmetry: `headingAnchor` uses a
  *fresh* slugger (correct — it's idempotent on an already-correct id), which means the
  human-text `[[…]]` form can only ever target the **first** of duplicate headings.
  `headings[].id` is precisely how a caller addresses the second one.
- **rehype-slug slugs the rendered text, not the raw line.** `## **Bold** `code`` →
  text is "Bold code". So: strip inline markdown, skip headings inside fenced code,
  include setext (`===`/`---`) headings. A `^#+` regex extractor *will* drift.
  → use `remark-parse` + `mdast-util-to-string` in shared rather than hand-rolling.
  Known divergence to pin or accept: `mdast-util-to-string` includes image alt text,
  hast text content does not.

### The guardrail test

Dashboard-side parity test (mirrors the existing `wikilink.test.ts` pinning pattern):
run the **real** `remark-parse → remark-gfm → remark-rehype → rehype-slug` pipeline over
gnarly fixtures and assert id-equality with `extractHeadings`. Fixtures must include the
`Tue 18 Aug | PM | D0 - …` heading, duplicate headings, a heading inside a fenced block,
a setext heading, and inline-formatted headings.

**Verify:** parity test green; `wiki_get_page` on a real page returns IDs that match the
rendered DOM.

## Prong C — Normalize the markdown-link hash (small consistency fix)

`resolveWikiHref` (`wikilink.ts:60`) passes the hash through verbatim, so
`[[a#Setup Steps]]` works but `[x](/wiki/a#Setup Steps)` doesn't. Run the hash through
`headingAnchor` in the render path. Safe: a fresh slugger is idempotent on its own
output (`slug("setup-steps-1")` → `"setup-steps-1"`), so already-correct IDs are unchanged.

**Verify:** new cases in `wikilink.test.ts` — raw-text hash normalizes, correct id round-trips.

## Prong D — Save-time broken-anchor warnings (optional, later)

`wiki_save_page` could return `pendingAnchors: [{ slug, anchor }]` for `#fragments` that
match no heading on the target page — the anchor equivalent of red links, killing the
silent-failure mode outright. **Listed, not committed to**: the ask is discoverability,
and cross-page validation means loading every link target's body on save. Revisit if
broken anchors show up in practice.

---

## Sequencing

A (docs, ships alone) → B (**the actual unblocker** — pipe-bearing headings have no
text form, so the ~60-link rewrite needs `headings[]`) → C (rides with B) → D deferred.

## Explicitly out of scope

Consolidating the `normalizeLinkTarget` duplication between `wikilink.ts` and
`packages/db/src/pages/store.ts`. Same shared-package argument would apply, but it's a
separate change with its own blast radius.

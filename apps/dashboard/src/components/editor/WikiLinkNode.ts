/**
 * `[[wikilink]]` autocomplete (W4b). IMPORTANT round-trip finding: `@tiptap/markdown` does NOT invoke
 * a custom node's `storage.markdown.serialize`, and it ESCAPES brackets in text output (`[[x]]` →
 * `\[\[x\]\]`). So instead of a custom node, the `[[` trigger inserts PLAIN TEXT `[[target]]` and the
 * Editor un-escapes `\[\[`/`\]\]` in `getMarkdown()` — this makes BOTH freshly-inserted AND
 * previously-authored wikilinks round-trip verbatim (store-parity `[[slug]]` / `[[slug|label]]`).
 * Items come from `wiki_list_pages` (client-filtered) + `search_entities`; the last row creates a red
 * link.
 */
import { entityPageSlug } from "@brain/shared"
import { Extension } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import Suggestion from "@tiptap/suggestion"
import { searchEntities, wikiListPages } from "../../server/fns"
import { type SuggestionItem, suggestionRender } from "./suggestion"

export const WikiLinkPluginKey = new PluginKey("wikilink")

/** Session cache of the tenant's page slugs/titles (filtered client-side for `[[` autocomplete). */
let pageCache: { slug: string; title: string }[] | null = null
const getPages = async (): Promise<{ slug: string; title: string }[]> => {
  if (pageCache === null) {
    const r = await wikiListPages({ data: { limit: 500 } })
    pageCache = r.ok ? r.data.pages.map((p) => ({ slug: p.slug, title: p.title })) : []
  }
  return pageCache
}
/** Invalidate the page cache (call after creating a page so it shows in future autocompletes). */
export const invalidatePageCache = (): void => {
  pageCache = null
}

interface WikiItem extends SuggestionItem {
  /** The wikilink display label; the slug is `id`. */
  display: string
}

/** The `[[target|label]]` (or `[[target]]`) text a picked item inserts. */
const wikilinkText = (item: WikiItem): string =>
  item.display && item.display !== item.id ? `[[${item.id}|${item.display}]]` : `[[${item.id}]]`

const items = async ({ query }: { query: string }): Promise<WikiItem[]> => {
  const q = query.toLowerCase().trim()
  const pages = (await getPages())
    .filter((p) => p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q))
    .slice(0, 6)
    .map<WikiItem>((p) => ({
      id: p.slug,
      label: p.title || p.slug,
      hint: p.slug,
      display: p.title || p.slug,
    }))

  let entities: WikiItem[] = []
  if (q.length >= 2) {
    const res = await searchEntities({ data: { query } })
    if (res.ok) {
      entities = res.data.entities.slice(0, 4).map<WikiItem>((e) => {
        const slug = entityPageSlug(e.kind, e.name)
        return { id: slug, label: e.name, hint: `entity · ${e.kind}`, display: e.name }
      })
    }
  }

  const out = [...pages, ...entities]
  if (query.trim().length > 0) {
    out.push({
      id: query.trim(),
      label: `Create “${query.trim()}”`,
      hint: "new red link",
      create: true,
      display: query.trim(),
    })
  }
  return out
}

export const WikiLinkSuggest = Extension.create({
  name: "wikilinkSuggest",
  addProseMirrorPlugins() {
    return [
      Suggestion<WikiItem>({
        editor: this.editor,
        char: "[[",
        pluginKey: WikiLinkPluginKey,
        items,
        render: suggestionRender(),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, `${wikilinkText(props)} `)
            .run()
        },
      }),
    ]
  },
})

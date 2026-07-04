/**
 * Slash `/` block menu + `@`-mention (W4b), both riding the shared `@tiptap/suggestion` popup.
 * - Slash: a static block-command list (headings, lists, quote, code block, rule). No table command:
 *   `@tiptap/markdown` can't serialize table nodes, so a table would be dropped on save (see Editor).
 * - Mention: `search_entities`; picking one inserts a `[[wikilink]]` to that entity's page (per the
 *   plan, "@-mention inserts an entity-page link") — reusing the WikiLink node, no separate chip.
 */
import { entityPageSlug } from "@brain/shared"
import { type Editor, Extension } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import Suggestion from "@tiptap/suggestion"
import { searchEntities } from "../../server/fns"
import { type SuggestionItem, suggestionRender } from "./suggestion"

type Range = { from: number; to: number }

interface SlashItem extends SuggestionItem {
  run: (editor: Editor, range: Range) => void
}

const SLASH_COMMANDS: SlashItem[] = [
  {
    id: "h1",
    label: "Heading 1",
    hint: "# Big heading",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    hint: "## Section",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    hint: "### Sub-section",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run(),
  },
  {
    id: "ul",
    label: "Bullet list",
    hint: "• item",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: "ol",
    label: "Numbered list",
    hint: "1. item",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    hint: "> blockquote",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: "code",
    label: "Code block",
    hint: "```",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: "hr",
    label: "Divider",
    hint: "horizontal rule",
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
]

export const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("slashMenu"),
        // Slash only at the start of an empty-ish line (standard notion-style behavior).
        allowSpaces: false,
        startOfLine: true,
        items: ({ query }) =>
          SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
        render: suggestionRender(),
        command: ({ editor, range, props }) => props.run(editor, range),
      }),
    ]
  },
})

const entityItems = async ({ query }: { query: string }): Promise<SuggestionItem[]> => {
  if (query.trim().length < 1) return []
  const res = await searchEntities({ data: { query } })
  if (!res.ok) return []
  return res.data.entities.slice(0, 8).map((e) => ({
    id: entityPageSlug(e.kind, e.name),
    label: e.name,
    hint: `@ entity · ${e.kind}`,
  }))
}

export const MentionEntities = Extension.create({
  name: "mentionEntities",
  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestionItem>({
        editor: this.editor,
        char: "@",
        pluginKey: new PluginKey("mentionEntities"),
        items: entityItems,
        render: suggestionRender(),
        // Insert a wikilink (as text `[[slug|name]]`) to the entity's page — round-trips via the
        // Editor's un-escape (same reason WikiLinkSuggest inserts text, not a custom node).
        command: ({ editor, range, props }) => {
          editor.chain().focus().insertContentAt(range, `[[${props.id}|${props.label}]] `).run()
        },
      }),
    ]
  },
})

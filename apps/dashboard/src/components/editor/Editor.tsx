/**
 * The TipTap 3 rich-text surface (W4b). Deliberately SAVE-AGNOSTIC: it renders markdown and exposes
 * `getMarkdown()` via a ref — it knows nothing about wiki vs memory, so both save paths reuse it
 * (deliverable 4). Client-only: this module is imported LAZILY (`React.lazy`) so TipTap is a
 * code-split CLIENT chunk that never enters the SSR server bundle; `immediatelyRender:false` keeps it
 * SSR-safe if ever rendered on the server. Extension set is limited to what `@tiptap/markdown`
 * SERIALIZES — tables are deliberately excluded (its serializer drops table nodes, so a table typed
 * here would vanish on save; the view renderer still renders tables that arrive via markdown).
 */

import { Markdown } from "@tiptap/markdown"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { forwardRef, useImperativeHandle } from "react"
import { unescapeWikilinks } from "../../lib/md-escape"
import { EditorToolbar } from "./EditorToolbar"
import { MentionEntities, SlashMenu } from "./editor-extensions"
import { WikiLinkSuggest } from "./WikiLinkNode"

export interface EditorHandle {
  getMarkdown: () => string
}

export interface EditorProps {
  initialMarkdown: string
  /** Fires on every change with the current markdown (for autosave-to-local / dirty tracking). */
  onChange?: (markdown: string) => void
}

const Editor = forwardRef<EditorHandle, EditorProps>(({ initialMarkdown, onChange }, ref) => {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Markdown, WikiLinkSuggest, SlashMenu, MentionEntities],
    content: initialMarkdown,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "wiki-prose min-h-[24rem] focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => onChange?.(unescapeWikilinks(editor.getMarkdown())),
  })

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => (editor ? unescapeWikilinks(editor.getMarkdown()) : initialMarkdown),
    }),
    [editor, initialMarkdown],
  )

  if (!editor) return <div className="min-h-[24rem] text-faint text-sm">Loading editor…</div>

  return (
    <div className="rounded-ui border border-border">
      <EditorToolbar editor={editor} />
      <div className="px-4 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
})

Editor.displayName = "Editor"
export default Editor

/**
 * The TipTap 3 rich-text surface (W4b). Deliberately SAVE-AGNOSTIC: it renders markdown and exposes
 * `getMarkdown()` via a ref — it knows nothing about wiki vs memory, so both save paths reuse it
 * (deliverable 4). Client-only: this module is imported LAZILY (`React.lazy`) so TipTap is a
 * code-split CLIENT chunk that never enters the SSR server bundle; `immediatelyRender:false` keeps it
 * SSR-safe if ever rendered on the server. Extension set is limited to what `@tiptap/markdown`
 * SERIALIZES — tables are deliberately excluded (its serializer drops table nodes, so a table typed
 * here would vanish on save; the view renderer still renders tables that arrive via markdown).
 */

import type { Editor as CoreEditor } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { Markdown } from "@tiptap/markdown"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { forwardRef, useImperativeHandle, useRef } from "react"
import { unescapeWikilinks } from "../../lib/md-escape"
import { EditorToolbar } from "./EditorToolbar"
import { MentionEntities, SlashMenu } from "./editor-extensions"
import {
  ImageUpload,
  type ImageUploadStorage,
  isSupportedImage,
  uploadAndInsertImage,
} from "./image"
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
  // A live editor handle for the paste/drop handlers (whose closures are built inside `useEditor`)
  // and the hidden file input; populated in `onCreate`.
  const liveEditor = useRef<CoreEditor | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadFiles = (files: FileList | null): void => {
    const ed = liveEditor.current
    if (ed === null || files === null) return
    for (const file of Array.from(files)) {
      if (isSupportedImage(file)) void uploadAndInsertImage(ed, file)
    }
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Markdown,
      Image,
      ImageUpload,
      WikiLinkSuggest,
      SlashMenu,
      MentionEntities,
    ],
    content: initialMarkdown,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "wiki-prose min-h-[24rem] focus:outline-none",
      },
      // Paste/drop of image files upload through the op, then insert the /wiki-media/<id> node.
      // Return true SYNCHRONOUSLY (and preventDefault) so the default insertion doesn't also fire.
      handlePaste: (_view, event) => {
        const imgs = Array.from(event.clipboardData?.files ?? []).filter(isSupportedImage)
        if (imgs.length === 0) return false
        event.preventDefault()
        uploadFiles(event.clipboardData?.files ?? null)
        return true
      },
      handleDrop: (_view, event) => {
        const dt = (event as DragEvent).dataTransfer
        const imgs = Array.from(dt?.files ?? []).filter(isSupportedImage)
        if (imgs.length === 0) return false
        event.preventDefault()
        uploadFiles(dt?.files ?? null)
        return true
      },
    },
    onCreate: ({ editor }) => {
      liveEditor.current = editor
      // Let the slash-menu "Image" command open the hidden file input.
      ;(editor.storage as unknown as { imageUpload: ImageUploadStorage }).imageUpload.open = () =>
        fileInputRef.current?.click()
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
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          uploadFiles(e.target.files)
          e.target.value = "" // allow re-selecting the same file
        }}
      />
    </div>
  )
})

Editor.displayName = "Editor"
export default Editor

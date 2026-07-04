/**
 * Wiki edit/create UI (W4b): a metadata form + the LAZY-loaded TipTap surface + save controls. The
 * editor is `React.lazy`-imported so TipTap is a code-split CLIENT chunk (never in the SSR server
 * bundle); view mode stays on react-markdown. Save goes through `wiki_save_page` (PageStore: scoped,
 * audited, versioned). VISIBILITY: the select defaults to the value that OMitting would yield
 * (current tier on edit, private on create), and only sends `visibility` when the user changes it —
 * so an edit never silently escalates a page's tier (`buildWikiSavePayload`).
 */
import { useRouter } from "@tanstack/react-router"
import { lazy, Suspense, useRef, useState } from "react"
import { buildWikiSavePayload } from "../../lib/save-payload"
import { wikiSavePage } from "../../server/fns"
import { Button } from "../ui/button"
import type { EditorHandle } from "./Editor"
import { invalidatePageCache } from "./WikiLinkNode"

const LazyEditor = lazy(() => import("./Editor"))

export interface WikiEditorInitial {
  slug: string
  type: string
  title: string
  tags: string[]
  body: string
  /** Current tier (edit) — the create flow ignores this and defaults to private. */
  visibility: string
  draft: boolean
}

export function WikiEditor({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "edit" | "create"
  initial: WikiEditorInitial
  onCancel: () => void
  /** Called after a successful save (navigate + invalidate) so the caller returns to view mode. */
  onSaved: () => void
}) {
  const router = useRouter()
  const editorRef = useRef<EditorHandle>(null)

  const [slug, setSlug] = useState(initial.slug)
  const [type, setType] = useState(initial.type || "note")
  const [title, setTitle] = useState(initial.title)
  const [tags, setTags] = useState(initial.tags.join(", "))
  const [draft, setDraft] = useState(initial.draft)
  // The select's default is what OMitting visibility yields: current tier on edit, private on create.
  const [visibility, setVisibility] = useState(mode === "edit" ? initial.visibility : "private")
  const [visibilityTouched, setVisibilityTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (asDraft: boolean) => {
    const body = editorRef.current?.getMarkdown() ?? initial.body
    const payload = buildWikiSavePayload({
      slug,
      type,
      body,
      title,
      tags: tags.split(","),
      draft: asDraft,
      visibilityTouched,
      visibility,
    })
    if (payload.slug.length === 0) {
      setError("Slug is required.")
      return
    }
    setSaving(true)
    setError(null)
    const res = await wikiSavePage({ data: payload })
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    // A new/renamed page must appear in future `[[` autocompletes without a full reload.
    invalidatePageCache()
    // Navigate to the (possibly new) page + refresh loaders (sidebar + page), then hand control back
    // to the caller to RESET view mode — same-route navigation doesn't remount, so the parent's mode
    // state would otherwise stay "edit"/"create" and leave the user stuck in the editor.
    await router.navigate({ to: "/wiki/$", params: { _splat: res.data.slug } })
    await router.invalidate()
    onSaved()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Slug</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            readOnly={mode === "edit"}
            className="w-64 rounded border border-border px-2 py-1 font-mono text-sm read-only:bg-raised read-only:text-muted focus:outline-none focus:ring-1 focus:ring-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Type</span>
          <input
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-32 rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Visibility</span>
          <select
            value={visibility}
            onChange={(e) => {
              setVisibility(e.target.value)
              setVisibilityTouched(true)
            }}
            className="rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
          >
            <option value="world">world</option>
            <option value="team">team</option>
            <option value="private">private</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          <span className="text-muted">Draft</span>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">
          Tags <span className="text-faint">(comma-separated)</span>
        </span>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
        />
      </label>

      <Suspense
        fallback={
          <div className="min-h-[24rem] rounded-ui border border-border p-4 text-faint text-sm">
            Loading editor…
          </div>
        }
      >
        <LazyEditor ref={editorRef} initialMarkdown={initial.body} />
      </Suspense>

      {error !== null && <p className="text-danger text-sm">Save failed: {error}</p>}

      <div className="flex gap-2">
        <Button onClick={() => save(draft)} disabled={saving}>
          {saving ? "Saving…" : draft ? "Save draft" : "Save"}
        </Button>
        {!draft && (
          <Button variant="outline" onClick={() => save(true)} disabled={saving}>
            Save as draft
          </Button>
        )}
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

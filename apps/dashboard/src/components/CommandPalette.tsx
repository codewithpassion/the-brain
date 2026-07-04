/**
 * Cmd+K quick-switcher (W4b): fuzzy jump across pages (`wiki_list_pages`), entities
 * (`search_entities`), and documents (content `search`), plus actions (New page, Graph). Keyboard-
 * first (↑/↓/Enter/Esc); opens on ⌘K / Ctrl-K anywhere. A single shared palette — distinct from the
 * in-editor `@tiptap/suggestion` popups.
 */
import { entityPageSlug } from "@brain/shared"
import { useRouter } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { listDocuments, searchEntities, wikiListPages } from "../server/fns"

interface Cmd {
  id: string
  label: string
  hint: string
  to: string
}

const NEW_PAGE_SLUG = "untitled"

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [pages, setPages] = useState<{ slug: string; title: string }[]>([])
  const [dyn, setDyn] = useState<Cmd[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Global ⌘K / Ctrl-K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Load the page list once when the palette first opens.
  useEffect(() => {
    if (!open || pages.length > 0) return
    wikiListPages({ data: { limit: 500 } }).then((r) => {
      if (r.ok) setPages(r.data.pages.map((p) => ({ slug: p.slug, title: p.title })))
    })
  }, [open, pages.length])

  // Query the entity + document search arms as the user types (debounced so a burst of keystrokes
  // issues one round-trip, not one per character).
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setDyn([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      Promise.all([
        searchEntities({ data: { query: q } }),
        listDocuments({ data: { query: q } }),
      ]).then(([ents, docs]) => {
        if (cancelled) return
        const out: Cmd[] = []
        if (ents.ok) {
          for (const e of ents.data.entities.slice(0, 5)) {
            out.push({
              id: `e-${e.id}`,
              label: e.name,
              hint: `entity · ${e.kind}`,
              to: `/wiki/${entityPageSlug(e.kind, e.name)}`,
            })
          }
        }
        if (docs.ok) {
          for (const d of docs.data.slice(0, 5)) {
            out.push({
              id: `d-${d.documentId}`,
              label: d.slug,
              hint: "document",
              to: `/documents/${d.documentId}`,
            })
          }
        }
        setDyn(out)
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open])

  const items = useMemo<Cmd[]>(() => {
    const q = query.trim().toLowerCase()
    const actions: Cmd[] = [
      {
        id: "new",
        label: "New page",
        hint: "create a wiki page",
        to: `/wiki/${NEW_PAGE_SLUG}?new=1`,
      },
      { id: "graph", label: "Open Graph", hint: "entity graph view", to: "/graph" },
    ].filter((a) => q.length === 0 || a.label.toLowerCase().includes(q))
    const pageCmds: Cmd[] = pages
      .filter(
        (p) =>
          q.length === 0 || p.slug.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
      )
      .slice(0, 6)
      .map((p) => ({
        id: `p-${p.slug}`,
        label: p.title || p.slug,
        hint: p.slug,
        to: `/wiki/${p.slug}`,
      }))
    return [...actions, ...pageCmds, ...dyn]
  }, [query, pages, dyn])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the result set changes
  useEffect(() => setSelected(0), [items])
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) return null

  const go = (cmd: Cmd | undefined) => {
    if (cmd == null) return
    setOpen(false)
    setQuery("")
    router.navigate({ to: cmd.to })
  }

  const onNavKey = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelected((s) => (s + 1) % Math.max(items.length, 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelected((s) => (s + items.length - 1) % Math.max(items.length, 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      go(items[selected])
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; ⌘K/Esc handled globally
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-dismiss backdrop; Esc closes globally
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/30 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dialog surface; stops backdrop close */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation; keys are on the input */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[36rem] max-w-[90vw] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onNavKey}
          placeholder="Jump to a page, entity, or document…  (New page, Graph)"
          className="w-full border-neutral-100 border-b px-4 py-3 text-sm focus:outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-4 py-3 text-neutral-400 text-sm">No matches.</div>
          ) : (
            items.map((cmd, i) => (
              <button
                type="button"
                key={cmd.id}
                onMouseEnter={() => setSelected(i)}
                onClick={() => go(cmd)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                  i === selected
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-700 hover:bg-neutral-100"
                }`}
              >
                <span className="truncate">{cmd.label}</span>
                <span
                  className={`shrink-0 text-xs ${i === selected ? "text-neutral-300" : "text-neutral-400"}`}
                >
                  {cmd.hint}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A reusable TipTap `@tiptap/suggestion` popup for React (W4b), shared by the `[[wikilink]]`, slash
 * `/`, and `@`-mention triggers (advisor: one popup approach for all three). Uses `ReactRenderer` +
 * a manually-positioned absolute `<div>` anchored to the caret `clientRect` — no tippy/floating-ui
 * dep. The list is keyboard-first (↑/↓/Enter/Esc) via an imperative `onKeyDown` handle.
 */
import { ReactRenderer } from "@tiptap/react"
import type { SuggestionOptions } from "@tiptap/suggestion"
import { forwardRef, useEffect, useImperativeHandle, useState } from "react"

export interface SuggestionItem {
  /** Stable id + what the node stores (the target slug / command id / entity slug). */
  id: string
  /** What the user sees. */
  label: string
  /** Optional secondary line (e.g. entity kind, "create new"). */
  hint?: string
  /** Marks a create-on-enter row (red-link creation). */
  create?: boolean
}

export interface SuggestionListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const SuggestionList = forwardRef<
  SuggestionListHandle,
  { items: SuggestionItem[]; command: (item: SuggestionItem) => void }
>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection whenever the list changes
  useEffect(() => setSelected(0), [items])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setSelected((s) => (s + items.length - 1) % Math.max(items.length, 1))
        return true
      }
      if (event.key === "ArrowDown") {
        setSelected((s) => (s + 1) % Math.max(items.length, 1))
        return true
      }
      if (event.key === "Enter") {
        const item = items[selected]
        if (item) command(item)
        return true
      }
      return false
    },
  }))

  if (items.length === 0) {
    return (
      <div className="w-72 rounded-ui border border-border bg-surface p-2 text-faint text-sm shadow-pop">
        No matches
      </div>
    )
  }
  return (
    <div className="max-h-64 w-72 overflow-y-auto rounded-ui border border-border bg-surface py-1 shadow-pop">
      {items.map((item, i) => (
        <button
          type="button"
          key={item.id}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
          className={`flex w-full flex-col items-start px-3 py-1.5 text-left text-sm ${
            i === selected ? "bg-raised text-ink" : "text-muted hover:bg-raised"
          }`}
        >
          <span className={item.create ? "text-danger" : ""}>{item.label}</span>
          {item.hint && (
            <span className={`text-xs ${i === selected ? "text-accent" : "text-faint"}`}>
              {item.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  )
})
SuggestionList.displayName = "SuggestionList"

/** The `render` half of a `SuggestionOptions`, wired to `SuggestionList` + caret-anchored positioning. */
export const suggestionRender = (): NonNullable<SuggestionOptions["render"]> => () => {
  let component: ReactRenderer<SuggestionListHandle> | null = null
  let popup: HTMLDivElement | null = null

  const place = (rect: (() => DOMRect | null) | null | undefined) => {
    if (popup == null || rect == null) return
    const r = rect()
    if (r == null) return
    popup.style.left = `${r.left + window.scrollX}px`
    popup.style.top = `${r.bottom + window.scrollY + 4}px`
  }

  return {
    onStart: (props) => {
      component = new ReactRenderer(SuggestionList, { props, editor: props.editor })
      popup = document.createElement("div")
      popup.style.position = "absolute"
      popup.style.zIndex = "50"
      popup.appendChild(component.element)
      document.body.appendChild(popup)
      place(props.clientRect)
    },
    onUpdate: (props) => {
      component?.updateProps(props)
      place(props.clientRect)
    },
    onKeyDown: (props) => {
      if (props.event.key === "Escape") return false
      return component?.ref?.onKeyDown(props) ?? false
    },
    onExit: () => {
      popup?.remove()
      popup = null
      component?.destroy()
      component = null
    },
  }
}

/**
 * Theme switcher (UI v2) — a compact segmented control cycling the three identities (Carbon / Paper /
 * Terminal). Lives in the sidebar footer; renders nothing meaningful until mounted (the active theme
 * is only knowable client-side), then reflects + drives `data-theme` via lib/theme.
 */
import { useEffect, useState } from "react"
import { getTheme, setTheme, THEME_EVENT, THEMES, type ThemeId } from "../lib/theme"

/** A small swatch that previews each identity using ITS variables, not the active theme's. */
const SWATCH: Record<ThemeId, { bg: string; fg: string }> = {
  carbon: { bg: "#13141b", fg: "#7c86ee" },
  paper: { bg: "#fdfcf8", fg: "#a63d2f" },
  terminal: { bg: "#0d130e", fg: "#3ecf7e" },
}

export function ThemeSwitcher() {
  const [active, setActive] = useState<ThemeId | null>(null)
  useEffect(() => {
    setActive(getTheme())
    // Another instance (desktop rail vs mobile drawer) may switch the theme — follow it.
    const sync = () => setActive(getTheme())
    window.addEventListener(THEME_EVENT, sync)
    return () => window.removeEventListener(THEME_EVENT, sync)
  }, [])

  return (
    <fieldset className="m-0 flex min-w-0 items-center gap-1 rounded-ui border border-border bg-bg p-1">
      <legend className="sr-only">Theme</legend>
      {THEMES.map((t) => {
        const selected = active === t.id
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={selected}
            title={`${t.label} — ${t.hint}`}
            onClick={() => {
              setTheme(t.id)
              setActive(t.id)
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[calc(var(--t-radius-ui)-2px)] px-2 py-1 text-xs transition-colors ${
              selected ? "bg-raised text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full border"
              style={{
                background: SWATCH[t.id].bg,
                borderColor: SWATCH[t.id].fg,
                boxShadow: selected ? `0 0 0 1.5px ${SWATCH[t.id].fg}` : undefined,
              }}
            />
            {t.label}
          </button>
        )
      })}
    </fieldset>
  )
}

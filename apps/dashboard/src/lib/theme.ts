/**
 * Theme runtime (UI v2). Three complete identities (see styles/app.css) selected by `data-theme` on
 * <html> and persisted in localStorage. `THEME_BOOT_SCRIPT` is inlined into <head> by __root.tsx so
 * the stored theme applies BEFORE first paint (no flash of the default theme); the <html> element
 * carries `suppressHydrationWarning` because that script may change the attribute pre-hydration.
 */

export const THEMES = [
  { id: "carbon", label: "Carbon", hint: "dark · iris" },
  { id: "paper", label: "Paper", hint: "light · editorial" },
  { id: "terminal", label: "Terminal", hint: "phosphor · mono" },
] as const

export type ThemeId = (typeof THEMES)[number]["id"]

export const DEFAULT_THEME: ThemeId = "carbon"
const STORAGE_KEY = "brain-theme"

const isThemeId = (v: string | null): v is ThemeId => THEMES.some((t) => t.id === v)

/** The active theme (falls back to the default outside the browser or on a bad stored value). */
export const getTheme = (): ThemeId => {
  if (typeof document === "undefined") return DEFAULT_THEME
  const attr = document.documentElement.dataset.theme ?? null
  return isThemeId(attr) ? attr : DEFAULT_THEME
}

/** Fired on every setTheme so ALL switcher instances (desktop rail + mobile drawer) stay in sync. */
export const THEME_EVENT = "brain:theme"

/** Apply + persist a theme. */
export const setTheme = (id: ThemeId): void => {
  document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* storage unavailable (private mode) — the attribute alone still themes the session */
  }
  window.dispatchEvent(new Event(THEME_EVENT))
}

/** Pre-paint boot script (inlined in <head>): applies the stored theme before first render. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});if(t==="carbon"||t==="paper"||t==="terminal"){document.documentElement.dataset.theme=t}}catch(e){}})()`

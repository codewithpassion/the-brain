/**
 * Client-only Mermaid diagram. SSR renders the raw ```mermaid code block (no diagram); after
 * hydration a `useEffect` dynamically imports mermaid (a big, browser-only lib — kept out of the SSR
 * worker bundle and lazily code-split) and swaps in the SVG. FAIL-SOFT: any parse/render error keeps
 * the code block visible instead of blanking the page (guardrail #2).
 */
import { useEffect, useRef, useState } from "react"
import { THEME_EVENT } from "../lib/theme"

let seq = 0

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Bumped on every app theme switch so the diagram re-renders in the new palette (mermaid bakes the
  // theme into the SVG at render time; without this an already-rendered diagram would stay stale).
  const [themeEpoch, setThemeEpoch] = useState(0)

  useEffect(() => {
    const onTheme = () => setThemeEpoch((n) => n + 1)
    window.addEventListener(THEME_EVENT, onTheme)
    return () => window.removeEventListener(THEME_EVENT, onTheme)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: themeEpoch re-runs the render on theme switch
  useEffect(() => {
    let cancelled = false
    seq += 1
    const id = `mermaid-${seq}`
    import("mermaid")
      .then(async (mod) => {
        const mermaid = mod.default
        // Match the active app theme: the light-editorial "paper" theme pairs with mermaid's
        // "neutral"; the dark "carbon"/phosphor "terminal" themes pair with "dark".
        const mermaidTheme = document.documentElement.dataset.theme === "paper" ? "neutral" : "dark"
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme })
        const { svg: out } = await mermaid.render(id, chart)
        if (!cancelled) setSvg(out)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [chart, themeEpoch])

  if (svg !== null && !failed) {
    return (
      <div
        ref={ref}
        className="my-4 flex justify-center"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output, rendered with securityLevel:'strict'
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }
  // SSR + pre-hydration + fail-soft: show the source as a code block.
  return (
    <pre className="my-4 overflow-x-auto rounded-ui border border-border bg-raised p-4 font-mono text-sm">
      <code>{chart}</code>
    </pre>
  )
}

/**
 * Client-only Mermaid diagram. SSR renders the raw ```mermaid code block (no diagram); after
 * hydration a `useEffect` dynamically imports mermaid (a big, browser-only lib — kept out of the SSR
 * worker bundle and lazily code-split) and swaps in the SVG. FAIL-SOFT: any parse/render error keeps
 * the code block visible instead of blanking the page (guardrail #2).
 */
import { useEffect, useRef, useState } from "react"

let seq = 0

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    seq += 1
    const id = `mermaid-${seq}`
    import("mermaid")
      .then(async (mod) => {
        const mermaid = mod.default
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" })
        const { svg: out } = await mermaid.render(id, chart)
        if (!cancelled) setSvg(out)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [chart])

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
    <pre className="my-4 overflow-x-auto rounded-md border border-neutral-100 bg-neutral-50 p-4 font-mono text-sm">
      <code>{chart}</code>
    </pre>
  )
}

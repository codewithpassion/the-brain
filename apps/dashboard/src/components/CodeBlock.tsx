/**
 * Client-only syntax highlighting. SSR renders plain `<pre><code>` (structure only); after hydration
 * a `useEffect` lazily imports highlight.js (kept out of the SSR worker path, code-split as its own
 * client chunk) and highlights the element in place. FAIL-SOFT: if the import or highlight throws,
 * the plain code stays readable (guardrail #2).
 */
import { useEffect, useRef } from "react"

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    const el = ref.current
    if (el == null) return
    import("highlight.js")
      .then((mod) => {
        if (cancelled || ref.current == null) return
        const hljs = mod.default
        try {
          const res =
            lang && hljs.getLanguage(lang)
              ? hljs.highlight(code, { language: lang })
              : hljs.highlightAuto(code)
          ref.current.innerHTML = res.value
          ref.current.classList.add("hljs")
        } catch {
          // fail-soft: leave the plain text
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [code, lang])

  return (
    <pre className="my-4 overflow-x-auto rounded-ui border border-border bg-raised p-4 text-sm leading-relaxed">
      <code ref={ref} className={lang ? `language-${lang} font-mono` : "font-mono"}>
        {code}
      </code>
    </pre>
  )
}

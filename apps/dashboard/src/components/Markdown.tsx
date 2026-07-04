/**
 * The wiki markdown renderer (v3/W4a — VIEW mode). Deliberately independent of the editor kit
 * (TipTap lands in Phase 5): react-markdown + remark-gfm for structure, a small `remarkWikiLinks`
 * transform for `[[wikilinks]]`, and client-only enhancers for code highlighting + Mermaid.
 *
 * Wikilink resolution (guardrail #1): every internal link's slug is computed with the store-parity
 * `normalizeLinkTarget`, then matched against the page's `pending` slug set — pending → RED "create"
 * link, resolved → normal router link to `/wiki/<slug>`. External/mailto/anchor links stay plain.
 */
import { Link } from "@tanstack/react-router"
import type { ComponentProps } from "react"
import { useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"
import { remarkWikiLinks, resolveWikiHref } from "../lib/wikilink"
import { CodeBlock } from "./CodeBlock"
import { Mermaid } from "./Mermaid"

const isExternal = (href: string): boolean =>
  /^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")

// Minimal hast shapes for reading fenced-code blocks off the `pre` node.
interface HastNode {
  type?: string
  tagName?: string
  value?: string
  properties?: { className?: string[] | string }
  children?: HastNode[]
}

/** Concatenate the text content of a hast node (for pulling raw code out of a `pre > code`). */
const hastText = (node: HastNode | undefined): string =>
  node == null
    ? ""
    : node.type === "text"
      ? (node.value ?? "")
      : (node.children ?? []).map(hastText).join("")

/** The fenced language of a `pre`'s `<code>` child (`language-xxx`), if any. */
const codeLang = (pre: HastNode | undefined): string | undefined => {
  const code = (pre?.children ?? []).find((c) => c.tagName === "code")
  const cls = code?.properties?.className
  const s = Array.isArray(cls) ? cls.join(" ") : (cls ?? "")
  return /language-([\w-]+)/.exec(s)?.[1]
}

export function Markdown({ body, pending }: { body: string; pending: string[] }) {
  const pendingSet = useMemo(() => new Set(pending), [pending])

  const components = useMemo<Components>(
    () => ({
      // `pre` ALWAYS wraps a fenced block — read the code + language straight off the hast node, so
      // block detection is reliable even for a one-line, no-language fence (the old heuristic mis-fired
      // and rendered those inline). CodeBlock/Mermaid own their own container.
      pre: (props) => {
        const node = props.node as HastNode | undefined
        const code = (node?.children ?? []).find((c) => c.tagName === "code")
        const text = hastText(code).replace(/\n$/, "")
        const lang = codeLang(node)
        if (lang === "mermaid") return <Mermaid chart={text} />
        return <CodeBlock code={text} {...(lang ? { lang } : {})} />
      },
      // `code` now only ever renders INLINE code (fenced blocks are handled by `pre`).
      code: ({ children }) => (
        <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em]">
          {children}
        </code>
      ),
      a: ({ href, children }: ComponentProps<"a">) => {
        const raw = href ?? ""
        const resolved = resolveWikiHref(raw, pendingSet)
        if (resolved.kind === "external") {
          return (
            <a
              href={raw}
              {...(isExternal(raw) ? { target: "_blank", rel: "noreferrer" } : {})}
              className="text-blue-700 underline decoration-blue-300 hover:decoration-blue-600"
            >
              {children}
            </a>
          )
        }
        const isPending = resolved.kind === "pending"
        return (
          <Link
            to="/wiki/$"
            params={{ _splat: resolved.slug }}
            title={isPending ? `Create page: ${resolved.slug}` : resolved.slug}
            className={
              isPending
                ? "text-red-600 underline decoration-dotted decoration-red-400 hover:text-red-700"
                : "text-blue-700 underline decoration-blue-300 hover:decoration-blue-600"
            }
          >
            {children}
          </Link>
        )
      },
    }),
    [pendingSet],
  )

  return (
    <div className="wiki-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiLinks]}
        rehypePlugins={[rehypeSlug]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}

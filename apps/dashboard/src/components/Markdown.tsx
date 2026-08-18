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
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"
import { remarkWikiLinks, resolveWikiHref } from "../lib/wikilink"
import { CodeBlock } from "./CodeBlock"
import { Mermaid } from "./Mermaid"
import { toast } from "./Toaster"

const isExternal = (href: string): boolean =>
  /^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")

// Minimal hast shapes for reading fenced-code blocks off the `pre` node.
interface HastNode {
  type?: string
  tagName?: string
  value?: string
  properties?: { className?: string[] | string; id?: string }
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

/** The heading tags rehype-slug assigns an `id` to. */
type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6"

/**
 * One heading renderer shared across h1–h6. It renders the rehype-slug `id` VERBATIM (so deep-link
 * anchors + the scroll target match, including github-slugger's `-1` dedup ids) with NO wrapper
 * element — the `.wiki-prose hN` styles select the bare tag. A trailing copy-link button, hidden
 * until the heading is hovered (`group`/`group-hover`), copies the section's absolute URL, toasts,
 * and updates the address bar in place (no scroll jump).
 */
const makeHeading = (Tag: HeadingTag) => {
  function Heading(props: ComponentProps<"h1"> & ExtraProps) {
    const { children } = props
    const node = props.node as HastNode | undefined
    const id = props.id ?? node?.properties?.id
    const heading = hastText(node)
    return (
      <Tag id={id} className="group">
        {children}
        {id !== undefined && (
          <a
            href={`#${id}`}
            onClick={(e) => {
              e.preventDefault()
              navigator.clipboard
                .writeText(`${location.origin}${location.pathname}#${id}`)
                .then(() => toast("Copied!"))
              history.replaceState(null, "", `#${id}`)
            }}
            aria-label={`Copy link to "${heading}" section`}
            className="ml-2 text-muted no-underline opacity-0 transition group-hover:opacity-100 hover:text-accent"
          >
            #
          </a>
        )}
      </Tag>
    )
  }
  return Heading
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
        <code className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      ),
      h1: makeHeading("h1"),
      h2: makeHeading("h2"),
      h3: makeHeading("h3"),
      h4: makeHeading("h4"),
      h5: makeHeading("h5"),
      h6: makeHeading("h6"),
      a: ({ href, children }: ComponentProps<"a">) => {
        const raw = href ?? ""
        const resolved = resolveWikiHref(raw, pendingSet)
        if (resolved.kind === "external") {
          return (
            <a
              href={raw}
              {...(isExternal(raw) ? { target: "_blank", rel: "noreferrer" } : {})}
              className="text-accent underline decoration-accent/40 hover:decoration-accent/60"
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
            {...(resolved.hash !== undefined ? { hash: resolved.hash } : {})}
            title={isPending ? `Create page: ${resolved.slug}` : resolved.slug}
            className={
              isPending
                ? "text-danger underline decoration-dotted decoration-danger/40 hover:text-danger"
                : "text-accent underline decoration-accent/40 hover:decoration-accent/60"
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

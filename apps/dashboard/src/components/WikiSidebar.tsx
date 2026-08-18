/**
 * Wiki sidebar tree (W4a → UI v2). Builds a collapsible namespace tree from the flat
 * `wiki_list_pages` listing (slugs split on `/`), with dedicated **Entities** (entities/*) and
 * **Memory** (ingested_via='memory') sections. Expansion is controlled React state keyed per
 * section+path, seeded so every ancestor of the active route is open on mount and re-opened on
 * navigation (expand-only — a user's manual collapse of a non-ancestor survives route changes).
 * `buildTree`/`ancestorsOf` are exported as pure helpers for unit testing.
 */
import { Link, useParams } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "../lib/utils"
import type { WikiListEntry } from "../server/types"
import { ICONS } from "./icons"

export interface TreeNode {
  /** Last path segment (the raw name shown when no page/title exists here). */
  name: string
  /** Accumulated slug path for this node (e.g. `a/b`) — always present, even for pageless nodes. */
  path: string
  /** The page entry when a page exists exactly at `path`; null for a pure namespace node. */
  entry: WikiListEntry | null
  /** Direct children, already sorted (namespaces first, then alpha by segment name). */
  children: TreeNode[]
}

interface BuildNode {
  name: string
  path: string
  entry: WikiListEntry | null
  children: Map<string, BuildNode>
}

const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
  nodes.sort((a, b) => {
    const an = a.children.length > 0 ? 0 : 1
    const bn = b.children.length > 0 ? 0 : 1
    return an !== bn ? an - bn : a.name.localeCompare(b.name)
  })

/** Build a namespace tree from a flat listing. Pure: no React, no DOM. */
export function buildTree(entries: WikiListEntry[]): TreeNode[] {
  const root: BuildNode = { name: "", path: "", entry: null, children: new Map() }
  for (const entry of entries) {
    const segments = entry.slug.split("/").filter((s) => s.length > 0)
    let cur = root
    let acc = ""
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] ?? ""
      acc = acc === "" ? seg : `${acc}/${seg}`
      let child = cur.children.get(seg)
      if (!child) {
        child = { name: seg, path: acc, entry: null, children: new Map() }
        cur.children.set(seg, child)
      }
      if (i === segments.length - 1) child.entry = entry
      cur = child
    }
  }
  const finalize = (n: BuildNode): TreeNode => ({
    name: n.name,
    path: n.path,
    entry: n.entry,
    children: sortNodes([...n.children.values()].map(finalize)),
  })
  return sortNodes([...root.children.values()].map(finalize))
}

/** Every ancestor prefix of a slug, including the slug itself (`a/b/c` → `a`, `a/b`, `a/b/c`). */
export function ancestorsOf(slug: string): string[] {
  const segments = slug.split("/").filter((s) => s.length > 0)
  const out: string[] = []
  let acc = ""
  for (const seg of segments) {
    acc = acc === "" ? seg : `${acc}/${seg}`
    out.push(acc)
  }
  return out
}

const key = (section: string, path: string): string => `${section}:${path}`

function TreeRow({
  node,
  section,
  expanded,
  toggle,
  activeSlug,
  activeRef,
}: {
  node: TreeNode
  section: string
  expanded: Set<string>
  toggle: (k: string) => void
  activeSlug: string
  activeRef: React.RefObject<HTMLDivElement | null>
}) {
  const isNamespace = node.children.length > 0
  const label = node.entry?.title || node.name
  const open = isNamespace && expanded.has(key(section, node.path))
  const isActive = node.path === activeSlug
  const isAncestor = !isActive && activeSlug.startsWith(`${node.path}/`)
  const count = node.entry?.childCount ?? node.children.length

  const rowColor = isActive ? "text-accent" : isAncestor ? "text-ink" : "text-muted"
  const iconColor = isActive ? "text-accent" : "text-faint"

  return (
    <div>
      <div
        ref={isActive ? activeRef : undefined}
        className={cn(
          "flex items-center rounded pr-1 text-sm hover:bg-raised",
          rowColor,
          isActive && "bg-accent/15",
        )}
      >
        {isNamespace ? (
          <button
            type="button"
            onClick={() => toggle(key(section, node.path))}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
            className="flex h-6 w-5 shrink-0 items-center justify-center text-faint hover:text-ink"
          >
            <span className={cn("transition-transform", open && "rotate-90")}>{ICONS.chevron}</span>
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <Link
          to="/wiki/$"
          params={{ _splat: node.path }}
          title={node.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1"
        >
          <span className={cn("shrink-0", iconColor)}>
            {isNamespace ? ICONS.folder : ICONS.page}
          </span>
          <span className="truncate">{label}</span>
          {node.entry?.draft && (
            <span className="shrink-0 rounded-full border border-warn/25 bg-warn/12 px-1.5 py-0 font-medium text-[10px] text-warn">
              draft
            </span>
          )}
        </Link>
        {isNamespace && !open && count > 0 && (
          <span className="shrink-0 rounded-full bg-raised px-1.5 py-0 text-[10px] text-faint tabular-nums">
            {count}
          </span>
        )}
      </div>
      {isNamespace && open && (
        <div className="ml-2 border-edge/40 border-l pl-2">
          {node.children.map((child) => (
            <TreeRow
              key={child.name}
              node={child}
              section={section}
              expanded={expanded}
              toggle={toggle}
              activeSlug={activeSlug}
              activeRef={activeRef}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  nodes,
  ...rest
}: {
  title: string
  nodes: TreeNode[]
  expanded: Set<string>
  toggle: (k: string) => void
  activeSlug: string
  activeRef: React.RefObject<HTMLDivElement | null>
}) {
  if (nodes.length === 0) return null
  return (
    <div className="mb-4">
      <h3 className="mb-1 px-1 font-semibold text-faint text-xs uppercase tracking-wide">
        {title}
      </h3>
      {nodes.map((n) => (
        <TreeRow key={n.name} node={n} section={title} {...rest} />
      ))}
    </div>
  )
}

const SECTIONS = ["Pages", "Entities", "Memory", "Drafts"] as const

export function WikiSidebar({ pages }: { pages: WikiListEntry[] }) {
  const trees = useMemo(() => {
    const docs: WikiListEntry[] = []
    const entities: WikiListEntry[] = []
    const memory: WikiListEntry[] = []
    const drafts: WikiListEntry[] = []
    for (const p of pages) {
      // A draft is routed ONLY to the Drafts section (an unpublished page, wherever it lives).
      if (p.draft) drafts.push(p)
      else if (p.slug.startsWith("entities/")) entities.push(p)
      else if (p.ingestedVia === "memory") memory.push(p)
      else docs.push(p)
    }
    return {
      Pages: buildTree(docs),
      Entities: buildTree(entities),
      Memory: buildTree(memory),
      Drafts: buildTree(drafts),
    }
  }, [pages])

  // Depth-0 namespaces are open by default (as the old native <details open={depth<1}> did).
  const defaultOpen = useMemo(() => {
    const s = new Set<string>()
    for (const section of SECTIONS) {
      for (const n of trees[section]) if (n.children.length > 0) s.add(key(section, n.path))
    }
    return s
  }, [trees])

  const activeSlug = useParams({ strict: false })._splat ?? ""

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set(defaultOpen)
    // Ancestor keys for every section — inert for sections that don't hold the node.
    for (const path of ancestorsOf(activeSlug)) for (const sec of SECTIONS) s.add(key(sec, path))
    return s
  })

  // Expand-only on navigation: open the active page's ancestors without collapsing user choices.
  useEffect(() => {
    const paths = ancestorsOf(activeSlug)
    if (paths.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const path of paths)
        for (const sec of SECTIONS) {
          const k = key(sec, path)
          if (!next.has(k)) {
            next.add(k)
            changed = true
          }
        }
      return changed ? next : prev
    })
  }, [activeSlug])

  const activeRef = useRef<HTMLDivElement | null>(null)
  // Bring the active row into view on first mount (ancestors are already seeded open above).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const shared = { expanded, toggle, activeSlug, activeRef }

  return (
    <nav aria-label="Wiki navigation" className="text-sm">
      <Link
        to="/wiki"
        activeOptions={{ exact: true }}
        className="mb-3 block rounded px-2 py-1 font-semibold text-ink hover:bg-raised"
        activeProps={{
          className: "mb-3 block rounded px-2 py-1 font-semibold bg-accent/15 text-accent",
        }}
      >
        🏠 Wiki home
      </Link>
      <Link
        to="/wiki/$"
        params={{ _splat: "untitled" }}
        search={{ new: true }}
        className="mb-3 block rounded border border-border px-2 py-1 text-center text-muted text-xs hover:bg-raised"
      >
        + New page
      </Link>
      {pages.length === 0 ? (
        <p className="px-1 text-faint text-xs">No pages yet.</p>
      ) : (
        SECTIONS.map((section) => (
          <Section key={section} title={section} nodes={trees[section]} {...shared} />
        ))
      )}
    </nav>
  )
}

/**
 * Wiki sidebar tree (W4a). Builds a collapsible namespace tree from the flat `wiki_list_pages`
 * listing (slugs split on `/`), with dedicated **Entities** (entities/*) and **Memory**
 * (ingested_via='memory') sections. Uses native `<details>`/`<summary>` so it collapses without
 * client JS and stays keyboard-navigable. Large trees: the listing is capped server-side (limit
 * 500) and deep branches render collapsed — a fuller lazy-load lands with edit mode if needed.
 */
import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import type { WikiListEntry } from "../server/types"

interface TreeNode {
  name: string
  slug: string | null
  entry: WikiListEntry | null
  children: Map<string, TreeNode>
}

const newNode = (name: string): TreeNode => ({ name, slug: null, entry: null, children: new Map() })

const insert = (root: TreeNode, entry: WikiListEntry): void => {
  const segments = entry.slug.split("/").filter((s) => s.length > 0)
  let cur = root
  let acc = ""
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? ""
    acc = acc === "" ? seg : `${acc}/${seg}`
    let child = cur.children.get(seg)
    if (!child) {
      child = newNode(seg)
      cur.children.set(seg, child)
    }
    if (i === segments.length - 1) {
      child.slug = entry.slug
      child.entry = entry
    } else if (child.slug === null) {
      child.slug = acc // a namespace node that may not itself be a page
    }
    cur = child
  }
}

const sortChildren = (node: TreeNode): TreeNode[] =>
  [...node.children.values()].sort((a, b) => {
    // namespaces (have children) first, then leaf pages; alpha within each.
    const an = a.children.size > 0 ? 0 : 1
    const bn = b.children.size > 0 ? 0 : 1
    return an !== bn ? an - bn : a.name.localeCompare(b.name)
  })

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const kids = sortChildren(node)
  const label = node.entry?.title || node.name
  const pad = { paddingLeft: `${depth * 0.75 + 0.5}rem` }

  if (kids.length === 0) {
    // Leaf page.
    return (
      <Link
        to="/wiki/$"
        params={{ _splat: node.slug ?? "" }}
        style={pad}
        className="block truncate rounded py-1 pr-2 text-muted text-sm hover:bg-raised"
        activeProps={{
          className: "block truncate rounded py-1 pr-2 text-sm bg-accent/15 text-accent",
        }}
        title={node.slug ?? undefined}
      >
        {label}
      </Link>
    )
  }

  return (
    <details open={depth < 1} className="group">
      <summary
        style={pad}
        className="flex cursor-pointer list-none items-center gap-1 rounded py-1 pr-2 text-muted text-sm hover:bg-raised"
      >
        <span className="inline-block w-3 text-faint transition-transform group-open:rotate-90">
          ▸
        </span>
        {node.slug ? (
          <Link
            to="/wiki/$"
            params={{ _splat: node.slug }}
            className="truncate font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </Link>
        ) : (
          <span className="truncate font-medium">{label}</span>
        )}
      </summary>
      <div>
        {kids.map((k) => (
          <TreeRow key={k.name} node={k} depth={depth + 1} />
        ))}
      </div>
    </details>
  )
}

function Section({ title, entries }: { title: string; entries: WikiListEntry[] }) {
  const root = useMemo(() => {
    const r = newNode(title)
    for (const e of entries) insert(r, e)
    return r
  }, [title, entries])
  if (entries.length === 0) return null
  return (
    <div className="mb-4">
      <h3 className="mb-1 px-1 font-semibold text-faint text-xs uppercase tracking-wide">
        {title}
      </h3>
      {sortChildren(root).map((k) => (
        <TreeRow key={k.name} node={k} depth={0} />
      ))}
    </div>
  )
}

export function WikiSidebar({ pages }: { pages: WikiListEntry[] }) {
  const { entities, memory, docs, drafts } = useMemo(() => {
    const entities: WikiListEntry[] = []
    const memory: WikiListEntry[] = []
    const docs: WikiListEntry[] = []
    const drafts: WikiListEntry[] = []
    for (const p of pages) {
      // A draft is routed ONLY to the Drafts section (an unpublished page, wherever it lives).
      if (p.draft) drafts.push(p)
      else if (p.slug.startsWith("entities/")) entities.push(p)
      else if (p.ingestedVia === "memory") memory.push(p)
      else docs.push(p)
    }
    return { entities, memory, docs, drafts }
  }, [pages])

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
        <>
          <Section title="Pages" entries={docs} />
          <Section title="Entities" entries={entities} />
          <Section title="Memory" entries={memory} />
          <Section title="Drafts" entries={drafts} />
        </>
      )}
    </nav>
  )
}

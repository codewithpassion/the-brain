/**
 * Graph — entity explorer backed by list_entities / list_entity_edges / search_entities /
 * traverse_graph / find_orphans. Initial load uses the loader; search and traversal are
 * interactive state.
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { EntityGraph } from "../components/EntityGraph"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import {
  addGraphLink,
  addGraphTag,
  findOrphans,
  getEntities,
  getEntityEdges,
  searchEntities,
  traverseGraph,
} from "../server/fns"
import type { Entity, FindOrphansResult, TraversalResult } from "../server/types"

export const Route = createFileRoute("/graph")({
  loader: async () => ({
    entities: await getEntities(),
    edges: await getEntityEdges(),
  }),
  component: () => (
    <RequireAuth>
      <GraphPage />
    </RequireAuth>
  ),
})

function GraphPage() {
  const { entities, edges } = Route.useLoaderData()
  const [query, setQuery] = useState("")
  const [searchList, setSearchList] = useState<Entity[] | null>(null)
  const [orphanResult, setOrphanResult] = useState<FindOrphansResult | null>(null)
  const [selected, setSelected] = useState<Entity | null>(null)
  const [traversal, setTraversal] = useState<TraversalResult | null>(null)
  const [traversalLoading, setTraversalLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [orphanLoading, setOrphanLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const baseList = entities.ok ? entities.data.entities : []
  const edgesData = edges.ok ? edges.data.edges : []
  const displayList = searchList ?? baseList

  const onSearch = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    setError(null)
    setOrphanResult(null)
    if (q.length === 0) {
      setSearchList(null)
      return
    }
    setLoading(true)
    const res = await searchEntities({ data: { query: q } })
    if (res.ok) {
      setSearchList(res.data.entities)
    } else {
      setError(res.error)
      setSearchList(null)
    }
    setLoading(false)
  }

  const onSelect = async (entity: Entity) => {
    setSelected(entity)
    setTraversal(null)
    setTraversalLoading(true)
    const res = await traverseGraph({ data: { seedId: entity.id } })
    if (res.ok) {
      setTraversal(res.data)
    }
    setTraversalLoading(false)
  }

  const onFindOrphans = async () => {
    setOrphanLoading(true)
    setError(null)
    setSearchList(null)
    setSelected(null)
    setTraversal(null)
    const res = await findOrphans()
    if (res.ok) {
      setOrphanResult(res.data)
    } else {
      setError(res.error)
    }
    setOrphanLoading(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Graph</h1>
        <p className="text-muted text-sm">
          Explore entities, traverse links, and find orphaned nodes.
        </p>
      </header>

      {(entities.ok || searchList !== null) && (
        <Card>
          <CardHeader>
            <CardTitle>
              Entity graph ({baseList.length}
              {baseList.length !== 1 ? " entities" : " entity"})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EntityGraph entities={baseList} edges={edgesData} onNodeSelect={onSelect} />
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <form onSubmit={onSearch} className="flex flex-1 gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search entities…"
            aria-label="Entity search"
          />
          <Button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </Button>
        </form>
        <Button variant="outline" onClick={onFindOrphans} disabled={orphanLoading}>
          {orphanLoading ? "Loading…" : "Find orphans"}
        </Button>
      </div>

      {error !== null && (
        <Card>
          <CardContent className="py-4 text-danger text-sm">Error: {error}</CardContent>
        </Card>
      )}

      {!entities.ok && searchList === null && orphanResult === null && (
        <Card>
          <CardContent className="py-4 text-muted text-sm">
            Entity list unavailable: {entities.error}
          </CardContent>
        </Card>
      )}

      {orphanResult !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Orphaned entities ({orphanResult.orphans.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <EntityTable entities={orphanResult.orphans} onSelect={onSelect} />
          </CardContent>
        </Card>
      )}

      {orphanResult === null && (entities.ok || searchList !== null) && (
        <Card>
          <CardHeader>
            <CardTitle>
              {searchList !== null
                ? `Results (${searchList.length})`
                : `All entities (${displayList.length})`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EntityTable entities={displayList} onSelect={onSelect} />
          </CardContent>
        </Card>
      )}

      <CurateCard />

      {selected !== null && (
        <Card>
          <CardHeader>
            <CardTitle>
              Neighbors of <span className="font-mono">{selected.name}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {traversalLoading ? (
              <p className="text-muted text-sm">Loading…</p>
            ) : traversal === null ? (
              <p className="text-muted text-sm">No traversal data.</p>
            ) : traversal.paths.length === 0 ? (
              <p className="text-muted text-sm">No neighbors found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="pb-1 font-medium">ID</th>
                      <th className="pb-1 font-medium">Relation</th>
                      <th className="pb-1 font-medium">Depth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traversal.paths.map((p, i) => {
                      const otherId = p.from_id === selected.id ? p.to_id : p.from_id
                      const other = baseList.find((e) => e.id === otherId)
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: paths have no stable key
                        <tr key={i} className="border-border border-t">
                          <td className="py-1.5 font-mono text-xs">
                            {other?.name ?? otherId.slice(0, 8)}
                          </td>
                          <td className="py-1.5">
                            <Badge variant="outline">{p.link_type}</Badge>
                          </td>
                          <td className="py-1.5 text-muted">{p.depth}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * Curate — the W4.4 manual doc-graph write surface (add_tag / add_link). Operates on doc-graph
 * PAGES named by slug or id (distinct from the entity list above), so the inputs are free-text
 * node references. Minimal affordance: two small forms that call the write ops and report the
 * outcome inline (matches the screen's Card/Input/Button style; no new framework).
 */
function CurateCard() {
  const [tagTarget, setTagTarget] = useState("")
  const [tag, setTag] = useState("")
  const [tagMsg, setTagMsg] = useState<string | null>(null)
  const [tagBusy, setTagBusy] = useState(false)

  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [linkType, setLinkType] = useState("")
  const [linkMsg, setLinkMsg] = useState<string | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)

  const onAddTag = async (event: FormEvent) => {
    event.preventDefault()
    setTagBusy(true)
    setTagMsg(null)
    const res = await addGraphTag({ data: { target: tagTarget.trim(), tag: tag.trim() } })
    setTagMsg(res.ok ? `Tagged ${res.data.pageId} with "${res.data.tag}".` : `Error: ${res.error}`)
    if (res.ok) setTag("")
    setTagBusy(false)
  }

  const onAddLink = async (event: FormEvent) => {
    event.preventDefault()
    setLinkBusy(true)
    setLinkMsg(null)
    const res = await addGraphLink({
      data: { from: from.trim(), to: to.trim(), linkType: linkType.trim() },
    })
    setLinkMsg(res.ok ? `Linked ${res.data.fromId} → ${res.data.toId}.` : `Error: ${res.error}`)
    setLinkBusy(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Curate (doc graph)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={onAddTag} className="flex flex-col gap-2">
          <p className="font-medium text-muted text-sm">Add tag to a page</p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={tagTarget}
              onChange={(e) => setTagTarget(e.target.value)}
              placeholder="page slug or id"
              aria-label="Tag target page"
              className="flex-1"
            />
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="tag"
              aria-label="Tag"
              className="flex-1"
            />
            <Button
              type="submit"
              disabled={tagBusy || tagTarget.trim() === "" || tag.trim() === ""}
            >
              {tagBusy ? "Adding…" : "Add tag"}
            </Button>
          </div>
          {tagMsg !== null && <p className="text-muted text-sm">{tagMsg}</p>}
        </form>

        <form onSubmit={onAddLink} className="flex flex-col gap-2">
          <p className="font-medium text-muted text-sm">Add link between pages</p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="from slug or id"
              aria-label="Link source page"
              className="flex-1"
            />
            <Input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="to slug or id"
              aria-label="Link target page"
              className="flex-1"
            />
            <Input
              value={linkType}
              onChange={(e) => setLinkType(e.target.value)}
              placeholder="type (optional)"
              aria-label="Link type"
              className="flex-1"
            />
            <Button type="submit" disabled={linkBusy || from.trim() === "" || to.trim() === ""}>
              {linkBusy ? "Linking…" : "Add link"}
            </Button>
          </div>
          {linkMsg !== null && <p className="text-muted text-sm">{linkMsg}</p>}
        </form>
      </CardContent>
    </Card>
  )
}

function EntityTable({
  entities,
  onSelect,
}: {
  entities: Entity[]
  onSelect: (entity: Entity) => void
}) {
  if (entities.length === 0) {
    return <p className="text-muted text-sm">No entities found.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-faint">
            <th className="pb-1 font-medium">Name</th>
            <th className="pb-1 font-medium">Kind</th>
            <th className="pb-1 font-medium">Mentions</th>
            <th className="pb-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {entities.map((e) => (
            <tr key={e.id} className="border-border border-t">
              <td className="py-1.5 font-mono text-xs">{e.name}</td>
              <td className="py-1.5">
                <Badge variant="outline">{e.kind}</Badge>
              </td>
              <td className="py-1.5 text-muted">{e.mentionCount}</td>
              <td className="py-1.5">
                <Button variant="ghost" size="sm" onClick={() => onSelect(e)}>
                  Explore
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

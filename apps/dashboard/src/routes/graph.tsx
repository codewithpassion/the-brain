/**
 * Graph — entity explorer backed by list_entities / search_entities / traverse_graph / find_orphans.
 * Initial load uses the loader; search and traversal are interactive state.
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { EntityGraph } from "../components/EntityGraph"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { findOrphans, getEntities, searchEntities, traverseGraph } from "../server/fns"
import type { Entity, FindOrphansResult, TraversalResult } from "../server/types"

export const Route = createFileRoute("/graph")({
  loader: async () => ({
    entities: await getEntities(),
  }),
  component: () => (
    <RequireAuth>
      <GraphPage />
    </RequireAuth>
  ),
})

function GraphPage() {
  const { entities } = Route.useLoaderData()
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
        <p className="text-neutral-500 text-sm">
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
            <EntityGraph entities={baseList} onNodeSelect={onSelect} />
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
          <CardContent className="py-4 text-red-600 text-sm">Error: {error}</CardContent>
        </Card>
      )}

      {!entities.ok && searchList === null && orphanResult === null && (
        <Card>
          <CardContent className="py-4 text-neutral-500 text-sm">
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

      {selected !== null && (
        <Card>
          <CardHeader>
            <CardTitle>
              Neighbors of <span className="font-mono">{selected.name}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {traversalLoading ? (
              <p className="text-neutral-500 text-sm">Loading…</p>
            ) : traversal === null ? (
              <p className="text-neutral-500 text-sm">No traversal data.</p>
            ) : traversal.neighbors.length === 0 ? (
              <p className="text-neutral-500 text-sm">No neighbors found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
                    <th className="pb-1 font-medium">Name</th>
                    <th className="pb-1 font-medium">Kind</th>
                    <th className="pb-1 font-medium">Relation</th>
                  </tr>
                </thead>
                <tbody>
                  {traversal.neighbors.map((n) => (
                    <tr key={n.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 font-mono text-xs">{n.name}</td>
                      <td className="py-1.5">
                        <Badge variant="outline">{n.kind}</Badge>
                      </td>
                      <td className="py-1.5 text-neutral-600">{n.relation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
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
    return <p className="text-neutral-500 text-sm">No entities found.</p>
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-neutral-400">
          <th className="pb-1 font-medium">Name</th>
          <th className="pb-1 font-medium">Kind</th>
          <th className="pb-1 font-medium">Mentions</th>
          <th className="pb-1 font-medium" />
        </tr>
      </thead>
      <tbody>
        {entities.map((e) => (
          <tr key={e.id} className="border-neutral-100 border-t">
            <td className="py-1.5 font-mono text-xs">{e.name}</td>
            <td className="py-1.5">
              <Badge variant="outline">{e.kind}</Badge>
            </td>
            <td className="py-1.5 text-neutral-600">{e.mentionCount}</td>
            <td className="py-1.5">
              <Button variant="ghost" size="sm" onClick={() => onSelect(e)}>
                Explore
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

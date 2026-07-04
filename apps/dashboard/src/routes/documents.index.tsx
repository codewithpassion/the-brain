/**
 * Documents — real document catalog via list_documents, with filter controls (tag, path, date
 * range) and an optional content search box.
 */
import { createFileRoute, Link } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { getDocuments, listDocuments } from "../server/fns"
import type { DerivedDocument, DocumentRow } from "../server/types"

export const Route = createFileRoute("/documents/")({
  loader: async () => ({
    docs: await getDocuments({ data: {} }),
  }),
  component: () => (
    <RequireAuth>
      <DocumentsPage />
    </RequireAuth>
  ),
})

function docStatusVariant(s: string): "default" | "secondary" | "outline" | "warning" {
  if (s === "ready") return "default"
  if (s === "processing") return "secondary"
  if (s === "error" || s === "failed") return "warning"
  return "outline"
}

function DocumentsPage() {
  const { docs: initialDocs } = Route.useLoaderData()

  // Catalog state
  const [docs, setDocs] = useState(initialDocs)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  // Filter state
  const [tagFilter, setTagFilter] = useState("")
  const [pathFilter, setPathFilter] = useState("")
  const [since, setSince] = useState("")
  const [until, setUntil] = useState("")

  // Content search state
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<DerivedDocument[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)

  // Build a filter data object using only the truthy values to satisfy exactOptionalPropertyTypes.
  const buildFilterData = (t: string, p: string, s: string, u: string) => ({
    ...(t ? { tag: t } : {}),
    ...(p ? { path: p } : {}),
    ...(s ? { since: s } : {}),
    ...(u ? { until: u } : {}),
  })

  const applyFilters = async (overrides?: {
    tag?: string
    path?: string
    since?: string
    until?: string
  }) => {
    setCatalogLoading(true)
    setCatalogError(null)
    const t = overrides?.tag !== undefined ? overrides.tag : tagFilter.trim()
    const p = overrides?.path !== undefined ? overrides.path : pathFilter.trim()
    const s = overrides?.since !== undefined ? overrides.since : since
    const u = overrides?.until !== undefined ? overrides.until : until
    const res = await getDocuments({ data: buildFilterData(t, p, s, u) })
    if (res.ok) {
      setDocs(res)
    } else {
      setCatalogError(res.error)
    }
    setCatalogLoading(false)
  }

  const onFilterSubmit = async (e: FormEvent) => {
    e.preventDefault()
    await applyFilters()
  }

  const clearFilters = async () => {
    setTagFilter("")
    setPathFilter("")
    setSince("")
    setUntil("")
    setCatalogLoading(true)
    setCatalogError(null)
    const res = await getDocuments({ data: {} })
    if (res.ok) setDocs(res)
    else setCatalogError(res.error)
    setCatalogLoading(false)
  }

  // Click a tag badge → set tag filter and fetch (override with just the tag; rest from state)
  const onTagClick = async (tag: string) => {
    setTagFilter(tag)
    await applyFilters({ tag })
  }

  // Click a path → set path filter and fetch (override with just the path; rest from state)
  const onPathClick = async (p: string) => {
    setPathFilter(p)
    await applyFilters({ path: p })
  }

  const onSearch = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (q.length === 0 || searchLoading) return
    setSearchLoading(true)
    setSearchError(null)
    const res = await listDocuments({ data: { query: q } })
    if (res.ok) {
      setHits(res.data)
    } else {
      setSearchError(res.error)
      setHits(null)
    }
    setSearchLoading(false)
  }

  const hasActiveFilters = tagFilter.trim() || pathFilter.trim() || since || until

  const docList: DocumentRow[] = docs.ok ? docs.data.documents : []

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Documents</h1>
        <p className="text-muted text-sm">Ingested document catalog.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Documents ({docs.ok ? docList.length : 0})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Filter controls */}
          <form onSubmit={onFilterSubmit} className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1 min-w-36">
              <label htmlFor="filter-tag" className="text-muted text-xs font-medium">
                Tag
              </label>
              <Input
                id="filter-tag"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                placeholder="e.g. architecture"
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1 min-w-36">
              <label htmlFor="filter-path" className="text-muted text-xs font-medium">
                Path prefix
              </label>
              <Input
                id="filter-path"
                value={pathFilter}
                onChange={(e) => setPathFilter(e.target.value)}
                placeholder="/project/x"
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-since" className="text-muted text-xs font-medium">
                Since
              </label>
              <Input
                id="filter-since"
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-until" className="text-muted text-xs font-medium">
                Until
              </label>
              <Input
                id="filter-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <Button type="submit" disabled={catalogLoading} className="h-8 text-sm">
              {catalogLoading ? "Loading…" : "Apply"}
            </Button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="h-8 px-3 text-sm text-muted hover:text-ink"
              >
                Clear
              </button>
            )}
          </form>

          {catalogError !== null && <p className="text-danger text-sm">Error: {catalogError}</p>}

          {docs.ok ? (
            docList.length === 0 ? (
              <p className="text-muted text-sm">No documents found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="pb-1 font-medium">Slug</th>
                      <th className="pb-1 font-medium">Title</th>
                      <th className="pb-1 font-medium">Status</th>
                      <th className="pb-1 font-medium">Chunks</th>
                      <th className="pb-1 font-medium">Tags</th>
                      <th className="pb-1 font-medium">Path</th>
                      <th className="pb-1 font-medium">Added by</th>
                      <th className="pb-1 font-medium">Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docList.map((doc) => (
                      <tr key={doc.id} className="border-border border-t">
                        <td className="py-1.5 font-mono text-xs">
                          <Link
                            to="/documents/$id"
                            params={{ id: doc.id }}
                            className="hover:underline"
                          >
                            {doc.slug}
                          </Link>
                        </td>
                        <td className="py-1.5 text-muted">
                          <Link
                            to="/documents/$id"
                            params={{ id: doc.id }}
                            className="hover:underline"
                          >
                            {doc.title !== "" ? doc.title : "—"}
                          </Link>
                        </td>
                        <td className="py-1.5">
                          <Badge variant={docStatusVariant(doc.status)}>{doc.status}</Badge>
                        </td>
                        <td className="py-1.5 text-muted">{doc.chunkCount}</td>
                        <td className="py-1.5">
                          {doc.tags && doc.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {doc.tags.map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => onTagClick(tag)}
                                  className="cursor-pointer"
                                >
                                  <Badge variant="secondary">{tag}</Badge>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td className="py-1.5 font-mono text-xs text-muted">
                          {doc.path ? (
                            <button
                              type="button"
                              onClick={() => onPathClick(doc.path as string)}
                              className="hover:text-ink hover:underline cursor-pointer"
                            >
                              {doc.path}
                            </button>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td className="py-1.5 font-mono text-xs text-muted" title={doc.userId}>
                          {doc.userId.slice(0, 12)}…
                        </td>
                        <td className="py-1.5 text-muted">{doc.createdAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <p className="text-muted text-sm">Unavailable: {docs.error}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Content Search</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={onSearch} className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search document content…"
              aria-label="Content search query"
            />
            <Button type="submit" disabled={searchLoading}>
              {searchLoading ? "Searching…" : "Search"}
            </Button>
          </form>

          {searchError !== null && <p className="text-danger text-sm">Error: {searchError}</p>}

          {hits !== null &&
            (hits.length === 0 ? (
              <p className="text-muted text-sm">No results.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {hits.map((doc) => (
                  <div
                    key={doc.documentId}
                    className="border-border border-b pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex items-center gap-2">
                      <Badge>{doc.slug}</Badge>
                      <span className="text-faint text-xs">
                        {doc.hitCount} chunk(s) · top {doc.topScore.toFixed(4)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-muted text-sm">{doc.snippet}</p>
                  </div>
                ))}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  )
}

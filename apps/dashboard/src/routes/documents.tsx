/**
 * Documents — real document catalog via list_documents, with an optional search box for content lookup.
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { getDocuments, listDocuments } from "../server/fns"
import type { DerivedDocument } from "../server/types"

export const Route = createFileRoute("/documents")({
  loader: async () => ({
    docs: await getDocuments(),
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
  const { docs } = Route.useLoaderData()
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<DerivedDocument[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onSearch = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (q.length === 0 || loading) return
    setLoading(true)
    setSearchError(null)
    const res = await listDocuments({ data: { query: q } })
    if (res.ok) {
      setHits(res.data)
    } else {
      setSearchError(res.error)
      setHits(null)
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Documents</h1>
        <p className="text-neutral-500 text-sm">Ingested document catalog.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Documents ({docs.ok ? docs.data.documents.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {docs.ok ? (
            docs.data.documents.length === 0 ? (
              <p className="text-neutral-500 text-sm">No documents found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
                    <th className="pb-1 font-medium">Slug</th>
                    <th className="pb-1 font-medium">Title</th>
                    <th className="pb-1 font-medium">Status</th>
                    <th className="pb-1 font-medium">Chunks</th>
                    <th className="pb-1 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.data.documents.map((doc) => (
                    <tr key={doc.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 font-mono text-xs">{doc.slug}</td>
                      <td className="py-1.5 text-neutral-700">
                        {doc.title !== "" ? doc.title : "—"}
                      </td>
                      <td className="py-1.5">
                        <Badge variant={docStatusVariant(doc.status)}>{doc.status}</Badge>
                      </td>
                      <td className="py-1.5 text-neutral-600">{doc.chunkCount}</td>
                      <td className="py-1.5 text-neutral-600">{doc.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-neutral-500 text-sm">Unavailable: {docs.error}</p>
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
            <Button type="submit" disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </Button>
          </form>

          {searchError !== null && <p className="text-red-600 text-sm">Error: {searchError}</p>}

          {hits !== null &&
            (hits.length === 0 ? (
              <p className="text-neutral-500 text-sm">No results.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {hits.map((doc) => (
                  <div
                    key={doc.documentId}
                    className="border-neutral-100 border-b pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex items-center gap-2">
                      <Badge>{doc.slug}</Badge>
                      <span className="text-neutral-400 text-xs">
                        {doc.hitCount} chunk(s) · top {doc.topScore.toFixed(4)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-neutral-700 text-sm">{doc.snippet}</p>
                  </div>
                ))}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  )
}

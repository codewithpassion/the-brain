/**
 * Documents (CORE, REAL — with an honest v1 limitation). The brain's v1 op-registry exposes NO
 * list-documents op, so this view DERIVES documents from a `search`: it folds the hits into distinct
 * documents (best score + a representative snippet per document). It therefore lists documents
 * MATCHING a query, not the full catalog — stated plainly in the UI. A true catalog op is a vN
 * follow-up on the API side.
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { listDocuments } from "../server/fns"
import type { DerivedDocument } from "../server/types"

export const Route = createFileRoute("/documents")({
  component: DocumentsPage,
})

function DocumentsPage() {
  const [query, setQuery] = useState("")
  const [docs, setDocs] = useState<DerivedDocument[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (q.length === 0 || loading) return
    setLoading(true)
    setError(null)
    const response = await listDocuments({ data: { query: q } })
    if (response.ok) {
      setDocs(response.data)
    } else {
      setError(response.error)
      setDocs(null)
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Documents</h1>
        <p className="text-neutral-500 text-sm">
          Ingested documents matching a query.{" "}
          <span className="text-neutral-400">
            v1 derives this from search — the API exposes no list-documents op yet.
          </span>
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the corpus (e.g. canary, ingestion, scope)"
          aria-label="Document query"
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>

      {error !== null && (
        <Card>
          <CardContent className="py-4 text-red-600 text-sm">Request failed: {error}</CardContent>
        </Card>
      )}

      {docs !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{docs.length} document(s)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {docs.length === 0 && <p className="text-neutral-500 text-sm">No documents matched.</p>}
            {docs.map((doc) => (
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
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * Search / Think (CORE, REAL) — a query box that calls the `think` op and renders the full envelope:
 * the synthesized answer, the cited evidence, the citation list, and any gaps/warnings the pipeline
 * reports. All data comes from the live API via the `think` server fn (credential + tenant attached
 * server-side).
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { think } from "../server/fns"
import type { ThinkResult } from "../server/types"

export const Route = createFileRoute("/")({
  component: () => (
    <RequireAuth>
      <SearchPage />
    </RequireAuth>
  ),
})

function SearchPage() {
  const [query, setQuery] = useState("")
  const [namespace, setNamespace] = useState("")
  const [result, setResult] = useState<ThinkResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (q.length === 0 || loading) return
    setLoading(true)
    setError(null)
    const ns = namespace.trim()
    const response = await think({ data: { query: q, ...(ns ? { path: ns } : {}) } })
    if (response.ok) {
      setResult(response.data)
    } else {
      setError(response.error)
      setResult(null)
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Search / Think</h1>
        <p className="text-muted text-sm">
          Ask a question — the brain retrieves cited evidence and synthesizes a grounded answer.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. What did we decide about the isolation canary?"
            aria-label="Question"
          />
          <Button type="submit" disabled={loading}>
            {loading ? "Thinking…" : "Think"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            placeholder="Path / namespace (optional, e.g. /project/x)"
            aria-label="Path namespace"
            className="max-w-72 h-8 text-sm"
          />
          {namespace && <span className="text-faint text-xs">scoped to {namespace}</span>}
        </div>
      </form>

      {error !== null && (
        <Card>
          <CardContent className="py-4 text-danger text-sm">Request failed: {error}</CardContent>
        </Card>
      )}

      {result !== null && <ThinkView result={result} />}
    </div>
  )
}

function ThinkView({ result }: { result: ThinkResult }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Answer</CardTitle>
        </CardHeader>
        <CardContent>
          {result.answer.length > 0 ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.answer}</p>
          ) : (
            <p className="text-muted text-sm">No synthesized answer was produced.</p>
          )}
          {result.warnings.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {result.warnings.map((w) => (
                <Badge key={w} variant="warning">
                  {w}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Evidence ({result.evidence.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {result.evidence.length === 0 && (
            <p className="text-muted text-sm">No matching evidence.</p>
          )}
          {result.evidence.map((hit) => (
            <div key={hit.id} className="border-border border-b pb-3 last:border-0 last:pb-0">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{hit.slug}</Badge>
                <span className="text-faint text-xs">score {hit.score.toFixed(4)}</span>
              </div>
              <p className="mt-1.5 text-muted text-sm">{hit.snippet}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {result.citations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Citations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {result.citations.map((c) => (
              <Badge key={c.chunkId} variant="secondary">
                {c.slug}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {result.gaps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Gaps</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 text-muted text-sm">
              {result.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

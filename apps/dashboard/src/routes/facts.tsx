/**
 * Facts browser — browse hot-memory facts (id/fact/kind) with filters, forget per row.
 * Route: /facts
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { toast } from "../components/Toaster"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { forgetFact, recallBrowse } from "../server/fns"
import type { FactItem } from "../server/types"

export const Route = createFileRoute("/facts")({
  loader: async () => ({
    facts: await recallBrowse({ data: { limit: 100 } }),
  }),
  component: () => (
    <RequireAuth>
      <FactsPage />
    </RequireAuth>
  ),
})

function FactsPage() {
  const { facts: initial } = Route.useLoaderData()
  const [facts, setFacts] = useState(initial)
  const [loading, setLoading] = useState(false)

  // Filter state
  const [query, setQuery] = useState("")
  const [entitySlug, setEntitySlug] = useState("")
  const [since, setSince] = useState("")
  const [includeSuperseded, setIncludeSuperseded] = useState(false)

  const loadFacts = async (overrides?: {
    query?: string
    entitySlug?: string
    since?: string
    includeSuperseded?: boolean
  }) => {
    setLoading(true)
    const q = overrides?.query !== undefined ? overrides.query : query.trim()
    const e = overrides?.entitySlug !== undefined ? overrides.entitySlug : entitySlug.trim()
    const s = overrides?.since !== undefined ? overrides.since : since
    const inc =
      overrides?.includeSuperseded !== undefined ? overrides.includeSuperseded : includeSuperseded
    const res = await recallBrowse({
      data: {
        ...(q ? { query: q } : {}),
        ...(e ? { entitySlug: e } : {}),
        ...(s ? { since: s } : {}),
        // One "show hidden" toggle reveals BOTH lineage axes (op flags stay separate — D5).
        ...(inc ? { includeSuperseded: true, includeSoftExpired: true } : {}),
        limit: 100,
      },
    })
    if (res.ok) setFacts(res)
    else toast(`Load failed: ${res.error}`)
    setLoading(false)
  }

  const onFilterSubmit = async (e: FormEvent) => {
    e.preventDefault()
    await loadFacts()
  }

  const clearFilters = async () => {
    setQuery("")
    setEntitySlug("")
    setSince("")
    setIncludeSuperseded(false)
    const res = await recallBrowse({ data: { limit: 100 } })
    if (res.ok) setFacts(res)
    else toast(`Load failed: ${res.error}`)
  }

  const handleFactForgotten = (factId: number) => {
    if (facts.ok) {
      setFacts({
        ...facts,
        data: { facts: facts.data.facts.filter((f) => f.id !== factId) },
      })
    }
  }

  const factList: FactItem[] = facts.ok ? facts.data.facts : []
  const hasFilters = query.trim() || entitySlug.trim() || since || includeSuperseded

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Facts</h1>
        <p className="text-muted text-sm">Hot-memory facts extracted from sessions.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Facts ({facts.ok ? factList.length : 0})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Filter controls */}
          <form onSubmit={onFilterSubmit} className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1 min-w-48">
              <label htmlFor="fact-query" className="text-muted text-xs font-medium">
                Keyword
              </label>
              <Input
                id="fact-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search facts…"
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1 min-w-36">
              <label htmlFor="fact-entity" className="text-muted text-xs font-medium">
                Entity slug
              </label>
              <Input
                id="fact-entity"
                value={entitySlug}
                onChange={(e) => setEntitySlug(e.target.value)}
                placeholder="e.g. alice"
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="fact-since" className="text-muted text-xs font-medium">
                Since
              </label>
              <Input
                id="fact-since"
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <label className="flex h-8 items-center gap-1.5 text-muted text-xs">
              <input
                type="checkbox"
                checked={includeSuperseded}
                onChange={(e) => {
                  setIncludeSuperseded(e.target.checked)
                  void loadFacts({ includeSuperseded: e.target.checked })
                }}
              />
              Include superseded
            </label>
            <Button type="submit" disabled={loading} className="h-8 text-sm">
              {loading ? "Loading…" : "Apply"}
            </Button>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="h-8 px-3 text-sm text-muted hover:text-ink"
              >
                Clear
              </button>
            )}
          </form>

          {!facts.ok && <p className="text-muted text-sm">Unavailable: {facts.error}</p>}

          {facts.ok &&
            (factList.length === 0 ? (
              <p className="text-muted text-sm">No facts found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="pb-1 font-medium">ID</th>
                      <th className="pb-1 font-medium">Kind</th>
                      <th className="pb-1 font-medium">Fact</th>
                      <th className="pb-1 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {factList.map((f) => (
                      <tr key={f.id} className="border-border border-t">
                        <td className="py-1.5 font-mono text-xs text-faint">{f.id}</td>
                        <td className="py-1.5">
                          <Badge variant="outline">{f.kind}</Badge>
                        </td>
                        <td className="py-1.5 text-muted">
                          {f.fact}
                          {f.consolidatedInto != null && (
                            <Badge variant="outline" className="ml-2 text-faint">
                              consolidated → #{f.consolidatedInto}
                            </Badge>
                          )}
                          {f.supersededBy != null && (
                            <Badge variant="outline" className="ml-2 text-faint">
                              superseded → #{f.supersededBy}
                            </Badge>
                          )}
                        </td>
                        <td className="py-1.5">
                          <ForgetButton
                            factId={f.id}
                            onForgotten={() => handleFactForgotten(f.id)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  )
}

function ForgetButton({ factId, onForgotten }: { factId: number; onForgotten: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [forgetting, setForgetting] = useState(false)

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-muted">Forget?</span>
        <button
          type="button"
          disabled={forgetting}
          onClick={async () => {
            setForgetting(true)
            const res = await forgetFact({ data: { factId } })
            if (res.ok) {
              toast(`Fact ${factId} forgotten.`)
              onForgotten()
            } else {
              toast(`Forget failed: ${res.error}`)
              setConfirming(false)
              setForgetting(false)
            }
          }}
          className="rounded bg-danger px-2 py-0.5 text-accent-ink text-xs hover:bg-danger/90 disabled:opacity-50"
        >
          {forgetting ? "…" : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded border border-border px-2 py-0.5 text-muted text-xs hover:bg-raised"
        >
          No
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded border border-danger/25 px-2 py-0.5 text-danger text-xs hover:bg-danger/10"
    >
      Forget
    </button>
  )
}

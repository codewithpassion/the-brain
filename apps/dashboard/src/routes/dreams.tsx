/**
 * Dreams — the Dream engine dashboard: recent runs (all kinds, with counts + status badges), the
 * latest daily digest (agent/digest/daily), pending contradictions with an inline resolve flow,
 * and the generated insights list. Read-only loads + a minimal write (resolve_contradiction).
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { toast } from "../components/Toaster"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import {
  dreamNow,
  getDocuments,
  getDreamRuns,
  getPendingReviews,
  memoryGet,
  resolveContradiction,
} from "../server/fns"
import { DREAM_KINDS, type DreamKind, type PendingReview } from "../server/types"

export const Route = createFileRoute("/dreams")({
  loader: async () => ({
    runs: await getDreamRuns(),
    digest: await memoryGet({ data: { slug: "agent/digest/daily" } }),
    reviews: await getPendingReviews(),
    insights: await getDocuments({ data: { path: "/brain/insights" } }),
  }),
  component: () => (
    <RequireAuth>
      <DreamsPage />
    </RequireAuth>
  ),
})

function runStatusVariant(s: string): "default" | "secondary" | "outline" | "warning" {
  if (s === "running") return "default"
  if (s === "success") return "secondary"
  if (s === "paused" || s === "failure") return "warning"
  return "outline"
}

function DreamsPage() {
  const { runs, digest, reviews, insights } = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState<PendingReview[]>(reviews.ok ? reviews.data.reviews : [])
  const [kind, setKind] = useState<DreamKind>("all")
  const [dreaming, setDreaming] = useState(false)

  const runDream = async () => {
    setDreaming(true)
    const res = await dreamNow({ data: { kind } })
    setDreaming(false)
    if (res.ok) {
      toast(`Dream '${kind}' dispatched — run ${res.data.runId} (${res.data.status}).`)
      await router.invalidate() // re-run the loader so the runs table shows the new run
    } else {
      toast(`Dream failed: ${res.error}`)
    }
  }

  const resolve = async (
    reviewId: string,
    input: { action: "keep"; keepFactId: number } | { action: "dismiss" },
  ) => {
    const res = await resolveContradiction({ data: { reviewId, ...input } })
    if (res.ok) {
      toast(input.action === "dismiss" ? "Contradiction dismissed." : "Contradiction resolved.")
      setPending((rows) => rows.filter((r) => r.reviewId !== reviewId))
    } else {
      toast(`Resolve failed: ${res.error}`)
    }
  }

  // The op already returns only the /brain/insights namespace.
  const insightDocs = insights.ok ? insights.data.documents : []

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Dreams</h1>
          <p className="text-muted text-sm">
            Nightly consolidation, reflection, and the daily digest.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DreamKind)}
            disabled={dreaming}
            className="rounded border border-border bg-transparent px-2 py-1 text-ink text-sm disabled:opacity-40"
          >
            {DREAM_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void runDream()}
            disabled={dreaming}
            className="rounded border border-accent/30 px-3 py-1 text-accent text-sm hover:bg-accent/10 disabled:opacity-40"
          >
            {dreaming ? "Dreaming…" : "Dream now"}
          </button>
        </div>
      </header>

      {/* Latest digest */}
      <Card>
        <CardHeader>
          <CardTitle>Latest digest</CardTitle>
        </CardHeader>
        <CardContent>
          {digest.ok && digest.data.memory ? (
            <pre className="whitespace-pre-wrap font-sans text-muted text-sm">
              {digest.data.memory.body}
            </pre>
          ) : (
            <p className="text-muted text-sm">
              No digest yet — it is written by the nightly run (agent/digest/daily).
            </p>
          )}
        </CardContent>
      </Card>

      {/* Pending contradictions */}
      <Card>
        <CardHeader>
          <CardTitle>Pending contradictions ({pending.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!reviews.ok && <p className="text-muted text-sm">Unavailable: {reviews.error}</p>}
          {reviews.ok && pending.length === 0 && (
            <p className="text-muted text-sm">No contradictions awaiting review.</p>
          )}
          {pending.map((r) => (
            <div key={r.reviewId} className="rounded border border-border p-3">
              {r.rationale && <p className="mb-2 text-muted text-sm italic">{r.rationale}</p>}
              <div className="flex flex-col gap-2">
                {r.facts.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3">
                    <span className="text-ink text-sm">
                      <span className="font-mono text-faint text-xs">#{f.id}</span> {f.fact}
                    </span>
                    {/* 'Keep this' expires the OTHER facts — disabled when some facts are hidden. */}
                    <button
                      type="button"
                      disabled={r.redactedCount > 0}
                      onClick={() => void resolve(r.reviewId, { action: "keep", keepFactId: f.id })}
                      className="shrink-0 rounded border border-ok/25 px-2 py-0.5 text-ok text-xs hover:bg-ok/10 disabled:opacity-40"
                    >
                      Keep this
                    </button>
                  </div>
                ))}
              </div>
              {r.redactedCount > 0 && (
                <p className="mt-1 text-faint text-xs">
                  {r.redactedCount} conflicting fact(s) hidden from you — resolve requires full
                  visibility.
                </p>
              )}
              <button
                type="button"
                onClick={() => void resolve(r.reviewId, { action: "dismiss" })}
                className="mt-2 rounded border border-border px-2 py-0.5 text-muted text-xs hover:bg-raised"
              >
                Dismiss
              </button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Recent dream runs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent runs ({runs.ok ? runs.data.runs.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.ok ? (
            runs.data.runs.length === 0 ? (
              <p className="text-muted text-sm">No dream runs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="pb-1 font-medium">Kind</th>
                      <th className="pb-1 font-medium">Status</th>
                      <th className="pb-1 font-medium">Merged</th>
                      <th className="pb-1 font-medium">Contradictions</th>
                      <th className="pb-1 font-medium">Examined</th>
                      <th className="pb-1 font-medium">Pairs</th>
                      <th className="pb-1 font-medium">Skipped</th>
                      <th className="pb-1 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.data.runs.map((run) => (
                      <tr key={run.id} className="border-border border-t">
                        <td className="py-1.5 text-muted">{run.kind}</td>
                        <td className="py-1.5">
                          <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                        </td>
                        <td className="py-1.5 text-muted">{run.merged}</td>
                        <td className="py-1.5 text-muted">{run.contradictions}</td>
                        <td className="py-1.5 text-muted">{run.entitiesExamined}</td>
                        <td className="py-1.5 text-muted">{run.pairsExamined}</td>
                        <td className="py-1.5 text-muted">{run.skipped}</td>
                        <td className="py-1.5 text-muted">{run.updatedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <p className="text-muted text-sm">Unavailable: {runs.error}</p>
          )}
        </CardContent>
      </Card>

      {/* Insights */}
      <Card>
        <CardHeader>
          <CardTitle>Insights ({insightDocs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {!insights.ok && <p className="text-muted text-sm">Unavailable: {insights.error}</p>}
          {insights.ok && insightDocs.length === 0 && (
            <p className="text-muted text-sm">No insights generated yet.</p>
          )}
          <ul className="flex flex-col gap-1">
            {insightDocs.map((d) => (
              <li key={d.id}>
                <Link
                  to="/documents/$id"
                  params={{ id: d.id }}
                  className="text-accent text-sm hover:underline"
                >
                  {d.title || d.slug}
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

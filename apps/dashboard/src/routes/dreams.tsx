/**
 * Dreams — the Dream engine dashboard: recent runs (all kinds, with counts + status badges), the
 * latest daily digest (agent/digest/daily), pending contradictions with an inline resolve flow,
 * and the generated insights list. Read-only loads + a minimal write (resolve_contradiction).
 */
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { toast } from "../components/Toaster"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import {
  getDocuments,
  getDreamRuns,
  getPendingReviews,
  memoryGet,
  resolveContradiction,
} from "../server/fns"
import type { PendingReview } from "../server/types"

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
  const [pending, setPending] = useState<PendingReview[]>(reviews.ok ? reviews.data.reviews : [])

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
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Dreams</h1>
        <p className="text-neutral-500 text-sm">
          Nightly consolidation, reflection, and the daily digest.
        </p>
      </header>

      {/* Latest digest */}
      <Card>
        <CardHeader>
          <CardTitle>Latest digest</CardTitle>
        </CardHeader>
        <CardContent>
          {digest.ok && digest.data.memory ? (
            <pre className="whitespace-pre-wrap font-sans text-neutral-700 text-sm">
              {digest.data.memory.body}
            </pre>
          ) : (
            <p className="text-neutral-500 text-sm">
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
          {!reviews.ok && <p className="text-neutral-500 text-sm">Unavailable: {reviews.error}</p>}
          {reviews.ok && pending.length === 0 && (
            <p className="text-neutral-500 text-sm">No contradictions awaiting review.</p>
          )}
          {pending.map((r) => (
            <div key={r.reviewId} className="rounded border border-neutral-200 p-3">
              {r.rationale && <p className="mb-2 text-neutral-600 text-sm italic">{r.rationale}</p>}
              <div className="flex flex-col gap-2">
                {r.facts.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3">
                    <span className="text-neutral-800 text-sm">
                      <span className="font-mono text-neutral-400 text-xs">#{f.id}</span> {f.fact}
                    </span>
                    {/* 'Keep this' expires the OTHER facts — disabled when some facts are hidden. */}
                    <button
                      type="button"
                      disabled={r.redactedCount > 0}
                      onClick={() => void resolve(r.reviewId, { action: "keep", keepFactId: f.id })}
                      className="shrink-0 rounded border border-green-200 px-2 py-0.5 text-green-700 text-xs hover:bg-green-50 disabled:opacity-40"
                    >
                      Keep this
                    </button>
                  </div>
                ))}
              </div>
              {r.redactedCount > 0 && (
                <p className="mt-1 text-neutral-400 text-xs">
                  {r.redactedCount} conflicting fact(s) hidden from you — resolve requires full
                  visibility.
                </p>
              )}
              <button
                type="button"
                onClick={() => void resolve(r.reviewId, { action: "dismiss" })}
                className="mt-2 rounded border border-neutral-200 px-2 py-0.5 text-neutral-500 text-xs hover:bg-neutral-50"
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
              <p className="text-neutral-500 text-sm">No dream runs yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
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
                    <tr key={run.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 text-neutral-700">{run.kind}</td>
                      <td className="py-1.5">
                        <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                      </td>
                      <td className="py-1.5 text-neutral-600">{run.merged}</td>
                      <td className="py-1.5 text-neutral-600">{run.contradictions}</td>
                      <td className="py-1.5 text-neutral-600">{run.entitiesExamined}</td>
                      <td className="py-1.5 text-neutral-600">{run.pairsExamined}</td>
                      <td className="py-1.5 text-neutral-600">{run.skipped}</td>
                      <td className="py-1.5 text-neutral-600">{run.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-neutral-500 text-sm">Unavailable: {runs.error}</p>
          )}
        </CardContent>
      </Card>

      {/* Insights */}
      <Card>
        <CardHeader>
          <CardTitle>Insights ({insightDocs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {!insights.ok && (
            <p className="text-neutral-500 text-sm">Unavailable: {insights.error}</p>
          )}
          {insights.ok && insightDocs.length === 0 && (
            <p className="text-neutral-500 text-sm">No insights generated yet.</p>
          )}
          <ul className="flex flex-col gap-1">
            {insightDocs.map((d) => (
              <li key={d.id}>
                <Link
                  to="/documents/$id"
                  params={{ id: d.id }}
                  className="text-blue-600 text-sm hover:underline"
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

/**
 * Jobs — list_backfill_runs table with status badges.
 */
import { createFileRoute } from "@tanstack/react-router"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { getBackfillRuns, getDreamRuns } from "../server/fns"

export const Route = createFileRoute("/jobs")({
  loader: async () => ({
    runs: await getBackfillRuns(),
    dreamRuns: await getDreamRuns(),
  }),
  component: () => (
    <RequireAuth>
      <JobsPage />
    </RequireAuth>
  ),
})

function jobStatusVariant(s: string): "default" | "secondary" | "outline" | "warning" {
  if (s === "running") return "default"
  if (s === "done") return "secondary"
  if (s === "failed" || s === "error") return "warning"
  return "outline"
}

function JobsPage() {
  const { runs, dreamRuns } = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Jobs</h1>
        <p className="text-neutral-500 text-sm">Backfill, re-embed, and Dream run status.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Dream runs ({dreamRuns.ok ? dreamRuns.data.runs.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {dreamRuns.ok ? (
            dreamRuns.data.runs.length === 0 ? (
              <p className="text-neutral-500 text-sm">No dream runs yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
                    <th className="pb-1 font-medium">Kind</th>
                    <th className="pb-1 font-medium">Status</th>
                    <th className="pb-1 font-medium">Clusters</th>
                    <th className="pb-1 font-medium">Merged</th>
                    <th className="pb-1 font-medium">Superseded</th>
                    <th className="pb-1 font-medium">Contradictions</th>
                    <th className="pb-1 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {dreamRuns.data.runs.map((run) => (
                    <tr key={run.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 text-neutral-700">dream · {run.kind}</td>
                      <td className="py-1.5">
                        <Badge variant={jobStatusVariant(run.status)}>{run.status}</Badge>
                      </td>
                      <td className="py-1.5 text-neutral-600">{run.clustersJudged}</td>
                      <td className="py-1.5 text-neutral-600">{run.merged}</td>
                      <td className="py-1.5 text-neutral-600">{run.superseded}</td>
                      <td className="py-1.5 text-neutral-600">{run.contradictions}</td>
                      <td className="py-1.5 text-neutral-600">{run.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-neutral-500 text-sm">Unavailable: {dreamRuns.error}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backfill runs ({runs.ok ? runs.data.runs.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.ok ? (
            runs.data.runs.length === 0 ? (
              <p className="text-neutral-500 text-sm">No backfill runs found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
                    <th className="pb-1 font-medium">Source</th>
                    <th className="pb-1 font-medium">Kind</th>
                    <th className="pb-1 font-medium">Direction</th>
                    <th className="pb-1 font-medium">Status</th>
                    <th className="pb-1 font-medium">Attempts</th>
                    <th className="pb-1 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.runs.map((run) => (
                    <tr key={run.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 font-mono text-xs">{run.sourceId}</td>
                      <td className="py-1.5 text-neutral-700">{run.kind}</td>
                      <td className="py-1.5 text-neutral-600">{run.direction}</td>
                      <td className="py-1.5">
                        <Badge variant={jobStatusVariant(run.status)}>{run.status}</Badge>
                      </td>
                      <td className="py-1.5 text-neutral-600">{run.attempts}</td>
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
    </div>
  )
}

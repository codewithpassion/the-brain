/**
 * Jobs — list_backfill_runs table with status badges.
 */
import { createFileRoute } from "@tanstack/react-router"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { getBackfillRuns } from "../server/fns"

export const Route = createFileRoute("/jobs")({
  loader: async () => ({
    runs: await getBackfillRuns(),
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
  const { runs } = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Jobs</h1>
        <p className="text-muted text-sm">Backfill and re-embed run status.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Backfill runs ({runs.ok ? runs.data.runs.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.ok ? (
            runs.data.runs.length === 0 ? (
              <p className="text-muted text-sm">No backfill runs found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-faint">
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
                      <tr key={run.id} className="border-border border-t">
                        <td className="py-1.5 font-mono text-xs">{run.sourceId}</td>
                        <td className="py-1.5 text-muted">{run.kind}</td>
                        <td className="py-1.5 text-muted">{run.direction}</td>
                        <td className="py-1.5">
                          <Badge variant={jobStatusVariant(run.status)}>{run.status}</Badge>
                        </td>
                        <td className="py-1.5 text-muted">{run.attempts}</td>
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
    </div>
  )
}

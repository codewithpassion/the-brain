/**
 * Audit log — list_audit table, newest first.
 */
import { createFileRoute } from "@tanstack/react-router"
import { RequireAuth } from "../components/RequireAuth"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { getAudit } from "../server/fns"

export const Route = createFileRoute("/audit")({
  loader: async () => ({
    audit: await getAudit(),
  }),
  component: () => (
    <RequireAuth>
      <AuditPage />
    </RequireAuth>
  ),
})

function AuditPage() {
  const { audit } = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Audit log</h1>
        <p className="text-muted text-sm">
          Append-only record of memory operations and recall traces, newest first.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Entries ({audit.ok ? audit.data.entries.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {audit.ok ? (
            audit.data.entries.length === 0 ? (
              <p className="text-muted text-sm">No audit entries found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="pb-1 font-medium">When</th>
                      <th className="pb-1 font-medium">User</th>
                      <th className="pb-1 font-medium">Action</th>
                      <th className="pb-1 font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.entries.map((entry) => (
                      <tr key={entry.id} className="border-border border-t">
                        <td className="py-1.5 text-muted">{entry.at}</td>
                        <td className="py-1.5 font-mono text-xs">{entry.userId}</td>
                        <td className="py-1.5 text-muted">{entry.action}</td>
                        <td className="py-1.5 font-mono text-xs text-muted">{entry.targetId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <p className="text-muted text-sm">Unavailable: {audit.error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

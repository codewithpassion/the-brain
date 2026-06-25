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
        <p className="text-neutral-500 text-sm">
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
              <p className="text-neutral-500 text-sm">No audit entries found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
                    <th className="pb-1 font-medium">When</th>
                    <th className="pb-1 font-medium">User</th>
                    <th className="pb-1 font-medium">Action</th>
                    <th className="pb-1 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.entries.map((entry) => (
                    <tr key={entry.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 text-neutral-600">{entry.at}</td>
                      <td className="py-1.5 font-mono text-xs">{entry.userId}</td>
                      <td className="py-1.5 text-neutral-700">{entry.action}</td>
                      <td className="py-1.5 font-mono text-xs text-neutral-600">
                        {entry.targetId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-neutral-500 text-sm">Unavailable: {audit.error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

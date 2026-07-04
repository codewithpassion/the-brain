/**
 * Admin / Stats (CORE, REAL) — `get_token_spend` (monthly AI spend vs the $400 ceiling) and
 * `memberships` (this tenant's membership rows). Both are admin ops; the dogfood user is owner of
 * their own `org_${userId}`, so they resolve. Each cell degrades to its error string if the API is
 * down or the principal lacks admin. Scale-headroom (D1 size / vector counts) is NOT yet exposed by
 * any op — shown as an honest placeholder rather than a fabricated number.
 */
import { createFileRoute } from "@tanstack/react-router"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { getBrainStats, getMemberships, getSessionInfo, getTokenSpend } from "../server/fns"
import type { BrainSessionInfo, BrainStats, MembershipsResult, TokenSpend } from "../server/types"

export const Route = createFileRoute("/stats")({
  loader: async () => ({
    spend: await getTokenSpend(),
    members: await getMemberships(),
    session: await getSessionInfo(),
    stats: await getBrainStats(),
  }),
  component: () => (
    <RequireAuth>
      <StatsPage />
    </RequireAuth>
  ),
})

function StatsPage() {
  const { spend, members, session, stats } = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Admin / Stats</h1>
        <p className="text-muted text-sm">
          Cost ceiling enforcement, memberships, and scale headroom for the active tenant.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <SpendCard spend={spend} session={session.ok ? session.data : null} />
        <StatsCountsCard stats={stats} />
      </div>

      <MembersCard members={members} />
    </div>
  )
}

type Maybe<T> = { ok: true; data: T } | { ok: false; error: string }

function SpendCard({
  spend,
  session,
}: {
  spend: Maybe<TokenSpend>
  session: BrainSessionInfo | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Token spend</CardTitle>
        <CardDescription>
          {session !== null ? (
            <>
              tenant <span className="font-mono">{session.tenant}</span>
            </>
          ) : (
            "active tenant"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {spend.ok ? (
          <div className="flex flex-col gap-1 text-sm">
            <Row label="Window" value={spend.data.window} />
            <Row label="Neurons" value={spend.data.neurons.toLocaleString()} />
            <Row label="USD spent" value={`$${spend.data.usd.toFixed(2)}`} />
            <Row label="Ceiling" value={`$${spend.data.ceilingUsd.toFixed(2)}`} />
            <div className="mt-2">
              <Badge variant={spend.data.usd >= spend.data.ceilingUsd ? "warning" : "secondary"}>
                {((spend.data.usd / spend.data.ceilingUsd) * 100).toFixed(1)}% of ceiling
              </Badge>
            </div>
          </div>
        ) : (
          <p className="text-muted text-sm">Unavailable: {spend.error}</p>
        )}
      </CardContent>
    </Card>
  )
}

function StatsCountsCard({ stats }: { stats: Maybe<BrainStats> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scale headroom</CardTitle>
        <CardDescription>Corpus counts from get_stats</CardDescription>
      </CardHeader>
      <CardContent>
        {stats.ok ? (
          <div className="flex flex-col gap-1 text-sm">
            <Row label="Documents" value={stats.data.documents.toLocaleString()} />
            <Row label="Chunks" value={stats.data.chunks.toLocaleString()} />
            <Row label="Entities" value={stats.data.entities.toLocaleString()} />
            <Row label="Sessions" value={stats.data.sessions.toLocaleString()} />
            <Row label="Facts" value={stats.data.facts.toLocaleString()} />
          </div>
        ) : (
          <p className="text-muted text-sm">Unavailable: {stats.error}</p>
        )}
      </CardContent>
    </Card>
  )
}

function MembersCard({ members }: { members: Maybe<MembershipsResult> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memberships</CardTitle>
      </CardHeader>
      <CardContent>
        {members.ok ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-faint">
                  <th className="pb-1 font-medium">User</th>
                  <th className="pb-1 font-medium">Role</th>
                  <th className="pb-1 font-medium">Team</th>
                  <th className="pb-1 font-medium">Scopes</th>
                </tr>
              </thead>
              <tbody>
                {members.data.memberships.map((m) => (
                  <tr key={m.userId} className="border-border border-t">
                    <td className="py-1.5 font-mono text-xs">{m.userId}</td>
                    <td className="py-1.5">
                      <Badge variant="outline">{m.role}</Badge>
                    </td>
                    <td className="py-1.5 text-muted">{m.teamId ?? "—"}</td>
                    <td className="py-1.5 text-muted">{m.allowedScopes ?? "*"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">Unavailable: {members.error}</p>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

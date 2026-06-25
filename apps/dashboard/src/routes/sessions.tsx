/**
 * Sessions — list_sessions table plus an interactive recall search.
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { getSessions, recallQuery } from "../server/fns"
import type { RecallFact } from "../server/types"

export const Route = createFileRoute("/sessions")({
  loader: async () => ({
    sessions: await getSessions(),
  }),
  component: () => (
    <RequireAuth>
      <SessionsPage />
    </RequireAuth>
  ),
})

function sessionStatusVariant(s: string): "default" | "secondary" | "outline" | "warning" {
  if (s === "active") return "default"
  if (s === "closed") return "secondary"
  if (s === "error") return "warning"
  return "outline"
}

function SessionsPage() {
  const { sessions } = Route.useLoaderData()
  const [query, setQuery] = useState("")
  const [facts, setFacts] = useState<RecallFact[] | null>(null)
  const [recallError, setRecallError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onRecall = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (q.length === 0 || loading) return
    setLoading(true)
    setRecallError(null)
    const res = await recallQuery({ data: { query: q } })
    if (res.ok) {
      setFacts(res.data.facts)
    } else {
      setRecallError(res.error)
      setFacts(null)
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Sessions</h1>
        <p className="text-neutral-500 text-sm">
          Active and past conversation sessions, plus recalled facts.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Sessions ({sessions.ok ? sessions.data.sessions.length : 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.ok ? (
            sessions.data.sessions.length === 0 ? (
              <p className="text-neutral-500 text-sm">No sessions found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-400">
                    <th className="pb-1 font-medium">Client</th>
                    <th className="pb-1 font-medium">Title</th>
                    <th className="pb-1 font-medium">Status</th>
                    <th className="pb-1 font-medium">Turns</th>
                    <th className="pb-1 font-medium">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.data.sessions.map((s) => (
                    <tr key={s.id} className="border-neutral-100 border-t">
                      <td className="py-1.5 font-mono text-xs">{s.client}</td>
                      <td className="py-1.5 text-neutral-700">{s.title !== "" ? s.title : "—"}</td>
                      <td className="py-1.5">
                        <Badge variant={sessionStatusVariant(s.status)}>{s.status}</Badge>
                      </td>
                      <td className="py-1.5 text-neutral-600">{s.turnCount}</td>
                      <td className="py-1.5 text-neutral-600">{s.lastActivityAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className="text-neutral-500 text-sm">Unavailable: {sessions.error}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recall</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={onRecall} className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search recalled facts…"
              aria-label="Recall query"
            />
            <Button type="submit" disabled={loading}>
              {loading ? "Recalling…" : "Recall"}
            </Button>
          </form>

          {recallError !== null && <p className="text-red-600 text-sm">Error: {recallError}</p>}

          {facts !== null &&
            (facts.length === 0 ? (
              <p className="text-neutral-500 text-sm">No facts recalled.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {facts.map((f) => (
                  <div
                    key={f.id}
                    className="border-neutral-100 border-b pb-3 last:border-0 last:pb-0"
                  >
                    <p className="text-neutral-700 text-sm">{f.content}</p>
                    {f.score !== undefined && (
                      <span className="text-neutral-400 text-xs">score {f.score.toFixed(4)}</span>
                    )}
                  </div>
                ))}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  )
}

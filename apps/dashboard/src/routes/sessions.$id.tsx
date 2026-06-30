/**
 * Session detail — turns transcript, hot-memory facts, and loaded memories for a session.
 * Route: /sessions/$id  (id IS the brainSessionId)
 */
import { createFileRoute, Link } from "@tanstack/react-router"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { getSessionContext } from "../server/fns"
import type { SessionContextResult } from "../server/types"

export const Route = createFileRoute("/sessions/$id")({
  loader: async ({ params }) => ({
    context: await getSessionContext({ data: { brainSessionId: params.id } }),
  }),
  component: () => (
    <RequireAuth>
      <SessionDetailPage />
    </RequireAuth>
  ),
})

function roleVariant(role: string): "default" | "secondary" | "outline" {
  if (role === "user") return "default"
  if (role === "assistant") return "secondary"
  return "outline"
}

function SessionDetailPage() {
  const { id } = Route.useParams()
  const { context } = Route.useLoaderData()

  if (!context.ok) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <p className="text-red-600 text-sm">Error loading session: {context.error}</p>
      </div>
    )
  }

  const ctx: SessionContextResult = context.data

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Session</h1>
        <p className="mt-0.5 font-mono text-neutral-500 text-sm">{id}</p>
      </header>

      {/* ── Turns transcript ── */}
      <Card>
        <CardHeader>
          <CardTitle>Turns ({ctx.turns.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {ctx.turns.length === 0 ? (
            <p className="text-neutral-500 text-sm">No turns recorded.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {ctx.turns.map((t) => (
                <div
                  key={t.idx}
                  className="border-neutral-100 border-b pb-3 last:border-0 last:pb-0"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-neutral-400 text-xs">#{t.idx}</span>
                    <Badge variant={roleVariant(t.role)}>{t.role}</Badge>
                  </div>
                  {t.content !== null ? (
                    <pre className="whitespace-pre-wrap text-neutral-700 text-sm">{t.content}</pre>
                  ) : (
                    <span className="text-neutral-300 text-sm">— no content —</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Hot-memory facts ── */}
      <Card>
        <CardHeader>
          <CardTitle>Hot-memory facts ({ctx.facts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {ctx.facts.length === 0 ? (
            <p className="text-neutral-500 text-sm">No facts visible to this session.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-400">
                  <th className="pb-1 font-medium">ID</th>
                  <th className="pb-1 font-medium">Kind</th>
                  <th className="pb-1 font-medium">Fact</th>
                </tr>
              </thead>
              <tbody>
                {ctx.facts.map((f) => (
                  <tr key={f.id} className="border-neutral-100 border-t">
                    <td className="py-1.5 font-mono text-xs text-neutral-400">{f.id}</td>
                    <td className="py-1.5">
                      <Badge variant="outline">{f.kind}</Badge>
                    </td>
                    <td className="py-1.5 text-neutral-700">{f.fact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ── Loaded memories (only present when memoryPath was passed) ── */}
      {ctx.memories !== undefined && ctx.memories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Loaded memories ({ctx.memories.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {ctx.memories.map((m) => (
                <div
                  key={m.slug}
                  className="border-neutral-100 border-b pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Link
                      to="/memory/$"
                      params={{ _splat: m.slug }}
                      className="font-mono text-xs hover:underline"
                    >
                      {m.slug}
                    </Link>
                    <Badge variant="secondary">{m.type}</Badge>
                    <span className="text-neutral-400 text-xs">v{m.version}</span>
                  </div>
                  {m.title !== "" && <p className="text-neutral-600 text-sm">{m.title}</p>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/sessions" className="text-neutral-500 text-sm hover:text-neutral-800">
      ← Sessions
    </Link>
  )
}

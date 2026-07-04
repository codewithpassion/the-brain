/**
 * /wiki home (W4a) — a brief intro + recently-updated pages, drawn from the parent layout's already
 * -loaded sidebar listing (no extra fetch). The sidebar tree is the primary navigator.
 */
import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router"
import { ImportBundle } from "../components/ImportBundle"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"

export const Route = createFileRoute("/wiki/")({
  component: WikiHome,
})

function WikiHome() {
  const { pages } = useLoaderData({ from: "/wiki" })
  const recent = [...pages].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 15)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Wiki</h1>
        <p className="mt-1 text-muted text-sm">
          Browse pages, entities, and memory. {pages.length} page{pages.length === 1 ? "" : "s"} in
          this tenant.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recently updated</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted text-sm">
              No pages yet. Agents and the dream engine populate the wiki as they work.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {recent.map((p) => (
                <li key={p.slug} className="flex items-center gap-3 py-2">
                  <Link
                    to="/wiki/$"
                    params={{ _splat: p.slug }}
                    className="min-w-0 flex-1 truncate text-accent text-sm hover:underline"
                    title={p.slug}
                  >
                    {p.title || p.slug}
                  </Link>
                  <Badge variant="outline">{p.type}</Badge>
                  <span className="hidden shrink-0 text-faint text-xs sm:inline">
                    {p.updatedAt.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ImportBundle />
    </div>
  )
}

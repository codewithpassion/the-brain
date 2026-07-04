/**
 * /wiki layout (W4a) — loads the sidebar tree once (wiki_list_pages) and renders the matched child
 * (index at /wiki/, page view at /wiki/$slug) into its Outlet. Two-column on md+, stacked on mobile.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router"
import { RequireAuth } from "../components/RequireAuth"
import { WikiSidebar } from "../components/WikiSidebar"
import { wikiListPages } from "../server/fns"

export const Route = createFileRoute("/wiki")({
  loader: async () => {
    const res = await wikiListPages({ data: { limit: 500 } })
    return { pages: res.ok ? res.data.pages : [] }
  },
  component: WikiLayout,
})

function WikiLayout() {
  const { pages } = Route.useLoaderData()
  return (
    <RequireAuth>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="md:sticky md:top-6 md:max-h-[calc(100vh-3rem)] md:self-start md:overflow-y-auto md:border-neutral-200 md:border-r md:pr-4">
          <WikiSidebar pages={pages} />
        </aside>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </RequireAuth>
  )
}

/**
 * The root route (file-based routing — TanStack Start's plugin generates `routeTree.gen.ts` from this
 * directory; the `bun check` gate runs `tsr generate` first so `tsc --noEmit` sees the tree without
 * needing vite). Renders the full HTML document Start hydrates, wraps the app in Clerk's
 * `<ClerkProvider>`, and paints the shared nav + sign-in control.
 *
 * Auth note (invariant 17): the browser only ever holds a Clerk SESSION (cookie/JWT). The raw API
 * bearer + the server-pinned tenant live ONLY in the `createServerFn` handlers (src/server/brain.ts)
 * — never in client code, never in a loader's client output.
 */
import { ClerkProvider, Show, UserButton } from "@clerk/tanstack-react-start"
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { OrgSwitcher } from "../components/OrgSwitcher"
import { TenantIndicator } from "../components/TenantIndicator"
import { getClientEnv } from "../env"
import appCss from "../styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "The Brain — Dashboard" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
})

const NAV: readonly { to: string; label: string }[] = [
  { to: "/", label: "Search" },
  { to: "/documents", label: "Documents" },
  { to: "/ingest", label: "Add" },
  { to: "/stats", label: "Admin / Stats" },
  { to: "/members", label: "Members" },
  { to: "/api-keys", label: "API Keys" },
  { to: "/graph", label: "Graph" },
  { to: "/sessions", label: "Sessions" },
  { to: "/audit", label: "Audit" },
  { to: "/jobs", label: "Jobs" },
]

function AuthControl() {
  return (
    <>
      <Show when="signed-in">
        <UserButton />
      </Show>
      <Show when="signed-out">
        <Link
          to="/sign-in/$"
          params={{ _splat: "" }}
          className="rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-neutral-700"
        >
          Sign in
        </Link>
      </Show>
    </>
  )
}

function RootComponent() {
  const { VITE_CLERK_PUBLISHABLE_KEY } = getClientEnv()
  return (
    <ClerkProvider publishableKey={VITE_CLERK_PUBLISHABLE_KEY}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </ClerkProvider>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="bg-neutral-50 text-neutral-900">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        <header className="flex items-center gap-4 border-neutral-200 border-b bg-white px-6 py-3">
          <span className="font-semibold text-lg tracking-tight">🧠 The Brain</span>
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100"
                activeProps={{ className: "rounded-md px-3 py-1.5 bg-neutral-900 text-white" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <OrgSwitcher />
            <TenantIndicator />
            <AuthControl />
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
        <Scripts />
      </body>
    </html>
  )
}

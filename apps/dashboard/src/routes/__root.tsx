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
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { NavMenu } from "../components/NavMenu"
import { OrgSwitcher } from "../components/OrgSwitcher"
import { TenantIndicator } from "../components/TenantIndicator"
import { Toaster } from "../components/Toaster"
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

/** Core, daily-use links — always visible inline. */
const PRIMARY_NAV: readonly { to: string; label: string }[] = [
  { to: "/", label: "Search" },
  { to: "/documents", label: "Documents" },
  { to: "/memory", label: "Memory" },
  { to: "/graph", label: "Graph" },
  { to: "/sessions", label: "Sessions" },
  { to: "/ingest", label: "Add" },
]

/** Admin / ops links — grouped under an "Admin" dropdown to keep the bar one clean row. */
const ADMIN_NAV: readonly { to: string; label: string }[] = [
  { to: "/stats", label: "Admin / Stats" },
  { to: "/members", label: "Members" },
  { to: "/api-keys", label: "API Keys" },
  { to: "/vault-sync", label: "Vault Sync" },
  { to: "/audit", label: "Audit" },
  { to: "/jobs", label: "Jobs" },
  { to: "/facts", label: "Facts" },
]

/** Flat list for the mobile menu. */
const NAV: readonly { to: string; label: string }[] = [...PRIMARY_NAV, ...ADMIN_NAV]

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
  const [menuOpen, setMenuOpen] = useState(false)
  const { location } = useRouterState()

  // Close the mobile menu whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is in deps to trigger the close on navigation; setMenuOpen is stable
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  return (
    <html lang="en" className="bg-neutral-50 text-neutral-900">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        <header className="border-neutral-200 border-b bg-white">
          {/* ── Top bar ── */}
          <div className="flex items-center gap-4 px-6 py-3">
            <span className="font-semibold text-lg tracking-tight">🧠 The Brain</span>

            {/* Desktop nav — hidden below md. Primary links inline + admin in a dropdown. */}
            <nav className="hidden items-center gap-1 text-sm md:flex">
              {PRIMARY_NAV.map((item) => (
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
              <NavMenu label="Admin" items={ADMIN_NAV} />
            </nav>

            {/* Right controls */}
            <div className="ml-auto flex items-center gap-3">
              <OrgSwitcher />
              {/* TenantIndicator: desktop only — shown inside mobile menu instead */}
              <div className="hidden md:block">
                <TenantIndicator />
              </div>
              <AuthControl />
              {/* Hamburger toggle — mobile only */}
              <button
                type="button"
                aria-label="Toggle navigation menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                className="rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 md:hidden"
              >
                {menuOpen ? (
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="M4 4l12 12M16 4L4 16" />
                  </svg>
                ) : (
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="M3 5h14M3 10h14M3 15h14" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* ── Mobile menu — visible when open, hidden on md+ ── */}
          {menuOpen && (
            <div className="border-neutral-200 border-t px-4 pb-3 pt-2 md:hidden">
              <nav className="flex flex-col gap-1 text-sm" aria-label="Mobile navigation">
                {NAV.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    activeOptions={{ exact: item.to === "/" }}
                    className="rounded-md px-3 py-2 text-neutral-600 hover:bg-neutral-100"
                    activeProps={{ className: "rounded-md px-3 py-2 bg-neutral-900 text-white" }}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="mt-3 border-t border-neutral-100 pt-3">
                <TenantIndicator />
              </div>
            </div>
          )}
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}

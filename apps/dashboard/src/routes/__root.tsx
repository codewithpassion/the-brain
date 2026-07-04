/**
 * The root route (file-based routing — TanStack Start's plugin generates `routeTree.gen.ts` from this
 * directory; the `bun check` gate runs `tsr generate` first so `tsc --noEmit` sees the tree without
 * needing vite). Renders the full HTML document Start hydrates, wraps the app in Clerk's
 * `<ClerkProvider>`, and paints the app shell.
 *
 * UI v2 shell (Linear-inspired): a fixed left sidebar on desktop (workspace + admin nav groups,
 * tenant + theme switcher + user in the footer) and a slide-over drawer behind a top bar on mobile.
 * Three complete theme identities (styles/app.css) ride `data-theme` on <html>; THEME_BOOT_SCRIPT is
 * inlined in <head> so the persisted theme applies before first paint (hence
 * `suppressHydrationWarning` — the attribute may legitimately differ from the SSR default).
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
import { useEffect, useRef, useState } from "react"
import { CommandPalette, openPalette } from "../components/CommandPalette"
import { ICONS, type IconName } from "../components/icons"
import { OrgSwitcher } from "../components/OrgSwitcher"
import { TenantIndicator } from "../components/TenantIndicator"
import { ThemeSwitcher } from "../components/ThemeSwitcher"
import { Toaster } from "../components/Toaster"
import { getClientEnv } from "../env"
import { DEFAULT_THEME, THEME_BOOT_SCRIPT } from "../lib/theme"
import appCss from "../styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "The Brain — Dashboard" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    scripts: [{ children: THEME_BOOT_SCRIPT }],
  }),
  component: RootComponent,
})

interface NavItem {
  to: string
  label: string
  icon: IconName
}

/** Core, daily-use links — the "Workspace" sidebar group. */
const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/", label: "Search", icon: "search" },
  { to: "/documents", label: "Documents", icon: "documents" },
  { to: "/wiki", label: "Wiki", icon: "wiki" },
  { to: "/memory", label: "Memory", icon: "memory" },
  { to: "/graph", label: "Graph", icon: "graph" },
  { to: "/sessions", label: "Sessions", icon: "sessions" },
  { to: "/ingest", label: "Add", icon: "add" },
]

/** Admin / ops links — the "Admin" sidebar group. */
const ADMIN_NAV: readonly NavItem[] = [
  { to: "/stats", label: "Stats", icon: "stats" },
  { to: "/members", label: "Members", icon: "members" },
  { to: "/api-keys", label: "API Keys", icon: "keys" },
  { to: "/vault-sync", label: "Vault Sync", icon: "vault" },
  { to: "/notion", label: "Notion", icon: "notion" },
  { to: "/audit", label: "Audit", icon: "audit" },
  { to: "/jobs", label: "Jobs", icon: "jobs" },
  { to: "/dreams", label: "Dreams", icon: "dreams" },
  { to: "/facts", label: "Facts", icon: "facts" },
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
          className="rounded-ui bg-accent px-3 py-1.5 font-medium text-accent-ink text-sm hover:opacity-90"
        >
          Sign in
        </Link>
      </Show>
    </>
  )
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 px-2 py-1">
      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" />
      <span className="font-display font-semibold text-[15px] text-ink tracking-tight">
        The Brain
      </span>
    </Link>
  )
}

function NavGroup({ label, items }: { label: string; items: readonly NavItem[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="px-2.5 pt-4 pb-1.5 font-mono text-[10px] text-faint uppercase tracking-[0.14em]">
        {label}
      </span>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === "/" }}
          className="flex items-center gap-2.5 rounded-ui px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-raised hover:text-ink"
          activeProps={{
            className:
              "flex items-center gap-2.5 rounded-ui px-2.5 py-1.5 text-[13px] bg-accent/15 text-accent font-medium",
          }}
        >
          {ICONS[item.icon]}
          {item.label}
        </Link>
      ))}
    </div>
  )
}

/** The sidebar body — shared verbatim between the desktop rail and the mobile drawer. */
function SidebarContent() {
  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <Brand />
      <button
        type="button"
        onClick={openPalette}
        className="mt-2 flex items-center justify-between rounded-ui border border-border bg-bg px-2.5 py-1.5 text-[13px] text-faint transition-colors hover:border-edge hover:text-muted"
      >
        <span>Jump to…</span>
        <kbd className="rounded border border-border px-1 font-mono text-[10px]">⌘K</kbd>
      </button>
      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto pb-2">
        <NavGroup label="Workspace" items={PRIMARY_NAV} />
        <NavGroup label="Admin" items={ADMIN_NAV} />
      </nav>
      <div className="flex flex-col gap-2.5 border-border border-t pt-3">
        <TenantIndicator />
        <ThemeSwitcher />
        <div className="flex items-center justify-between gap-2 px-1">
          <OrgSwitcher />
          <AuthControl />
        </div>
      </div>
    </div>
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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const { location } = useRouterState()

  // Close the mobile drawer whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is in deps to trigger the close on navigation; setDrawerOpen is stable
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // The drawer is a true modal overlay: lock the page scroll, close on Escape, and move focus into
  // it while open (the old mobile menu was an in-flow disclosure and had none of these obligations).
  useEffect(() => {
    if (!drawerOpen) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    document.body.style.overflow = "hidden"
    drawerRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", onKey)
      previouslyFocused?.focus?.()
    }
  }, [drawerOpen])

  return (
    <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-bg text-ink">
        <div className="md:flex">
          {/* ── Desktop sidebar rail ── */}
          <aside className="hidden border-border border-r bg-surface md:sticky md:top-0 md:block md:h-svh md:w-60 md:shrink-0">
            <SidebarContent />
          </aside>

          {/* ── Mobile top bar ── */}
          <header className="sticky top-0 z-40 flex items-center gap-3 border-border border-b bg-bg/85 px-4 py-2.5 backdrop-blur md:hidden">
            <button
              type="button"
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
              className="rounded-ui p-1.5 text-muted hover:bg-raised hover:text-ink"
            >
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
            </button>
            <Brand />
            <div className="ml-auto flex items-center gap-2">
              <AuthControl />
            </div>
          </header>

          {/* ── Mobile drawer ── */}
          {drawerOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setDrawerOpen(false)}
                className="absolute inset-0 bg-black/50"
              />
              <aside
                ref={drawerRef}
                tabIndex={-1}
                aria-label="Navigation"
                className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-border border-r bg-surface shadow-pop focus:outline-none"
              >
                <SidebarContent />
              </aside>
            </div>
          )}

          {/* ── Content ── */}
          <div className="min-w-0 flex-1">
            <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-10 md:py-10">{children}</main>
          </div>
        </div>
        <CommandPalette />
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}

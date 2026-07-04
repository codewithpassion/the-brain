/**
 * Org switcher + new-org creation. Reads the user's orgs via `list_orgs`, highlights the active
 * one (from `getSessionInfo`), and lets the user switch or create a new org.
 *
 * Switching: sets `brain_active_tenant=<slug>` as a non-httpOnly SameSite=Lax cookie and
 * reloads the page so all server data refreshes against the new tenant. The API re-checks
 * membership on every request, so a tampered cookie is inert — the API is authoritative.
 *
 * Creating: shows an inline name+slug form (no browser prompt/alert/confirm), calls `create_org`,
 * then switches to the new org's slug on success.
 */
import { useEffect, useRef, useState } from "react"
import { createOrg, getSessionInfo, listOrgs } from "../server/fns"
import type { OrgRow } from "../server/types"

/** Set the active-tenant cookie and reload to refresh all tenant-scoped data. */
function switchToOrg(slug: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: cookie store API not available in CF Workers; the API re-checks membership so this is inert if tampered
  document.cookie = `brain_active_tenant=${encodeURIComponent(slug)}; path=/; SameSite=Lax`
  window.location.reload()
}

export function OrgSwitcher() {
  const [orgs, setOrgs] = useState<OrgRow[]>([])
  const [activeTenant, setActiveTenant] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [newSlug, setNewSlug] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    Promise.all([listOrgs(), getSessionInfo()])
      .then(([orgsResult, sessionResult]) => {
        if (!active) return
        if (orgsResult.ok) setOrgs(orgsResult.data.orgs)
        if (sessionResult.ok) setActiveTenant(sessionResult.data.tenant)
      })
      .catch(() => {
        /* API unreachable — show nothing */
      })
    return () => {
      active = false
    }
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  if (orgs.length === 0) return null

  /** Match the active tenant (which may be a slug or an org id) against an org. */
  const isActive = (org: OrgRow): boolean =>
    activeTenant !== null && (org.slug === activeTenant || org.id === activeTenant)

  const activeOrg = orgs.find(isActive)

  async function handleCreate() {
    if (!newName.trim()) return
    setLoading(true)
    setError(null)
    try {
      const trimmedSlug = newSlug.trim()
      const result = await createOrg({
        data: { name: newName.trim(), ...(trimmedSlug ? { slug: trimmedSlug } : {}) },
      })
      if (!result.ok) {
        setError(result.error)
        setLoading(false)
        return
      }
      // Switch to the new org and reload.
      switchToOrg(result.data.slug)
    } catch {
      setError("Failed to create org")
      setLoading(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          setCreating(false)
          setError(null)
        }}
        className="flex items-center gap-1.5 rounded-ui border border-border bg-surface px-2.5 py-1 text-sm text-muted hover:bg-raised"
        title="Switch org"
      >
        <span className="max-w-[120px] truncate font-mono text-xs">
          {activeOrg?.name ?? activeTenant ?? "…"}
        </span>
        <svg
          className="h-3 w-3 text-faint"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 bottom-full z-50 mb-1 min-w-[180px] rounded-ui border border-border bg-surface py-1 shadow-pop">
          {!creating ? (
            <>
              {orgs.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    if (!isActive(org)) switchToOrg(org.slug)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-raised ${
                    isActive(org) ? "font-semibold text-ink" : "text-muted"
                  }`}
                >
                  {isActive(org) && (
                    <svg
                      className="h-3 w-3 shrink-0 text-ink"
                      viewBox="0 0 12 12"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="6" cy="6" r="3" />
                    </svg>
                  )}
                  {!isActive(org) && <span className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{org.name}</span>
                  <span className="ml-auto shrink-0 text-faint text-xs">{org.role}</span>
                </button>
              ))}
              <hr className="my-1 border-border" />
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-raised"
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M6 2v8M2 6h8" />
                </svg>
                New org
              </button>
            </>
          ) : (
            <div className="px-3 py-2">
              <p className="mb-2 text-xs font-medium text-muted">New org</p>
              <input
                type="text"
                placeholder="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="mb-1.5 w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
                // biome-ignore lint/a11y/noAutofocus: intentional UX for modal input
                autoFocus
              />
              <input
                type="text"
                placeholder="Slug (optional)"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                className="mb-2 w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
              />
              {error && <p className="mb-1.5 text-danger text-xs">{error}</p>}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={loading || !newName.trim()}
                  className="rounded bg-accent px-2.5 py-1 text-accent-ink text-xs hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? "Creating…" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false)
                    setNewName("")
                    setNewSlug("")
                    setError(null)
                  }}
                  className="rounded border border-border px-2.5 py-1 text-muted text-xs hover:bg-raised"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

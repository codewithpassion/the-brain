/**
 * Compact MCP-server copy chip. Reads the SERVER-pinned tenant via `getSessionInfo` (derived from
 * the verified Clerk subject — invariant 17; the browser only displays it). Clicking the chip copies
 * the tenant's MCP server URL and shows a toast — no separate "copy" button, no long inline tenant id.
 */
import { useEffect, useState } from "react"
import { getSessionInfo } from "../server/fns"
import { toast } from "./Toaster"

const MCP_BASE = "https://brain-api.dominik-fretz.workers.dev/mcp"

export function TenantIndicator() {
  const [tenant, setTenant] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getSessionInfo()
      .then((result) => {
        if (active && result.ok) setTenant(result.data.tenant)
      })
      .catch(() => {
        /* unauthenticated / API unreachable — show nothing */
      })
    return () => {
      active = false
    }
  }, [])

  if (tenant === null) return null
  const url = `${MCP_BASE}/${tenant}`

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(url)
          .then(() => toast("MCP server URL copied"))
          .catch(() => toast("Copy failed"))
      }}
      title={`Click to copy the MCP server URL\n${url}`}
      className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-neutral-600 text-xs hover:bg-neutral-50"
      aria-label="Copy MCP server URL"
    >
      <svg
        className="h-3.5 w-3.5 text-neutral-400"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M2.5 10.5V3.5a1 1 0 011-1h7" />
      </svg>
      Copy MCP URL
    </button>
  )
}

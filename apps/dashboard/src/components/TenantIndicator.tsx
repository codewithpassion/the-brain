/**
 * The active-tenant indicator. Reads the SERVER-pinned tenant via `getSessionInfo` (which derives it
 * from the verified Clerk subject — invariant 17). The browser only ever displays it; it is never a
 * value the client can set or send.
 */
import { useEffect, useState } from "react"
import { getSessionInfo } from "../server/fns"
import { Badge } from "./ui/badge"

const MCP_BASE = "https://brain-api.dominik-fretz.workers.dev/mcp"

export function TenantIndicator() {
  const [tenant, setTenant] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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

  function handleCopy() {
    if (tenant === null) return
    navigator.clipboard
      .writeText(`${MCP_BASE}/${tenant}`)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* clipboard write failed — ignore */
      })
  }

  if (tenant === null) return null
  return (
    <Badge variant="secondary" title="Server-pinned active tenant (invariant 17)">
      tenant: <span className="ml-1 font-mono">{tenant}</span>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy MCP server URL"
        className="ml-2 cursor-pointer opacity-60 transition-opacity hover:opacity-100"
        aria-label="Copy MCP server URL"
      >
        {copied ? "Copied!" : "Copy MCP"}
      </button>
    </Badge>
  )
}

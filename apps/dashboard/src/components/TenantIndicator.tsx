/**
 * The active-tenant indicator. Reads the SERVER-pinned tenant via `getSessionInfo` (which derives it
 * from the verified Clerk subject — invariant 17). The browser only ever displays it; it is never a
 * value the client can set or send.
 */
import { useEffect, useState } from "react"
import { getSessionInfo } from "../server/fns"
import { Badge } from "./ui/badge"

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
  return (
    <Badge variant="secondary" title="Server-pinned active tenant (invariant 17)">
      tenant: <span className="ml-1 font-mono">{tenant}</span>
    </Badge>
  )
}

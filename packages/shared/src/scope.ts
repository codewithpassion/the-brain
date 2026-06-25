import type { Capability } from "./enums"
import type { Principal } from "./principal"

/**
 * The capability-authorization gate (PRD §9.0.2 / §7.2) — gbrain's hierarchy verbatim:
 * `admin ⊃ write ⊃ read`. Evaluated against `principal.capabilities` (the CAPABILITY axis),
 * NEVER `allowedScopes` (the DATA-partition axis). A `readOnly` principal is denied any
 * `write`/`admin` op regardless of the capabilities it nominally carries (belt-and-suspenders
 * with the surface-layer "don't even register write tools for read-only principals" rule).
 */
const CAPABILITY_RANK: Record<Capability, number> = { read: 0, write: 1, admin: 2 }

/**
 * True iff `principal` may invoke an op requiring `required`. A held `admin` satisfies
 * `write`/`read`; a held `write` satisfies `read`. `readOnly` hard-denies `write`/`admin`.
 */
export const scopeSatisfied = (required: Capability, principal: Principal): boolean => {
  if (principal.readOnly && (required === "write" || required === "admin")) return false
  const held = principal.capabilities.reduce(
    (max, capability) => Math.max(max, CAPABILITY_RANK[capability]),
    -1,
  )
  return held >= CAPABILITY_RANK[required]
}

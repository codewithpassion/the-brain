/**
 * `@brain/db/auth` — the edge auth spine (PRD §7.1/§7.2). `resolvePrincipal` reduces ANY
 * credential to a validated `Principal` (the one thing trusted below the edge); the mint
 * helpers issue scope-bounded `bk_` / `bdev_` credentials. Raw-binding usage stays inside
 * `packages/db` (invariant 2) — surfaces call these, never the bindings.
 */
export type { ClerkIdentity, ClerkVerifier } from "./clerk"
export { createClerkVerifier, makeClerkVerifier } from "./clerk"
export { AuthError } from "./errors"
export type {
  MintApiKeyInput,
  MintedApiKey,
  MintMachineTokenInput,
} from "./mint"
export {
  intersectCapabilities,
  intersectScopes,
  mintApiKey,
  mintMachineToken,
  resolveApiKeyPrincipal,
} from "./mint"
export type { MembershipForPrincipal } from "./principal"
export {
  aggregateMemberships,
  autoProvisionOrg,
  capabilitiesForRole,
  loadMembershipPrincipal,
  parseCapabilities,
  parseScopeGrant,
  principalFromMembership,
  resolveTenantSelector,
} from "./principal"
export type { ResolvePrincipalOptions } from "./resolve"
export { activeTenant, resolvePrincipal } from "./resolve"
export type { MachineTokenClaims } from "./tokens"
export {
  nowSeconds,
  randomToken,
  sha256Hex,
  signMachineToken,
  verifyMachineToken,
} from "./tokens"

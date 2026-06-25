/**
 * The server-side tenant pin (invariant 17). In v1 the brain auto-provisions one org per Clerk user
 * with a DETERMINISTIC id `org_${userId}` (see `packages/db/src/auth/principal.ts` `orgIdForUser`).
 * So the active tenant for a dashboard session is a pure function of the SERVER-VERIFIED Clerk
 * subject — never a value supplied by the browser. This is the whole of the pin: compute it from
 * `auth().userId` inside a server fn and send it as `X-Brain-Tenant`; the API re-checks membership.
 *
 * v1 simplification: this always resolves to the user's OWN org (org == user), ignoring any other
 * memberships the user might later accrue. A tenant SWITCHER is a vN follow-up.
 */
export const tenantPinFor = (userId: string): string => `org_${userId}`

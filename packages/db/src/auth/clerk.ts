/**
 * Clerk JWT verification (PRD §7.2) — Clerk is the confirmed OAuth 2.1 / OIDC upstream IdP.
 * A Bearer JWT is verified with `jose.jwtVerify` against Clerk's JWKS, ISSUER-CHECKED.
 *
 * The verifier is INJECTABLE (the `ClerkVerifier` interface): production builds a remote
 * JWKS verifier from `env.CLERK_FRONTEND_API`; unit tests inject a verifier backed by a
 * local test key, so verification logic is exercised with NO network (Phase 1e wires the
 * real Clerk JWKS + canary). `verify` returns the identity or `null` on any failure
 * (bad signature, wrong issuer, expired) — never throws.
 */
import { createRemoteJWKSet, jwtVerify } from "jose"
import type { BrainBindings } from "../env"

/** The minimal identity extracted from a verified Clerk JWT (`sub` + optional email). */
export interface ClerkIdentity {
  userId: string
  email?: string
}

export interface ClerkVerifier {
  verify(token: string): Promise<ClerkIdentity | null>
}

/** The key source `jose.jwtVerify` accepts: a static key (tests) or a JWKS resolver (prod). */
type KeyInput = Parameters<typeof jwtVerify>[1]

/** Build a `ClerkVerifier` from any jose key source + the expected issuer. */
export const makeClerkVerifier = (getKey: KeyInput, issuer: string): ClerkVerifier => ({
  async verify(token: string): Promise<ClerkIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, getKey, { issuer })
      if (typeof payload.sub !== "string") return null
      return typeof payload.email === "string"
        ? { userId: payload.sub, email: payload.email }
        : { userId: payload.sub }
    } catch {
      return null
    }
  },
})

/** Production verifier: remote Clerk JWKS, issuer pinned to `https://${CLERK_FRONTEND_API}`. */
export const createClerkVerifier = (env: BrainBindings): ClerkVerifier => {
  const issuer = `https://${env.CLERK_FRONTEND_API}`
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
  return makeClerkVerifier(jwks, issuer)
}

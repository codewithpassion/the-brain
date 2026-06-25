/**
 * `AuthError` — the typed failure `resolvePrincipal` throws, carrying the HTTP status the
 * edge translates into a response (PRD §7.2/§7.7). `401` for an unauthenticated/unresolved
 * credential (the default — "no bare token below the edge", invariant 17), `403` for an
 * authenticated principal denied a specific resource. The edge maps `401` to an RFC 9728
 * `WWW-Authenticate` challenge; that wiring lands with the Worker surface (Phase 1e).
 */
export class AuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "AuthError"
    this.status = status
  }
}

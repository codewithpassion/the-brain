/**
 * `HttpError` — a status-carrying error the Hono `onError` translates into a response.
 * Mirrors `@brain/db`'s `AuthError` shape so the edge maps both uniformly (401 auth,
 * 429 cost-cap, etc.). Used below the route layer (e.g. the `BudgetPort` 429 pre-check).
 */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

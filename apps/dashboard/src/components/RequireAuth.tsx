/**
 * Client-side auth gate for protected route content. Renders `children` ONLY when Clerk reports a
 * signed-in session; otherwise renders a sign-in prompt with a real link to the `/sign-in/$` flow.
 *
 * This is the UI half of the protection — the server fns in `src/server/*` independently refuse
 * unauthenticated calls (invariant 17), so a signed-out user who bypasses the UI still gets nothing.
 * Using Clerk's `<Show>` (v6) means the protected markup is never emitted for the signed-out branch,
 * so the search box / data UI is absent — not merely hidden with CSS.
 */
import { Show } from "@clerk/tanstack-react-start"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Card, CardContent } from "./ui/card"

export function RequireAuth({ children }: { children: ReactNode }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-neutral-600 text-sm">
              Please sign in to use The Brain. Your memory is private to your tenant.
            </p>
            <Link
              to="/sign-in/$"
              params={{ _splat: "" }}
              className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-sm text-white hover:bg-neutral-700"
            >
              Sign in
            </Link>
          </CardContent>
        </Card>
      </Show>
    </>
  )
}

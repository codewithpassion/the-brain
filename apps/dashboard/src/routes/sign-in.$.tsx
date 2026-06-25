/**
 * Catch-all Clerk sign-in route. The splat (`/sign-in/$`) lets Clerk own the multi-step flow
 * (factor selection, MFA, etc.) under one path. `routing="path"` keeps the steps URL-driven so the
 * back button and deep links work.
 */
import { SignIn } from "@clerk/tanstack-react-start"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/sign-in/$")({
  component: SignInPage,
})

function SignInPage() {
  return (
    <div className="flex justify-center py-8">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </div>
  )
}

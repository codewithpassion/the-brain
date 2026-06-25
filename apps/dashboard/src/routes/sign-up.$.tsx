/**
 * Catch-all Clerk sign-up route — the registration counterpart to `/sign-in/$`. `routing="path"`
 * keeps each step URL-driven; `signInUrl` points back at the sign-in flow.
 */
import { SignUp } from "@clerk/tanstack-react-start"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/sign-up/$")({
  component: SignUpPage,
})

function SignUpPage() {
  return (
    <div className="flex justify-center py-8">
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
    </div>
  )
}

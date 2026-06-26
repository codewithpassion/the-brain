/**
 * CLI device-flow approval page — the human-openable `verification_uri` the CLI prints.
 *
 * Reads `?user_code=` from the URL (pre-populated by `verification_uri_complete`) or shows an
 * input for the user to type the code shown in their terminal. On submit, calls the API's
 * `POST /activate` via the `activateCliCode` server fn (Clerk JWT attached server-side).
 *
 * Auth gate: `RequireAuth` renders a sign-in prompt for unauthenticated visitors. The server fn
 * independently refuses unauthenticated calls (invariant 17).
 */
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { activateCliCode } from "../server/fns"

export const Route = createFileRoute("/cli/activate")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
  }),
  component: () => (
    <RequireAuth>
      <CliActivatePage />
    </RequireAuth>
  ),
})

function CliActivatePage() {
  const { user_code } = Route.useSearch()
  const [code, setCode] = useState(user_code ?? "")
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const userCode = code.trim()
    if (!userCode || status === "loading") return
    setStatus("loading")
    setError(null)
    const result = await activateCliCode({ data: { userCode } })
    if (result.ok) {
      setStatus("success")
    } else {
      setStatus("error")
      setError(result.error)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Authorize CLI</h1>
        <p className="text-neutral-500 text-sm">
          Enter the code shown in your terminal to authorize the Brain CLI.
        </p>
      </header>

      {status === "success" ? (
        <Card>
          <CardContent className="py-6 text-green-700 text-sm">
            CLI authorized successfully. You may close this tab and return to your terminal.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Enter your device code</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-EFGH"
                aria-label="Device code"
                autoFocus={!user_code}
              />
              <Button type="submit" disabled={status === "loading"}>
                {status === "loading" ? "Authorizing…" : "Authorize"}
              </Button>
            </form>
            {status === "error" && error !== null && (
              <p className="mt-3 text-red-600 text-sm">Authorization failed: {error}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

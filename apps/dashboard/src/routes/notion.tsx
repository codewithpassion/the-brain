/**
 * Notion — connect a Notion workspace to the Brain (OAuth) and manage connections.
 *
 * Admin only. "Connect" starts the OAuth redirect (the API mints the authorize URL server-side,
 * with the bearer + tenant); the browser is sent to Notion for consent and returns to
 * `/notion/callback`, which redirects back here with a `?notion=<status>` banner. Beside Vault Sync.
 * No window.confirm / window.alert / window.prompt anywhere.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import {
  confirmNotion,
  connectNotion,
  disconnectNotion,
  listNotionConnections,
} from "../server/fns"
import type { ListNotionConnectionsResult } from "../server/types"

type NotionSearch = { notion?: string; confirm?: string; workspace?: string }

export const Route = createFileRoute("/notion")({
  validateSearch: (search: Record<string, unknown>): NotionSearch => ({
    ...(typeof search.notion === "string" ? { notion: search.notion } : {}),
    ...(typeof search.confirm === "string" ? { confirm: search.confirm } : {}),
    ...(typeof search.workspace === "string" ? { workspace: search.workspace } : {}),
  }),
  loader: async () => ({ connections: await listNotionConnections() }),
  component: () => (
    <RequireAuth>
      <NotionPage />
    </RequireAuth>
  ),
})

type Maybe<T> = { ok: true; data: T } | { ok: false; error: string }

const CALLBACK_BANNER: Record<string, { text: string; tone: "ok" | "warn" | "err" }> = {
  connected: { text: "Notion workspace connected. Pages will sync shortly.", tone: "ok" },
  denied: { text: "Notion authorization was cancelled.", tone: "warn" },
  not_configured: {
    text: "The Notion integration is not configured on this deployment.",
    tone: "warn",
  },
  expired: { text: "The connect link expired — please try again.", tone: "warn" },
  invalid: { text: "The callback was malformed — please try again.", tone: "err" },
  error: { text: "Connecting to Notion failed — please try again.", tone: "err" },
}

function NotionPage() {
  const { connections: initial } = Route.useLoaderData()
  const { notion: callbackStatus, confirm: confirmToken, workspace } = Route.useSearch()
  const navigate = useNavigate()
  const [connections, setConnections] = useState<Maybe<ListNotionConnectionsResult>>(initial)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function refresh() {
    setConnections(await listNotionConnections())
  }

  async function handleConfirm() {
    if (!confirmToken) return
    setConfirming(true)
    setError(null)
    const res = await confirmNotion({ data: { confirmToken } })
    setConfirming(false)
    if (!(res.ok && res.data.confirmed)) {
      setError(res.ok ? "The connect session expired — please try connecting again." : res.error)
    } else {
      await refresh()
    }
    await navigate({ to: "/notion", search: {} }) // clear the confirm params either way
  }

  async function cancelConfirm() {
    await navigate({ to: "/notion", search: {} }) // drop the pending grant (it expires in KV)
  }

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    const res = await connectNotion()
    setConnecting(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (!(res.data.configured && res.data.authorizeUrl)) {
      setError("The Notion integration is not configured on this deployment.")
      return
    }
    // Full-page redirect to Notion's consent screen.
    window.location.href = res.data.authorizeUrl
  }

  if (!connections.ok) {
    return (
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="font-semibold text-2xl tracking-tight">Notion</h1>
        </header>
        <Card>
          <CardContent className="py-6">
            <p className="text-neutral-500 text-sm">
              {connections.error.includes("403") || connections.error.includes("admin")
                ? "Admin or owner access is required to manage Notion connections."
                : `Unavailable: ${connections.error}`}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const banner = callbackStatus ? CALLBACK_BANNER[callbackStatus] : undefined
  const active = connections.data.connections.filter((c) => c.revokedAt === null)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Notion</h1>
        <p className="text-neutral-500 text-sm">
          Connect a Notion workspace to sync its pages into the Brain. You choose which pages and
          databases to share with the integration inside Notion — only shared content is visible.
          Admin only. Disconnecting stops all sync immediately. Page edits sync on a poll; page
          deletions propagate reliably via webhooks.
        </p>
      </header>

      {banner && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            banner.tone === "ok"
              ? "border-green-200 bg-green-50 text-green-700"
              : banner.tone === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.text}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-700 text-sm">
          {error}
        </div>
      )}

      {confirmToken && (
        <Card>
          <CardHeader>
            <CardTitle>Confirm connection</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-neutral-600 text-sm">
              Connect Notion workspace{" "}
              <span className="font-medium">{workspace ?? "(unknown)"}</span> to this org? Only
              confirm if you just authorized this workspace — otherwise cancel.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={confirming}
                onClick={handleConfirm}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
              >
                {confirming ? "Confirming…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={cancelConfirm}
                className="rounded border border-neutral-200 px-3 py-1.5 text-neutral-600 text-sm hover:bg-neutral-50"
              >
                Cancel
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connect a workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <button
            type="button"
            disabled={connecting}
            onClick={handleConnect}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {connecting ? "Starting…" : "Connect Notion"}
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected workspaces</CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-neutral-500 text-sm">No connected workspaces yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-neutral-200 border-b text-left text-neutral-500">
                  <th className="py-2 font-medium">Workspace</th>
                  <th className="py-2 font-medium">Connected</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {active.map((c) => (
                  <tr key={c.workspaceId} className="border-neutral-100 border-b">
                    <td className="py-2">{c.workspaceName ?? c.workspaceId}</td>
                    <td className="py-2 text-neutral-500">
                      {new Date(c.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 text-right">
                      <DisconnectButton
                        workspaceId={c.workspaceId}
                        onError={setError}
                        onRefresh={refresh}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DisconnectButton({
  workspaceId,
  onError,
  onRefresh,
}: {
  workspaceId: string
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)

  if (confirming) {
    return (
      <span className="flex items-center justify-end gap-1 text-xs">
        <span className="text-neutral-500">Disconnect?</span>
        <button
          type="button"
          disabled={working}
          onClick={async () => {
            setWorking(true)
            onError(null)
            const res = await disconnectNotion({ data: { workspaceId } })
            if (!res.ok) {
              onError(res.error)
              setConfirming(false)
              setWorking(false)
            } else {
              await onRefresh()
            }
          }}
          className="rounded bg-red-600 px-2 py-0.5 text-white text-xs hover:bg-red-700 disabled:opacity-50"
        >
          {working ? "…" : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded border border-neutral-200 px-2 py-0.5 text-neutral-600 text-xs hover:bg-neutral-50"
        >
          No
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded border border-red-200 px-2 py-0.5 text-red-600 text-xs hover:bg-red-50"
    >
      Disconnect
    </button>
  )
}

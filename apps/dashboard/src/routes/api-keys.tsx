/**
 * API Keys management — list, create, revoke tenant bk_ keys.
 *
 * Admin/owner only: `listApiKeys` returns `{ok:false}` for non-admins, and create/revoke are also
 * gated by `assertAdmin` at the API level. Non-admins see a message instead of the controls.
 * The raw token is shown ONCE after creation then never again (gone on refresh).
 * No window.confirm / window.alert / window.prompt anywhere.
 */
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { createApiKey, listApiKeys, revokeApiKey } from "../server/fns"
import type { ApiKeyRow, CreateApiKeyResult, ListApiKeysResult } from "../server/types"

export const Route = createFileRoute("/api-keys")({
  loader: async () => ({
    keys: await listApiKeys(),
  }),
  component: () => (
    <RequireAuth>
      <ApiKeysPage />
    </RequireAuth>
  ),
})

type Maybe<T> = { ok: true; data: T } | { ok: false; error: string }

const CAPABILITY_OPTIONS = ["read", "write", "admin"] as const

function ApiKeysPage() {
  const { keys: initial } = Route.useLoaderData()
  const [keys, setKeys] = useState<Maybe<ListApiKeysResult>>(initial)
  const [newKey, setNewKey] = useState<CreateApiKeyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const updated = await listApiKeys()
    setKeys(updated)
  }

  if (!keys.ok) {
    return (
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="font-semibold text-2xl tracking-tight">API Keys</h1>
        </header>
        <Card>
          <CardContent className="py-6">
            <p className="text-muted text-sm">
              {keys.error.includes("403") || keys.error.includes("admin")
                ? "Admin or owner access is required to manage API keys."
                : `Unavailable: ${keys.error}`}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">API Keys</h1>
        <p className="text-muted text-sm">
          Manage bk_ API keys for this org. Admin only. Revoked keys stop working immediately.
        </p>
      </header>

      {error && (
        <div className="rounded-ui border border-danger/25 bg-danger/10 px-4 py-3 text-danger text-sm">
          {error}
        </div>
      )}

      {newKey && <NewKeyBanner result={newKey} onDismiss={() => setNewKey(null)} />}

      <KeysTable rows={keys.data.keys} onError={setError} onRefresh={refresh} />

      <CreateKeyCard onError={setError} onRefresh={refresh} onCreated={setNewKey} />
    </div>
  )
}

// ── New key banner (shown once after creation) ────────────────────────────────

function NewKeyBanner({
  result,
  onDismiss,
}: {
  result: CreateApiKeyResult
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(result.token).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="rounded-ui border border-ok/25 bg-ok/10 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold text-ok text-sm">
          Key created: <span className="font-normal">{result.name}</span>
        </p>
        <button type="button" onClick={onDismiss} className="text-ok text-xs hover:opacity-70">
          Dismiss
        </button>
      </div>
      <p className="mb-2 text-ok text-xs">
        Copy this key now — you will not be able to see it again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-ok/25 bg-bg px-3 py-1.5 font-mono text-sm break-all">
          {result.token}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded border border-ok/25 bg-bg px-3 py-1.5 text-ok text-sm hover:bg-ok/10"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <p className="mt-1 text-ok text-xs">
        Prefix: <code className="font-mono">{result.keyPrefix}</code> · Scopes:{" "}
        {result.scopes.join(", ") || "none"}
      </p>
    </div>
  )
}

// ── Keys table ────────────────────────────────────────────────────────────────

function KeysTable({
  rows,
  onError,
  onRefresh,
}: {
  rows: ApiKeyRow[]
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active keys</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted text-sm">No API keys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-faint">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Prefix</th>
                  <th className="pb-2 font-medium">Scopes</th>
                  <th className="pb-2 font-medium">Read-only</th>
                  <th className="pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Last used</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id} className="border-border border-t">
                    <td className="py-2 font-medium">{k.name}</td>
                    <td className="py-2 font-mono text-xs">{k.keyPrefix}…</td>
                    <td className="py-2 text-muted">{k.scopes.join(", ") || "—"}</td>
                    <td className="py-2">
                      {k.readOnly ? (
                        <Badge variant="outline">read-only</Badge>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="py-2 text-muted text-xs">
                      {k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="py-2 text-muted text-xs">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
                    </td>
                    <td className="py-2">
                      {k.revokedAt ? (
                        <Badge variant="outline" className="text-danger">
                          revoked
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-ok">
                          active
                        </Badge>
                      )}
                    </td>
                    <td className="py-2">
                      {!k.revokedAt && (
                        <RevokeButton keyId={k.id} onError={onError} onRefresh={onRefresh} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RevokeButton({
  keyId,
  onError,
  onRefresh,
}: {
  keyId: string
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-muted">Revoke?</span>
        <button
          type="button"
          disabled={revoking}
          onClick={async () => {
            setRevoking(true)
            onError(null)
            const res = await revokeApiKey({ data: { keyId } })
            if (!res.ok) {
              onError(res.error)
              setConfirming(false)
              setRevoking(false)
            } else {
              await onRefresh()
            }
          }}
          className="rounded bg-danger px-2 py-0.5 text-accent-ink text-xs hover:bg-danger/90 disabled:opacity-50"
        >
          {revoking ? "…" : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded border border-border px-2 py-0.5 text-muted text-xs hover:bg-raised"
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
      className="rounded border border-danger/25 px-2 py-0.5 text-danger text-xs hover:bg-danger/10"
    >
      Revoke
    </button>
  )
}

// ── Create key form ───────────────────────────────────────────────────────────

function CreateKeyCard({
  onError,
  onRefresh,
  onCreated,
}: {
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
  onCreated: (result: CreateApiKeyResult) => void
}) {
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<string[]>(["read"])
  const [readOnly, setReadOnly] = useState(false)
  const [creating, setCreating] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    setLocalError(null)
    onError(null)
    const res = await createApiKey({
      data: {
        name: name.trim(),
        scopes: scopes as string[],
        readOnly,
      },
    })
    setCreating(false)
    if (!res.ok) {
      setLocalError(res.error)
      return
    }
    setName("")
    setScopes(["read"])
    setReadOnly(false)
    onCreated(res.data)
    await onRefresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create API key</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 max-w-md">
          <div>
            <label htmlFor="key-name" className="mb-1 block text-muted text-sm">
              Name
            </label>
            <input
              id="key-name"
              type="text"
              placeholder="e.g. ci-deploy"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
            />
          </div>

          <div>
            <p className="mb-1 text-muted text-sm">Capabilities</p>
            <div className="flex gap-3">
              {CAPABILITY_OPTIONS.map((cap) => (
                <label key={cap} className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(cap)}
                    onChange={() => toggleScope(cap)}
                    className="rounded"
                  />
                  {cap}
                </label>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="rounded"
            />
            <span className="text-muted">Read-only</span>
          </label>

          {localError && <p className="text-danger text-sm">{localError}</p>}

          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="self-start rounded bg-accent px-4 py-1.5 text-sm text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create key"}
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

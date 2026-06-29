/**
 * Vault Sync (Obsidian) — generate WebDAV credentials for syncing an Obsidian vault into the Brain.
 *
 * Admin only. The password is shown ONCE after creation and never again (same pattern as api-keys.tsx).
 * No window.confirm / window.alert / window.prompt anywhere.
 */
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { createVaultCredential, listVaultCredentials, revokeVaultCredential } from "../server/fns"
import type {
  CreateVaultCredentialResult,
  ListVaultCredentialsResult,
  VaultCredential,
} from "../server/types"

export const Route = createFileRoute("/vault-sync")({
  loader: async () => ({
    credentials: await listVaultCredentials(),
  }),
  component: () => (
    <RequireAuth>
      <VaultSyncPage />
    </RequireAuth>
  ),
})

type Maybe<T> = { ok: true; data: T } | { ok: false; error: string }

function VaultSyncPage() {
  const { credentials: initial } = Route.useLoaderData()
  const [credentials, setCredentials] = useState<Maybe<ListVaultCredentialsResult>>(initial)
  const [newCred, setNewCred] = useState<CreateVaultCredentialResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const updated = await listVaultCredentials()
    setCredentials(updated)
  }

  if (!credentials.ok) {
    return (
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="font-semibold text-2xl tracking-tight">Vault Sync (Obsidian)</h1>
        </header>
        <Card>
          <CardContent className="py-6">
            <p className="text-neutral-500 text-sm">
              {credentials.error.includes("403") || credentials.error.includes("admin")
                ? "Admin or owner access is required to manage vault credentials."
                : `Unavailable: ${credentials.error}`}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Vault Sync (Obsidian)</h1>
        <p className="text-neutral-500 text-sm">
          Sync your Obsidian vault into the Brain via WebDAV — without exposing the underlying
          storage bucket. Each credential is a dedicated username and password scoped to this org.
          Admin only. Revoked credentials stop working immediately.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-700 text-sm">
          {error}
        </div>
      )}

      {newCred && <NewCredentialBanner result={newCred} onDismiss={() => setNewCred(null)} />}

      <CredentialsTable
        rows={credentials.data.credentials}
        onError={setError}
        onRefresh={refresh}
      />

      <GenerateCredentialCard onError={setError} onRefresh={refresh} onCreated={setNewCred} />

      <ConnectObsidianCard />
    </div>
  )
}

// ── New credential banner (shown once after creation) ─────────────────────────

function NewCredentialBanner({
  result,
  onDismiss,
}: {
  result: CreateVaultCredentialResult
  onDismiss: () => void
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null)

  function copy(value: string, field: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    })
  }

  return (
    <div className="rounded-md border border-green-200 bg-green-50 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold text-green-800 text-sm">Credential created</p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-green-600 text-xs hover:text-green-800"
        >
          Dismiss
        </button>
      </div>
      <p className="mb-3 text-green-700 text-xs font-medium">
        Copy the password now — you will not be able to see it again.
      </p>
      <div className="flex flex-col gap-2">
        <CredentialField
          label="Username"
          value={result.username}
          onCopy={() => copy(result.username, "username")}
          copied={copiedField === "username"}
        />
        <CredentialField
          label="Password"
          value={result.password}
          onCopy={() => copy(result.password, "password")}
          copied={copiedField === "password"}
        />
        <CredentialField
          label="Endpoint (WebDAV URL)"
          value={result.endpoint}
          onCopy={() => copy(result.endpoint, "endpoint")}
          copied={copiedField === "endpoint"}
        />
      </div>
    </div>
  )
}

function CredentialField({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string
  value: string
  onCopy: () => void
  copied: boolean
}) {
  return (
    <div>
      <p className="mb-0.5 text-green-700 text-xs">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-green-200 bg-white px-3 py-1.5 font-mono text-sm break-all">
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="rounded border border-green-300 bg-white px-3 py-1.5 text-green-700 text-sm hover:bg-green-50"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  )
}

// ── Credentials table ─────────────────────────────────────────────────────────

function CredentialsTable({
  rows,
  onError,
  onRefresh,
}: {
  rows: VaultCredential[]
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active credentials</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-neutral-500 text-sm">No vault credentials yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-400">
                <th className="pb-2 font-medium">Username</th>
                <th className="pb-2 font-medium">Label</th>
                <th className="pb-2 font-medium">Created</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.username} className="border-neutral-100 border-t">
                  <td className="py-2 font-mono text-xs">{c.username}</td>
                  <td className="py-2 text-neutral-500">{c.label ?? "—"}</td>
                  <td className="py-2 text-neutral-500 text-xs">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-2">
                    {c.revokedAt ? (
                      <Badge variant="outline" className="text-red-600">
                        revoked
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-green-600">
                        active
                      </Badge>
                    )}
                  </td>
                  <td className="py-2">
                    {!c.revokedAt && (
                      <RevokeButton username={c.username} onError={onError} onRefresh={onRefresh} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

function RevokeButton({
  username,
  onError,
  onRefresh,
}: {
  username: string
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-neutral-500">Revoke?</span>
        <button
          type="button"
          disabled={revoking}
          onClick={async () => {
            setRevoking(true)
            onError(null)
            const res = await revokeVaultCredential({ data: { username } })
            if (!res.ok) {
              onError(res.error)
              setConfirming(false)
              setRevoking(false)
            } else {
              await onRefresh()
            }
          }}
          className="rounded bg-red-600 px-2 py-0.5 text-white text-xs hover:bg-red-700 disabled:opacity-50"
        >
          {revoking ? "…" : "Yes"}
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
      Revoke
    </button>
  )
}

// ── Generate credential form ──────────────────────────────────────────────────

function GenerateCredentialCard({
  onError,
  onRefresh,
  onCreated,
}: {
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
  onCreated: (result: CreateVaultCredentialResult) => void
}) {
  const [label, setLabel] = useState("")
  const [generating, setGenerating] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  async function handleGenerate() {
    setGenerating(true)
    setLocalError(null)
    onError(null)
    const res = await createVaultCredential({
      data: { ...(label.trim() ? { label: label.trim() } : {}) },
    })
    setGenerating(false)
    if (!res.ok) {
      setLocalError(res.error)
      return
    }
    setLabel("")
    onCreated(res.data)
    await onRefresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate credential</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 max-w-md">
          <div>
            <label htmlFor="vault-label" className="mb-1 block text-neutral-700 text-sm">
              Label <span className="text-neutral-400">(optional)</span>
            </label>
            <input
              id="vault-label"
              type="text"
              placeholder="e.g. personal-vault"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded border border-neutral-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>

          {localError && <p className="text-red-600 text-sm">{localError}</p>}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="self-start rounded bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate"}
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Connect Obsidian instructions ─────────────────────────────────────────────

function ConnectObsidianCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Obsidian</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2 text-sm text-neutral-700 list-decimal list-inside">
          <li>
            In Obsidian, open <span className="font-medium">Settings → Community plugins</span> and
            install <span className="font-medium">Remotely Save</span>.
          </li>
          <li>
            Open the Remotely Save settings and choose <span className="font-medium">WebDAV</span>{" "}
            as the remote service (not S3).
          </li>
          <li>
            Fill in the fields using the credential you generated above:
            <ul className="mt-1 ml-4 flex flex-col gap-1 list-disc list-inside text-neutral-600">
              <li>
                <span className="font-medium">Server address</span> — paste the{" "}
                <span className="font-mono text-xs">endpoint</span>
              </li>
              <li>
                <span className="font-medium">Username</span> — paste the{" "}
                <span className="font-mono text-xs">username</span>
              </li>
              <li>
                <span className="font-medium">Password</span> — paste the{" "}
                <span className="font-mono text-xs">password</span> (saved from the banner above)
              </li>
            </ul>
          </li>
          <li>
            Optionally set a <span className="font-medium">remote base directory</span> inside
            Remotely Save if you want to isolate this vault from others.
          </li>
          <li>
            Hit <span className="font-medium">Sync</span>. Obsidian will push your vault contents to
            the Brain over WebDAV; the Brain's ingest pipeline will index new and changed notes
            automatically.
          </li>
        </ol>
        <p className="mt-4 text-neutral-500 text-xs">
          The WebDAV endpoint does not expose the underlying storage bucket. Revoking a credential
          immediately blocks all further syncs using that username.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Vault Sync (Obsidian) — generate WebDAV credentials for syncing an Obsidian vault into the Brain.
 *
 * Admin only. The password is shown ONCE after creation and never again (same pattern as api-keys.tsx).
 * No window.confirm / window.alert / window.prompt anywhere.
 */
import { createFileRoute } from "@tanstack/react-router"
import type { ReactNode } from "react"
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
            <p className="text-muted text-sm">
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
        <p className="text-muted text-sm">
          Sync your Obsidian vault into the Brain via WebDAV — without exposing the underlying
          storage bucket. Each credential is a dedicated username and password scoped to this org.
          Admin only. Revoked credentials stop working immediately.
        </p>
      </header>

      {error && (
        <div className="rounded-ui border border-danger/25 bg-danger/10 px-4 py-3 text-danger text-sm">
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
    <div className="rounded-ui border border-ok/25 bg-ok/10 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold text-ok text-sm">Credential created</p>
        <button type="button" onClick={onDismiss} className="text-ok text-xs hover:opacity-70">
          Dismiss
        </button>
      </div>
      <p className="mb-3 text-ok text-xs font-medium">
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
      <p className="mb-0.5 text-ok text-xs">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-ok/25 bg-bg px-3 py-1.5 font-mono text-sm break-all">
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="rounded border border-ok/25 bg-bg px-3 py-1.5 text-ok text-sm hover:bg-ok/10"
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
          <p className="text-muted text-sm">No vault credentials yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-faint">
                  <th className="pb-2 font-medium">Username</th>
                  <th className="pb-2 font-medium">Label</th>
                  <th className="pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.username} className="border-border border-t">
                    <td className="py-2 font-mono text-xs">{c.username}</td>
                    <td className="py-2 text-muted">{c.label ?? "—"}</td>
                    <td className="py-2 text-muted text-xs">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2">
                      {c.revokedAt ? (
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
                      {!c.revokedAt && (
                        <RevokeButton
                          username={c.username}
                          onError={onError}
                          onRefresh={onRefresh}
                        />
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
        <span className="text-muted">Revoke?</span>
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
            <label htmlFor="vault-label" className="mb-1 block text-muted text-sm">
              Label <span className="text-faint">(optional)</span>
            </label>
            <input
              id="vault-label"
              type="text"
              placeholder="e.g. personal-vault"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded border border-border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
            />
          </div>

          {localError && <p className="text-danger text-sm">{localError}</p>}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="self-start rounded bg-accent px-4 py-1.5 text-sm text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate"}
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Connect Obsidian — step-by-step guide ─────────────────────────────────────

/** Bold inline emphasis matching the guide's neutral palette. */
const B = ({ children }: { children: ReactNode }) => (
  <span className="font-medium text-ink">{children}</span>
)

/** Inline code chip (commands, field values). */
const Cmd = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-raised px-1 py-0.5 font-mono text-xs">{children}</code>
)

/** One numbered step: a circular badge + title + body. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-ink text-xs">
        {n}
      </span>
      <div className="min-w-0 text-sm">
        <p className="mb-1 font-medium text-ink">{title}</p>
        <div className="text-muted leading-relaxed">{children}</div>
      </div>
    </li>
  )
}

function ConnectObsidianCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Obsidian — step by step</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-5">
          <Step n={1} title="Install the Remotely Save plugin">
            In Obsidian open <B>Settings → Community plugins</B>. If prompted, turn off Restricted
            mode, click <B>Browse</B>, search <B>Remotely Save</B>, then <B>Install</B> and{" "}
            <B>Enable</B> it. (It works on desktop and the iOS / Android apps.)
          </Step>

          <Step n={2} title="Generate a credential above">
            In the <B>Generate credential</B> section on this page, optionally give it a label (e.g.
            the device name), click <B>Generate</B>, and copy the <B>username</B>, <B>password</B>,
            and <B>endpoint</B>. The password is shown <B>only once</B> — keep it handy for the next
            step.
          </Step>

          <Step n={3} title="Point Remotely Save at the Brain (WebDAV)">
            Open <B>Settings → Remotely Save</B>. Under <B>Choose a remote service</B> pick{" "}
            <B>WebDAV</B> (not S3, Dropbox, or OneDrive), then fill in the three fields with the
            credential from step 2:
            <table className="mt-2 w-full max-w-md">
              <tbody>
                <tr className="border-border border-t">
                  <td className="py-1 pr-3 align-top font-medium text-muted text-xs">
                    Server address
                  </td>
                  <td className="py-1 text-muted text-xs">
                    the <Cmd>endpoint</Cmd> (ends in <Cmd>/dav</Cmd>)
                  </td>
                </tr>
                <tr className="border-border border-t">
                  <td className="py-1 pr-3 align-top font-medium text-muted text-xs">Username</td>
                  <td className="py-1 text-muted text-xs">
                    the <Cmd>username</Cmd> (starts with <Cmd>vk_</Cmd>)
                  </td>
                </tr>
                <tr className="border-border border-t">
                  <td className="py-1 pr-3 align-top font-medium text-muted text-xs">Password</td>
                  <td className="py-1 text-muted text-xs">the generated password</td>
                </tr>
              </tbody>
            </table>
            <span className="mt-1 block">Leave the other connection fields at their defaults.</span>
          </Step>

          <Step n={4} title="Choose your sync settings (recommended)">
            <ul className="flex list-disc flex-col gap-1 pl-4">
              <li>
                <B>Auto-sync</B> — enable “sync on save” or a schedule so notes flow without manual
                syncs.
              </li>
              <li>
                <B>Sync direction</B> — keep the default bidirectional unless you only want to push
                up to the Brain.
              </li>
              <li>
                <B>Remote base directory</B> — optional; set one if several vaults share a
                credential and you want them kept in separate folders.
              </li>
            </ul>
          </Step>

          <Step n={5} title="Run the first sync">
            Click the <B>Sync</B> (circular-arrows) ribbon icon, or run the command{" "}
            <Cmd>Remotely Save: start sync</Cmd>. The first run uploads your whole vault — give it a
            minute for a large one.
          </Step>

          <Step n={6} title="Verify it worked">
            Open <B>Documents</B> in the nav — your <Cmd>.md</Cmd> notes appear as indexed documents
            (folders become path namespaces) and the <B>Graph</B> fills in as entities are
            extracted. You can then <B>Search</B> and ask the Brain across your vault.
          </Step>
        </ol>

        <div className="mt-5 border-border border-t pt-4">
          <p className="mb-2 font-medium text-muted text-sm">Good to know</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-muted text-xs">
            <li>
              Markdown notes are indexed for search and the graph; other files (images, PDFs) are
              stored and synced but not indexed.
            </li>
            <li>
              Large attachments are supported — they stream as multipart uploads, with no size cap.
            </li>
            <li>
              The reserved <Cmd>Brain/</Cmd> folder is written by the Brain (export / write-back)
              and is never re-ingested, so there's no sync loop.
            </li>
            <li>
              The endpoint never exposes the underlying storage bucket, and revoking a credential
              blocks all further syncs with that username immediately.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

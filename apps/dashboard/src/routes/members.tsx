/**
 * Members / Org settings — list members, add by email, edit role, remove.
 *
 * Owner/admin only: `getMemberships` returns `{ok:false}` for non-admins, and the add/edit/remove
 * server fns are also gated by `assertAdmin` at the API level. Non-admins see a message instead
 * of the management controls. The API enforces the gate independently of what the UI shows.
 */
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import {
  addMember,
  getMemberships,
  removeMember,
  searchUserByEmail,
  updateMember,
} from "../server/fns"
import type { MembershipRow, MembershipsResult, SearchUserResult } from "../server/types"

export const Route = createFileRoute("/members")({
  loader: async () => ({
    members: await getMemberships(),
  }),
  component: () => (
    <RequireAuth>
      <MembersPage />
    </RequireAuth>
  ),
})

type Maybe<T> = { ok: true; data: T } | { ok: false; error: string }

function MembersPage() {
  const { members: initial } = Route.useLoaderData()
  const [members, setMembers] = useState<Maybe<MembershipsResult>>(initial)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const updated = await getMemberships()
    setMembers(updated)
  }

  if (!members.ok) {
    return (
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="font-semibold text-2xl tracking-tight">Members</h1>
        </header>
        <Card>
          <CardContent className="py-6">
            <p className="text-neutral-500 text-sm">
              {members.error.includes("403") || members.error.includes("admin")
                ? "Admin or owner access is required to manage members."
                : `Unavailable: ${members.error}`}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Members</h1>
        <p className="text-neutral-500 text-sm">
          Manage who has access to this org. Owner/admin only.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-700 text-sm">
          {error}
        </div>
      )}

      <MembersTable rows={members.data.memberships} onError={setError} onRefresh={refresh} />

      <AddMemberCard onError={setError} onRefresh={refresh} />
    </div>
  )
}

// ── Member table ──────────────────────────────────────────────────────────────

function MembersTable({
  rows,
  onError,
  onRefresh,
}: {
  rows: MembershipRow[]
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Current members</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-neutral-500 text-sm">No members yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-400">
                <th className="pb-2 font-medium">User ID</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Scopes</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) =>
                editingId === m.userId ? (
                  <EditRow
                    key={m.userId}
                    member={m}
                    onCancel={() => setEditingId(null)}
                    onSave={async (role, allowedScopes) => {
                      onError(null)
                      const res = await updateMember({
                        data: {
                          userId: m.userId,
                          role,
                          ...(allowedScopes !== undefined ? { allowedScopes } : {}),
                        },
                      })
                      if (!res.ok) {
                        onError(res.error)
                      } else {
                        setEditingId(null)
                        await onRefresh()
                      }
                    }}
                  />
                ) : (
                  <tr key={m.userId} className="border-neutral-100 border-t">
                    <td className="py-2 font-mono text-xs">{m.userId}</td>
                    <td className="py-2">
                      <Badge variant="outline">{m.role}</Badge>
                    </td>
                    <td className="py-2 text-neutral-500">{m.allowedScopes ?? "*"}</td>
                    <td className="py-2">
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            onError(null)
                            setEditingId(m.userId)
                          }}
                          className="rounded border border-neutral-200 px-2 py-0.5 text-neutral-600 text-xs hover:bg-neutral-50"
                        >
                          Edit
                        </button>
                        <RemoveButton userId={m.userId} onError={onError} onRefresh={onRefresh} />
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

function EditRow({
  member,
  onCancel,
  onSave,
}: {
  member: MembershipRow
  onCancel: () => void
  onSave: (role: string, allowedScopes: string[] | "*" | undefined) => Promise<void>
}) {
  const [role, setRole] = useState(member.role)
  const [scopesRaw, setScopesRaw] = useState(member.allowedScopes ?? "")
  const [saving, setSaving] = useState(false)

  const parsedScopes = (): string[] | "*" | undefined => {
    const trimmed = scopesRaw.trim()
    if (trimmed === "" || trimmed === "*") return trimmed === "*" ? "*" : undefined
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  return (
    <tr className="border-neutral-100 border-t bg-neutral-50">
      <td className="py-2 font-mono text-xs">{member.userId}</td>
      <td className="py-2">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded border border-neutral-200 px-1 py-0.5 text-sm"
        >
          <option value="owner">owner</option>
          <option value="admin">admin</option>
          <option value="member">member</option>
          <option value="readonly">readonly</option>
        </select>
      </td>
      <td className="py-2">
        <input
          type="text"
          value={scopesRaw}
          onChange={(e) => setScopesRaw(e.target.value)}
          placeholder="* or scope1,scope2"
          className="w-full rounded border border-neutral-200 px-2 py-0.5 text-xs"
        />
      </td>
      <td className="py-2">
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              await onSave(role, parsedScopes())
              setSaving(false)
            }}
            className="rounded bg-neutral-900 px-2 py-0.5 text-white text-xs hover:bg-neutral-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-200 px-2 py-0.5 text-neutral-600 text-xs hover:bg-neutral-50"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  )
}

function RemoveButton({
  userId,
  onError,
  onRefresh,
}: {
  userId: string
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <span className="text-neutral-500">Remove?</span>
        <button
          type="button"
          disabled={removing}
          onClick={async () => {
            setRemoving(true)
            onError(null)
            const res = await removeMember({ data: { userId } })
            if (!res.ok) {
              onError(res.error)
              setConfirming(false)
              setRemoving(false)
            } else {
              await onRefresh()
            }
          }}
          className="rounded bg-red-600 px-2 py-0.5 text-white text-xs hover:bg-red-700 disabled:opacity-50"
        >
          {removing ? "…" : "Yes"}
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
      Remove
    </button>
  )
}

// ── Add member form ───────────────────────────────────────────────────────────

function AddMemberCard({
  onError,
  onRefresh,
}: {
  onError: (msg: string | null) => void
  onRefresh: () => Promise<void>
}) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState("member")
  const [preview, setPreview] = useState<SearchUserResult | null | "not-found">(null)
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  async function handleSearch() {
    if (!email.trim()) return
    setSearching(true)
    setLocalError(null)
    setPreview(null)
    const res = await searchUserByEmail({ data: { email: email.trim() } })
    setSearching(false)
    if (!res.ok) {
      setLocalError(res.error)
      return
    }
    setPreview(res.data.user ?? "not-found")
  }

  async function handleAdd() {
    if (!email.trim()) return
    setAdding(true)
    setLocalError(null)
    onError(null)
    const res = await addMember({ data: { email: email.trim(), role } })
    setAdding(false)
    if (!res.ok) {
      setLocalError(res.error)
      return
    }
    setEmail("")
    setPreview(null)
    await onRefresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add member</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 max-w-md">
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setPreview(null)
              }}
              className="flex-1 rounded border border-neutral-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            <button
              type="button"
              onClick={handleSearch}
              disabled={searching || !email.trim()}
              className="rounded border border-neutral-200 px-3 py-1.5 text-neutral-700 text-sm hover:bg-neutral-50 disabled:opacity-50"
            >
              {searching ? "Looking…" : "Look up"}
            </button>
          </div>

          {preview === "not-found" && (
            <p className="text-neutral-500 text-sm">
              No Brain account found. The user must sign in at least once first.
            </p>
          )}

          {preview !== null && preview !== "not-found" && (
            <div className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
              {preview.imageUrl && (
                <img src={preview.imageUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
              )}
              <div className="text-sm">
                <div className="font-medium">
                  {preview.firstName} {preview.lastName}
                </div>
                <div className="text-neutral-500">{preview.email}</div>
                <div className="font-mono text-neutral-400 text-xs">{preview.userId}</div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label htmlFor="member-role" className="text-neutral-600 text-sm">
              Role
            </label>
            <select
              id="member-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded border border-neutral-200 px-2 py-1 text-sm"
            >
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="readonly">readonly</option>
            </select>
          </div>

          {localError && <p className="text-red-600 text-sm">{localError}</p>}

          <button
            type="button"
            onClick={handleAdd}
            disabled={adding || !email.trim()}
            className="self-start rounded bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {adding ? "Adding…" : "Add member"}
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

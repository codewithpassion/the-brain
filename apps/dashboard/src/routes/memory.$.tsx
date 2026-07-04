/**
 * Memory detail — view, edit, browse history, roll back, or forget a single memory item.
 * Route: /memory/$ (splat — slugs are multi-segment, e.g. `agent/e2e/prefs`).
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { toast } from "../components/Toaster"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { memoryForget, memoryGet, memoryHistory, memoryRollback, memorySet } from "../server/fns"
import type { MemoryItem, MemoryRevision } from "../server/types"

export const Route = createFileRoute("/memory/$")({
  loader: async ({ params }) => ({
    item: await memoryGet({ data: { slug: params._splat ?? "" } }),
  }),
  component: () => (
    <RequireAuth>
      <MemoryDetailPage />
    </RequireAuth>
  ),
})

function MemoryDetailPage() {
  const router = useRouter()
  const { _splat: slug } = Route.useParams()
  const { item: initialItem } = Route.useLoaderData()

  // Edit state
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState("")
  const [editType, setEditType] = useState("")
  const [editTitle, setEditTitle] = useState("")
  const [editTags, setEditTags] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // History state
  const [history, setHistory] = useState<MemoryRevision[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  // Forget state
  const [forgetting, setForgetting] = useState(false)
  const [forgetConfirm, setForgetConfirm] = useState(false)

  if (!initialItem.ok) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <p className="text-danger text-sm">Error loading memory: {initialItem.error}</p>
      </div>
    )
  }

  if (initialItem.data.memory === null) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <p className="text-muted text-sm">Memory "{slug}" not found.</p>
      </div>
    )
  }

  const mem: MemoryItem = initialItem.data.memory
  const tags = mem.tags

  const handleEditOpen = () => {
    setEditBody(mem.body)
    setEditType(mem.type)
    setEditTitle(mem.title)
    setEditTags(mem.tags.join(", "))
    setSaveError(null)
    setEditing(true)
  }

  /** "a, b, c" → ["a","b","c"] (trimmed, de-duped, empties dropped). */
  const parseTags = (raw: string): string[] => [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  ]

  const handleEditCancel = () => {
    setEditing(false)
    setSaveError(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const res = await memorySet({
      data: {
        slug: mem.slug,
        type: editType.trim() || mem.type,
        body: editBody,
        ...(editTitle.trim() ? { title: editTitle.trim() } : {}),
        tags: parseTags(editTags),
      },
    })
    if (res.ok) {
      toast(res.data.changed ? "Memory updated." : "No changes.")
      setEditing(false)
      await router.invalidate()
    } else {
      setSaveError(res.error)
    }
    setSaving(false)
  }

  const handleLoadHistory = async () => {
    if (history !== null) {
      setHistory(null)
      return
    }
    setHistoryLoading(true)
    setHistoryError(null)
    const res = await memoryHistory({ data: { slug: mem.slug } })
    if (res.ok) {
      setHistory(res.data.versions)
    } else {
      setHistoryError(res.error)
    }
    setHistoryLoading(false)
  }

  const handleForget = async () => {
    setForgetting(true)
    const res = await memoryForget({ data: { slug: mem.slug } })
    if (res.ok) {
      toast(`Memory "${mem.slug}" forgotten.`)
      await router.navigate({ to: "/memory" })
    } else {
      toast(`Forget failed: ${res.error}`)
      setForgetting(false)
      setForgetConfirm(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <BackLink />
        <div className="flex items-center gap-2">
          {!editing && (
            <Button variant="outline" size="sm" onClick={handleEditOpen}>
              Edit
            </Button>
          )}
          {forgetConfirm ? (
            <span className="flex items-center gap-1 text-xs">
              <span className="text-muted">Forget?</span>
              <button
                type="button"
                disabled={forgetting}
                onClick={handleForget}
                className="rounded bg-danger px-2 py-0.5 text-accent-ink text-xs hover:bg-danger/90 disabled:opacity-50"
              >
                {forgetting ? "…" : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setForgetConfirm(false)}
                className="rounded border border-border px-2 py-0.5 text-muted text-xs hover:bg-raised"
              >
                No
              </button>
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setForgetConfirm(true)}
              className="text-danger hover:bg-danger/10 hover:text-danger"
            >
              Forget
            </Button>
          )}
        </div>
      </div>

      {/* ── Header ── */}
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-semibold text-2xl tracking-tight">
            {mem.title !== "" ? mem.title : mem.slug}
          </h1>
          <Badge variant="secondary">{mem.type}</Badge>
          <Badge variant="outline">{mem.visibility}</Badge>
        </div>
        {mem.title !== "" && <p className="mt-0.5 font-mono text-muted text-sm">{mem.slug}</p>}
      </header>

      {/* ── Metadata ── */}
      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <MetaRow label="Slug" value={mem.slug} mono />
            <MetaRow label="Type" value={mem.type} />
            <MetaRow label="Visibility" value={mem.visibility} />
            {mem.scope !== null && <MetaRow label="Scope" value={mem.scope} mono />}
            <MetaRow label="Version" value={String(mem.version)} />
            <dt className="font-medium text-muted">Tags</dt>
            <dd>
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-faint">—</span>
              )}
            </dd>
            <MetaRow label="Created" value={mem.createdAt} />
            <MetaRow label="Updated" value={mem.updatedAt} />
          </dl>
        </CardContent>
      </Card>

      {/* ── Body ── */}
      <Card>
        <CardHeader>
          <CardTitle>Body</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <label htmlFor="edit-type" className="text-muted text-sm">
                    Type
                  </label>
                  <input
                    id="edit-type"
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    className="w-full rounded border border-border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <label htmlFor="edit-title" className="text-muted text-sm">
                    Title
                  </label>
                  <input
                    id="edit-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full rounded border border-border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="edit-tags" className="text-muted text-sm">
                  Tags <span className="text-faint">(comma-separated)</span>
                </label>
                <input
                  id="edit-tags"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="e.g. planning, preferences"
                  className="w-full rounded border border-border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent/60"
                />
              </div>
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={16}
                className="w-full rounded-ui border border-border bg-bg p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
              />
              {saveError !== null && (
                <p className="text-danger text-sm">Save failed: {saveError}</p>
              )}
              <div className="flex gap-2">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button variant="outline" onClick={handleEditCancel} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-ui border border-border bg-raised p-4 font-mono text-sm leading-relaxed">
              {mem.body !== "" ? mem.body : <span className="text-faint">No body content.</span>}
            </pre>
          )}
        </CardContent>
      </Card>

      {/* ── History ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>History</CardTitle>
          <Button variant="outline" size="sm" onClick={handleLoadHistory} disabled={historyLoading}>
            {historyLoading ? "Loading…" : history !== null ? "Hide" : "Load"}
          </Button>
        </CardHeader>
        {historyError !== null && (
          <CardContent>
            <p className="text-danger text-sm">Error: {historyError}</p>
          </CardContent>
        )}
        {history !== null && (
          <CardContent>
            {history.length === 0 ? (
              <p className="text-muted text-sm">No revision history.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {history.map((rev) => (
                  <RevisionRow
                    key={rev.revisionId}
                    rev={rev}
                    slug={mem.slug}
                    onRolledBack={async () => {
                      setHistory(null)
                      await router.invalidate()
                    }}
                  />
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  )
}

function RevisionRow({
  rev,
  slug,
  onRolledBack,
}: {
  rev: MemoryRevision
  slug: string
  onRolledBack: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [rolling, setRolling] = useState(false)

  const handleRollback = async () => {
    setRolling(true)
    const res = await memoryRollback({ data: { slug, toRevisionId: rev.revisionId } })
    if (res.ok) {
      toast(`Rolled back to revision ${rev.revisionId} (now v${res.data.version}).`)
      await onRolledBack()
    } else {
      toast(`Rollback failed: ${res.error}`)
      setRolling(false)
      setConfirming(false)
    }
  }

  return (
    <div className="border-border border-b pb-3 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-muted text-xs">v{rev.version}</span>
            <Badge variant="outline">{rev.type}</Badge>
            <span className="text-faint text-xs">{rev.createdAt}</span>
          </div>
          {rev.title !== "" && <span className="text-muted text-sm">{rev.title}</span>}
          {rev.authorUserId !== null && (
            <span className="text-faint text-xs">by {rev.authorUserId}</span>
          )}
          <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-muted text-xs">
            {rev.body.slice(0, 300)}
            {rev.body.length > 300 ? "…" : ""}
          </pre>
        </div>
        <div className="shrink-0">
          {confirming ? (
            <span className="flex items-center gap-1 text-xs">
              <span className="text-muted">Roll back?</span>
              <button
                type="button"
                disabled={rolling}
                onClick={handleRollback}
                className="rounded bg-accent px-2 py-0.5 text-accent-ink text-xs hover:opacity-90 disabled:opacity-50"
              >
                {rolling ? "…" : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-border px-2 py-0.5 text-muted text-xs hover:bg-raised"
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded border border-border px-2 py-0.5 text-muted text-xs hover:bg-raised"
            >
              Roll back
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/memory" className="text-muted text-sm hover:text-ink">
      ← Memory
    </Link>
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="font-medium text-muted">{label}</dt>
      <dd className={mono === true ? "font-mono text-xs text-muted" : "text-muted"}>{value}</dd>
    </>
  )
}

/**
 * Document detail — view, edit, reprocess, or delete a single ingested document.
 * Route: /documents/$id  (id = document uuid)
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { deleteDocument, getDocument, reprocessDocument, updateDocument } from "../server/fns"
import type { DocumentDetail } from "../server/types"

export const Route = createFileRoute("/documents/$id")({
  loader: async ({ params }) => ({
    doc: await getDocument({ data: { documentId: params.id } }),
  }),
  component: () => (
    <RequireAuth>
      <DocumentDetailPage />
    </RequireAuth>
  ),
})

function docStatusVariant(s: string): "default" | "secondary" | "outline" | "warning" {
  if (s === "indexed" || s === "ready") return "default"
  if (s === "processing" || s === "pending" || s === "accepted") return "secondary"
  if (s === "failed" || s === "error") return "warning"
  return "outline"
}

const NON_INDEXED_STATUSES = new Set(["processing", "pending", "failed", "error"])

function DocumentDetailPage() {
  const router = useRouter()
  const { doc: initialDoc } = Route.useLoaderData()

  // Edit state
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reprocess state
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessNotice, setReprocessNotice] = useState<string | null>(null)

  // Delete state
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (!initialDoc.ok) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <p className="text-red-600 text-sm">Error loading document: {initialDoc.error}</p>
      </div>
    )
  }

  const doc: DocumentDetail = initialDoc.data
  const needsReprocess = NON_INDEXED_STATUSES.has(doc.status)

  const handleEditOpen = () => {
    setEditBody(doc.body)
    setSaveError(null)
    setEditing(true)
  }

  const handleEditCancel = () => {
    setEditing(false)
    setSaveError(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const res = await updateDocument({ data: { documentId: doc.id, content: editBody } })
    if (res.ok) {
      setEditing(false)
      await router.invalidate()
    } else {
      setSaveError(res.error)
    }
    setSaving(false)
  }

  const handleReprocess = async () => {
    setReprocessing(true)
    setReprocessNotice(null)
    const res = await reprocessDocument({ data: { documentId: doc.id } })
    if (res.ok) {
      setReprocessNotice(`Queued — new status: ${res.data.status}`)
      await router.invalidate()
    } else {
      setReprocessNotice(`Failed to reprocess: ${res.error}`)
    }
    setReprocessing(false)
  }

  const handleDelete = async () => {
    if (!confirm(`Delete "${doc.title !== "" ? doc.title : doc.slug}"? This cannot be undone.`)) {
      return
    }
    setDeleting(true)
    setDeleteError(null)
    const res = await deleteDocument({ data: { documentId: doc.id } })
    if (res.ok) {
      await router.navigate({ to: "/documents" })
    } else {
      setDeleteError(res.error)
      setDeleting(false)
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
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>

      {deleteError !== null && <p className="text-red-600 text-sm">Delete failed: {deleteError}</p>}

      {/* ── Reprocess banner ── */}
      {needsReprocess && (
        <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-amber-800 text-sm">
            This document has status <strong>{doc.status}</strong> and may not be fully indexed.
          </p>
          <Button
            size="sm"
            onClick={handleReprocess}
            disabled={reprocessing}
            className="ml-4 shrink-0"
          >
            {reprocessing ? "Queuing…" : "Reprocess"}
          </Button>
        </div>
      )}
      {reprocessNotice !== null && <p className="text-neutral-600 text-sm">{reprocessNotice}</p>}

      {/* ── Header ── */}
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-semibold text-2xl tracking-tight">
            {doc.title !== "" ? doc.title : doc.slug}
          </h1>
          <Badge variant={docStatusVariant(doc.status)}>{doc.status}</Badge>
        </div>
        {doc.title !== "" && (
          <p className="mt-0.5 font-mono text-neutral-500 text-sm">{doc.slug}</p>
        )}
      </header>

      {/* ── Metadata ── */}
      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <MetaRow label="ID" value={doc.id} mono />
            <MetaRow label="Slug" value={doc.slug} mono />
            {doc.path !== null && <MetaRow label="Path" value={doc.path} mono />}
            {doc.scope !== null && <MetaRow label="Scope" value={doc.scope} mono />}
            <MetaRow label="Content type" value={doc.contentType} mono />
            <MetaRow label="Chunks" value={String(doc.chunkCount)} />
            <dt className="font-medium text-neutral-500">Tags</dt>
            <dd>
              {doc.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {doc.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-neutral-300">—</span>
              )}
            </dd>
            <MetaRow label="Created" value={doc.createdAt} />
            <MetaRow label="Updated" value={doc.updatedAt} />
          </dl>
        </CardContent>
      </Card>

      {/* ── Reprocess (non-prominent placement for indexed docs) ── */}
      {!needsReprocess && (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleReprocess} disabled={reprocessing}>
            {reprocessing ? "Queuing…" : "Reprocess"}
          </Button>
          {reprocessNotice !== null && (
            <span className="text-neutral-600 text-sm">{reprocessNotice}</span>
          )}
        </div>
      )}

      {/* ── Body ── */}
      <Card>
        <CardHeader>
          <CardTitle>Body</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="flex flex-col gap-3">
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                rows={20}
                className="w-full rounded-md border border-neutral-200 bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
              />
              {saveError !== null && (
                <p className="text-red-600 text-sm">Save failed: {saveError}</p>
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
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-neutral-100 bg-neutral-50 p-4 font-mono text-sm leading-relaxed">
              {doc.body !== "" ? (
                doc.body
              ) : (
                <span className="text-neutral-300">No body content.</span>
              )}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/documents" className="text-neutral-500 text-sm hover:text-neutral-800">
      ← Documents
    </Link>
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="font-medium text-neutral-500">{label}</dt>
      <dd className={mono === true ? "font-mono text-xs text-neutral-700" : "text-neutral-700"}>
        {value}
      </dd>
    </>
  )
}

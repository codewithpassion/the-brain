/**
 * Add Document — paste text/markdown or upload a file (.md/.txt/.html/.pdf/.docx/image).
 * The server fn `ingestDocument` base64-encodes the body and POSTs to the API /documents
 * endpoint, which runs the standard fingerprint → R2 → chunk → embed → index pipeline.
 */
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ChangeEvent, type FormEvent, useRef, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { EXT_TO_CONTENT_TYPE } from "../lib/content-types"
import { ingestDocument } from "../server/fns"

export { EXT_TO_CONTENT_TYPE }

export const Route = createFileRoute("/ingest")({
  component: () => (
    <RequireAuth>
      <IngestPage />
    </RequireAuth>
  ),
})

/** Maximum upload size (8 MiB) — mirrors MAX_BODY_BYTES from @brain/shared. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Base64-encode an ArrayBuffer for transmission via the server fn JSON transport. */
const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf)
  let binary = ""
  // Chunk to avoid stack overflow on large files.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

type Tab = "paste" | "file"

type SuccessResult = {
  slug: string
  status: string
  documentId: string | null
  chunkCount: number
  tags: string
  path: string
}

function IngestPage() {
  const [tab, setTab] = useState<Tab>("paste")
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [tags, setTags] = useState("")
  const [path, setPath] = useState("")

  // Paste tab state
  const [pasteText, setPasteText] = useState("")

  // File tab state
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<SuccessResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setSuccess(null)
    setError(null)
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null
    setFile(picked)
    reset()
    if (picked && !title) setTitle(picked.name.replace(/\.[^.]+$/, ""))
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    reset()

    let buf: ArrayBuffer
    let contentType: string

    if (tab === "paste") {
      const text = pasteText.trim()
      if (!text) {
        setError("Paste some markdown or text before submitting.")
        return
      }
      buf = new TextEncoder().encode(text).buffer as ArrayBuffer
      contentType = "text/markdown"
    } else {
      if (!file) {
        setError("Please choose a file to upload.")
        return
      }
      const ext = (file.name.split(".").pop() ?? "").toLowerCase()
      const ct = EXT_TO_CONTENT_TYPE[ext]
      if (!ct) {
        setError(
          `Unsupported file type ".${ext}". Accepted: .md .txt .html .pdf .docx .jpg .png .gif .webp`,
        )
        return
      }
      if (file.size > MAX_BODY_BYTES) {
        setError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MiB). Max is 8 MiB.`)
        return
      }
      buf = await file.arrayBuffer()
      contentType = ct
    }

    setLoading(true)
    const body = toBase64(buf)
    const submittedTags = tags.trim()
    const submittedPath = path.trim()
    const res = await ingestDocument({
      data: {
        contentType,
        body,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(submittedTags ? { tags: submittedTags } : {}),
        ...(submittedPath ? { path: submittedPath } : {}),
      },
    })
    setLoading(false)

    if (res.ok) {
      setSuccess({
        slug: res.data.slug,
        status: res.data.status,
        documentId: res.data.documentId,
        chunkCount: res.data.chunkCount,
        tags: submittedTags,
        path: submittedPath,
      })
    } else {
      setError(res.error)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Add Document</h1>
        <p className="text-neutral-500 text-sm">
          Ingest a document into the brain. It will appear in the{" "}
          <Link to="/documents" className="underline">
            Documents catalog
          </Link>{" "}
          and become searchable via <code className="font-mono">think</code>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Document</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {/* Tab switcher */}
            <div className="flex gap-1 rounded-lg bg-neutral-100 p-1 text-sm w-fit">
              <button
                type="button"
                onClick={() => {
                  setTab("paste")
                  reset()
                }}
                className={
                  tab === "paste"
                    ? "rounded-md bg-white px-4 py-1.5 font-medium shadow-sm"
                    : "rounded-md px-4 py-1.5 text-neutral-600 hover:bg-neutral-200"
                }
              >
                Paste Text
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab("file")
                  reset()
                }}
                className={
                  tab === "file"
                    ? "rounded-md bg-white px-4 py-1.5 font-medium shadow-sm"
                    : "rounded-md px-4 py-1.5 text-neutral-600 hover:bg-neutral-200"
                }
              >
                Upload File
              </button>
            </div>

            {/* Paste tab */}
            {tab === "paste" && (
              <div className="flex flex-col gap-2">
                <label htmlFor="paste-body" className="font-medium text-sm text-neutral-700">
                  Markdown / plain text
                </label>
                <textarea
                  id="paste-body"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="# My Document&#10;&#10;Paste your markdown or text here…"
                  rows={12}
                  className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                />
              </div>
            )}

            {/* File upload tab */}
            {tab === "file" && (
              <div className="flex flex-col gap-2">
                <label htmlFor="file-input" className="font-medium text-sm text-neutral-700">
                  File{" "}
                  <span className="font-normal text-neutral-400">
                    (.md .txt .html .pdf .docx .jpg .png .gif .webp — max 8 MiB)
                  </span>
                </label>
                <input
                  id="file-input"
                  ref={fileRef}
                  type="file"
                  accept=".md,.txt,.html,.htm,.pdf,.docx,.jpg,.jpeg,.png,.gif,.webp"
                  onChange={onFileChange}
                  className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm file:font-medium"
                />
                {file && (
                  <p className="text-neutral-500 text-xs">
                    {file.name} · {(file.size / 1024).toFixed(1)} KiB
                  </p>
                )}
              </div>
            )}

            {/* Optional metadata */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-title" className="font-medium text-sm text-neutral-700">
                  Title <span className="font-normal text-neutral-400">(optional)</span>
                </label>
                <Input
                  id="doc-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My Document"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-slug" className="font-medium text-sm text-neutral-700">
                  Slug{" "}
                  <span className="font-normal text-neutral-400">(optional — auto if blank)</span>
                </label>
                <Input
                  id="doc-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="my-document"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-tags" className="font-medium text-sm text-neutral-700">
                  Tags{" "}
                  <span className="font-normal text-neutral-400">(optional — comma-separated)</span>
                </label>
                <Input
                  id="doc-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="architecture, api, v2"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-path" className="font-medium text-sm text-neutral-700">
                  Path <span className="font-normal text-neutral-400">(optional — namespace)</span>
                </label>
                <Input
                  id="doc-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/project/x"
                />
              </div>
            </div>

            <Button type="submit" disabled={loading} className="w-fit">
              {loading ? "Ingesting…" : "Add Document"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Success panel */}
      {success !== null && (
        <Card>
          <CardContent className="pt-6 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  success.status === "indexed"
                    ? "default"
                    : success.status === "duplicate"
                      ? "secondary"
                      : "outline"
                }
              >
                {success.status}
              </Badge>
              <span className="font-mono text-sm">{success.slug}</span>
              {success.path && (
                <span className="font-mono text-neutral-500 text-xs">{success.path}</span>
              )}
            </div>
            {success.tags && (
              <div className="flex flex-wrap gap-1">
                {success.tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((t) => (
                    <Badge key={t} variant="secondary">
                      {t}
                    </Badge>
                  ))}
              </div>
            )}
            {success.status === "indexed" && (
              <p className="text-neutral-600 text-sm">
                Indexed {success.chunkCount} chunk(s). The document is now searchable.
              </p>
            )}
            {success.status === "accepted" && (
              <p className="text-neutral-600 text-sm">
                Accepted for background ingestion. Check the{" "}
                <Link to="/documents" className="underline">
                  Documents
                </Link>{" "}
                page in a moment.
              </p>
            )}
            {success.status === "duplicate" && (
              <p className="text-neutral-600 text-sm">
                A document with this content or slug already exists — no changes made.
              </p>
            )}
            <Link to="/documents" className="text-sm text-neutral-500 underline">
              View Documents catalog →
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Error panel */}
      {error !== null && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-600 text-sm">Error: {error}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

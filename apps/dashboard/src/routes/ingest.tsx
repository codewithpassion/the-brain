/**
 * Add Document — paste text/markdown or upload a file (.md/.txt/.html/.pdf/.docx/image).
 * The server fn `ingestDocument` base64-encodes the body and POSTs to the API /documents
 * endpoint, which runs the standard fingerprint → R2 → chunk → embed → index pipeline.
 */

import { AUDIO_MAX_BYTES, MAX_BODY_BYTES } from "@brain/shared"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ChangeEvent, type FormEvent, useRef, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { AUDIO_EXTS, EXT_TO_CONTENT_TYPE } from "../lib/content-types"
import { addThought, ingestDocument } from "../server/fns"

export { EXT_TO_CONTENT_TYPE }

/** MiB for user-facing copy — derived from the shared byte caps so text can't drift from the limit. */
const MAX_BODY_MIB = Math.round(MAX_BODY_BYTES / (1024 * 1024))
const AUDIO_MAX_MIB = Math.round(AUDIO_MAX_BYTES / (1024 * 1024))

export const Route = createFileRoute("/ingest")({
  component: () => (
    <RequireAuth>
      <IngestPage />
    </RequireAuth>
  ),
})

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

  // Quick-thought box state (independent of the document form).
  const [thought, setThought] = useState("")
  const [thoughtLoading, setThoughtLoading] = useState(false)
  const [thoughtSlug, setThoughtSlug] = useState<string | null>(null)
  const [thoughtError, setThoughtError] = useState<string | null>(null)

  const reset = () => {
    setSuccess(null)
    setError(null)
  }

  const onThoughtSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setThoughtSlug(null)
    setThoughtError(null)
    const text = thought.trim()
    if (!text) {
      setThoughtError("Write a thought before capturing it.")
      return
    }
    setThoughtLoading(true)
    try {
      const res = await addThought({ data: { thought: text } })
      if (res.ok) {
        setThought("")
        setThoughtSlug(res.data.slug)
      } else {
        setThoughtError(res.error)
      }
    } catch (err) {
      setThoughtError(err instanceof Error ? err.message : "capture failed")
    } finally {
      setThoughtLoading(false)
    }
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
          `Unsupported file type ".${ext}". Accepted: .md .txt .html .pdf .docx .jpg .png .gif .webp .m4a .mp3 .wav`,
        )
        return
      }
      const isAudio = AUDIO_EXTS.has(ext)
      const cap = isAudio ? AUDIO_MAX_BYTES : MAX_BODY_BYTES
      if (file.size > cap) {
        const capMiB = isAudio ? AUDIO_MAX_MIB : MAX_BODY_MIB
        setError(
          `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MiB). Max is ${capMiB} MiB.`,
        )
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
        <p className="text-muted text-sm">
          Ingest a document into the brain. It will appear in the{" "}
          <Link to="/documents" className="underline">
            Documents catalog
          </Link>{" "}
          and become searchable via <code className="font-mono">think</code>.
        </p>
      </header>

      {/* Quick thought — one-line capture into brain/thoughts/<yyyy-mm>. */}
      <Card>
        <CardHeader>
          <CardTitle>Quick thought</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onThoughtSubmit} className="flex flex-col gap-2">
            <textarea
              id="quick-thought"
              value={thought}
              onChange={(e) => setThought(e.target.value)}
              placeholder="Jot a quick thought… (stored under brain/thoughts, tagged 'thought')"
              rows={3}
              className="w-full rounded-ui border border-border bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/60"
            />
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={thoughtLoading} className="w-fit">
                {thoughtLoading ? "Capturing…" : "Capture thought"}
              </Button>
              {thoughtSlug && (
                <span className="text-muted text-sm">
                  Captured · <span className="font-mono">{thoughtSlug}</span>
                </span>
              )}
              {thoughtError && <span className="text-danger text-sm">{thoughtError}</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Document</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {/* Tab switcher */}
            <div className="flex gap-1 rounded-ui bg-raised p-1 text-sm w-fit">
              <button
                type="button"
                onClick={() => {
                  setTab("paste")
                  reset()
                }}
                className={
                  tab === "paste"
                    ? "rounded-ui bg-surface px-4 py-1.5 font-medium shadow-sm"
                    : "rounded-ui px-4 py-1.5 text-muted hover:bg-raised"
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
                    ? "rounded-ui bg-surface px-4 py-1.5 font-medium shadow-sm"
                    : "rounded-ui px-4 py-1.5 text-muted hover:bg-raised"
                }
              >
                Upload File
              </button>
            </div>

            {/* Paste tab */}
            {tab === "paste" && (
              <div className="flex flex-col gap-2">
                <label htmlFor="paste-body" className="font-medium text-sm text-muted">
                  Markdown / plain text
                </label>
                <textarea
                  id="paste-body"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="# My Document&#10;&#10;Paste your markdown or text here…"
                  rows={12}
                  className="w-full rounded-ui border border-border bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
              </div>
            )}

            {/* File upload tab */}
            {tab === "file" && (
              <div className="flex flex-col gap-2">
                <label htmlFor="file-input" className="font-medium text-sm text-muted">
                  File{" "}
                  <span className="font-normal text-faint">
                    (.md .txt .html .pdf .docx .jpg .png .gif .webp — max {MAX_BODY_MIB} MiB; .m4a
                    .mp3 .wav voice memos — max {AUDIO_MAX_MIB} MiB, transcribed automatically)
                  </span>
                </label>
                <input
                  id="file-input"
                  ref={fileRef}
                  type="file"
                  accept=".md,.txt,.html,.htm,.pdf,.docx,.jpg,.jpeg,.png,.gif,.webp,.m4a,.mp3,.wav"
                  onChange={onFileChange}
                  className="block w-full rounded-ui border border-border bg-bg px-3 py-2 text-sm text-ink file:mr-3 file:rounded file:border-0 file:bg-raised file:px-3 file:py-1 file:text-sm file:font-medium"
                />
                {file && (
                  <p className="text-muted text-xs">
                    {file.name} · {(file.size / 1024).toFixed(1)} KiB
                  </p>
                )}
              </div>
            )}

            {/* Optional metadata */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-title" className="font-medium text-sm text-muted">
                  Title <span className="font-normal text-faint">(optional)</span>
                </label>
                <Input
                  id="doc-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My Document"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-slug" className="font-medium text-sm text-muted">
                  Slug <span className="font-normal text-faint">(optional — auto if blank)</span>
                </label>
                <Input
                  id="doc-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="my-document"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-tags" className="font-medium text-sm text-muted">
                  Tags <span className="font-normal text-faint">(optional — comma-separated)</span>
                </label>
                <Input
                  id="doc-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="architecture, api, v2"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="doc-path" className="font-medium text-sm text-muted">
                  Path <span className="font-normal text-faint">(optional — namespace)</span>
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
              {success.path && <span className="font-mono text-muted text-xs">{success.path}</span>}
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
              <p className="text-muted text-sm">
                Indexed {success.chunkCount} chunk(s). The document is now searchable.
              </p>
            )}
            {success.status === "accepted" && (
              <p className="text-muted text-sm">
                Accepted for background ingestion. Check the{" "}
                <Link to="/documents" className="underline">
                  Documents
                </Link>{" "}
                page in a moment.
              </p>
            )}
            {success.status === "duplicate" && (
              <p className="text-muted text-sm">
                A document with this content or slug already exists — no changes made.
              </p>
            )}
            <Link to="/documents" className="text-sm text-muted underline">
              View Documents catalog →
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Error panel */}
      {error !== null && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-danger text-sm">Error: {error}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

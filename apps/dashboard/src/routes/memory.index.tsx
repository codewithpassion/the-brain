/**
 * Memory list — browse OKF agent-memory items, create new ones, and export/import OKF bundles.
 * Route: /memory/
 */
import { createFileRoute, Link } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { RequireAuth } from "../components/RequireAuth"
import { toast } from "../components/Toaster"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { memoryList, memorySet, okfExport, okfImport } from "../server/fns"
import type { MemoryItem, OkfFile } from "../server/types"

export const Route = createFileRoute("/memory/")({
  loader: async () => ({
    memories: await memoryList({ data: {} }),
  }),
  component: () => (
    <RequireAuth>
      <MemoryListPage />
    </RequireAuth>
  ),
})

function MemoryListPage() {
  const { memories: initial } = Route.useLoaderData()
  const [memories, setMemories] = useState(initial)
  const [listLoading, setListLoading] = useState(false)

  // Filter state
  const [pathFilter, setPathFilter] = useState("")
  const [prefixFilter, setPrefixFilter] = useState(false)

  // New memory form state
  const [newSlug, setNewSlug] = useState("")
  const [newType, setNewType] = useState("")
  const [newTags, setNewTags] = useState("")
  const [newBody, setNewBody] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // OKF export state
  const [exportData, setExportData] = useState<{
    okfVersion: string
    count: number
    files: OkfFile[]
  } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // OKF import state
  const [importPath, setImportPath] = useState("")
  const [importContent, setImportContent] = useState("")
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{
    imported: number
    skipped: number
    failed: number
  } | null>(null)

  const loadMemories = async (path?: string, prefix?: boolean) => {
    setListLoading(true)
    const res = await memoryList({
      data: {
        ...(path ? { path } : {}),
        ...(prefix !== undefined ? { prefix } : {}),
      },
    })
    if (res.ok) setMemories(res)
    else toast(`Load failed: ${res.error}`)
    setListLoading(false)
  }

  const onFilterSubmit = async (e: FormEvent) => {
    e.preventDefault()
    await loadMemories(pathFilter.trim() || undefined, prefixFilter)
  }

  const clearFilters = async () => {
    setPathFilter("")
    setPrefixFilter(false)
    await loadMemories()
  }

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!(newSlug.trim() && newType.trim())) return
    setCreating(true)
    setCreateError(null)
    const tags = [
      ...new Set(
        newTags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      ),
    ]
    const res = await memorySet({
      data: { slug: newSlug.trim(), type: newType.trim(), body: newBody, tags },
    })
    if (res.ok) {
      toast(`Memory "${res.data.slug}" ${res.data.changed ? "created" : "unchanged"}.`)
      setNewSlug("")
      setNewType("")
      setNewTags("")
      setNewBody("")
      await loadMemories(pathFilter.trim() || undefined, prefixFilter)
    } else {
      setCreateError(res.error)
    }
    setCreating(false)
  }

  const handleExport = async () => {
    setExporting(true)
    setExportError(null)
    setExportData(null)
    const res = await okfExport()
    if (res.ok) {
      setExportData(res.data)
    } else {
      setExportError(res.error)
    }
    setExporting(false)
  }

  const handleImport = async (e: FormEvent) => {
    e.preventDefault()
    if (!(importPath.trim() && importContent.trim())) return
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    const res = await okfImport({
      data: { files: [{ path: importPath.trim(), content: importContent }] },
    })
    if (res.ok) {
      setImportResult({
        imported: res.data.imported,
        skipped: res.data.skipped,
        failed: res.data.failed,
      })
      toast(
        `OKF import: ${res.data.imported} imported, ${res.data.skipped} skipped, ${res.data.failed} failed.`,
      )
      await loadMemories(pathFilter.trim() || undefined, prefixFilter)
    } else {
      setImportError(res.error)
    }
    setImporting(false)
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast("Copied!"))
  }

  const downloadAll = () => {
    if (!exportData) return
    const combined = exportData.files
      .map((f) => `<!-- ${f.path} -->\n${f.content}`)
      .join("\n\n---\n\n")
    const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(combined)}`
    const a = document.createElement("a")
    a.href = url
    a.download = "okf-export.md"
    a.click()
  }

  const memList: MemoryItem[] = memories.ok ? memories.data.memories : []

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">Memory</h1>
        <p className="text-neutral-500 text-sm">OKF agent-memory items.</p>
      </header>

      {/* ── List + filter ── */}
      <Card>
        <CardHeader>
          <CardTitle>Memories ({memories.ok ? memList.length : 0})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={onFilterSubmit} className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1 min-w-48">
              <label htmlFor="mem-path" className="text-neutral-500 text-xs font-medium">
                Path filter
              </label>
              <Input
                id="mem-path"
                value={pathFilter}
                onChange={(e) => setPathFilter(e.target.value)}
                placeholder="e.g. /project/x"
                className="h-8 text-sm"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm pb-0.5">
              <input
                type="checkbox"
                checked={prefixFilter}
                onChange={(e) => setPrefixFilter(e.target.checked)}
                className="rounded"
              />
              <span className="text-neutral-700">Whole subtree</span>
            </label>
            <Button type="submit" disabled={listLoading} className="h-8 text-sm">
              {listLoading ? "Loading…" : "Apply"}
            </Button>
            {(pathFilter || prefixFilter) && (
              <button
                type="button"
                onClick={clearFilters}
                className="h-8 px-3 text-sm text-neutral-500 hover:text-neutral-800"
              >
                Clear
              </button>
            )}
          </form>

          {!memories.ok && (
            <p className="text-neutral-500 text-sm">Unavailable: {memories.error}</p>
          )}

          {memories.ok &&
            (memList.length === 0 ? (
              <p className="text-neutral-500 text-sm">No memories found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-neutral-400">
                      <th className="pb-1 font-medium">Slug</th>
                      <th className="pb-1 font-medium">Type</th>
                      <th className="pb-1 font-medium">Title</th>
                      <th className="pb-1 font-medium">Ver</th>
                      <th className="pb-1 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memList.map((m) => (
                      <tr key={m.slug} className="border-neutral-100 border-t">
                        <td className="py-1.5 font-mono text-xs">
                          <Link
                            to="/memory/$"
                            params={{ _splat: m.slug }}
                            className="hover:underline"
                          >
                            {m.slug}
                          </Link>
                        </td>
                        <td className="py-1.5 text-neutral-600">{m.type}</td>
                        <td className="py-1.5 text-neutral-700">
                          {m.title !== "" ? m.title : "—"}
                        </td>
                        <td className="py-1.5 text-neutral-500">{m.version}</td>
                        <td className="py-1.5 text-neutral-500 text-xs">{m.updatedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </CardContent>
      </Card>

      {/* ── New memory ── */}
      <Card>
        <CardHeader>
          <CardTitle>New memory</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3 max-w-lg">
            <div className="flex gap-2">
              <div className="flex flex-col gap-1 flex-1">
                <label htmlFor="new-slug" className="text-neutral-700 text-sm">
                  Slug
                </label>
                <Input
                  id="new-slug"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  placeholder="e.g. /project/decision"
                  className="text-sm font-mono"
                />
              </div>
              <div className="flex flex-col gap-1 w-36">
                <label htmlFor="new-type" className="text-neutral-700 text-sm">
                  Type
                </label>
                <Input
                  id="new-type"
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  placeholder="e.g. decision"
                  className="text-sm"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="new-tags" className="text-neutral-700 text-sm">
                Tags <span className="text-neutral-400">(comma-separated)</span>
              </label>
              <Input
                id="new-tags"
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                placeholder="e.g. planning, preferences"
                className="text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="new-body" className="text-neutral-700 text-sm">
                Body
              </label>
              <textarea
                id="new-body"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-neutral-200 bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
              />
            </div>
            {createError !== null && <p className="text-red-600 text-sm">{createError}</p>}
            <div>
              <Button type="submit" disabled={creating || !newSlug.trim() || !newType.trim()}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ── OKF Export ── */}
      <Card>
        <CardHeader>
          <CardTitle>OKF Export</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              {exporting ? "Exporting…" : "Export all"}
            </Button>
            {exportData !== null && (
              <button
                type="button"
                onClick={downloadAll}
                className="rounded border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                Download bundle
              </button>
            )}
          </div>
          {exportError !== null && (
            <p className="text-red-600 text-sm">Export failed: {exportError}</p>
          )}
          {exportData !== null && (
            <div className="flex flex-col gap-3">
              <p className="text-neutral-500 text-xs">
                {exportData.count} file(s) · OKF {exportData.okfVersion}
              </p>
              {exportData.files.map((f) => (
                <div
                  key={f.path}
                  className="rounded-md border border-neutral-100 bg-neutral-50 p-3"
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-mono text-neutral-600 text-xs">{f.path}</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(f.content)}
                      className="rounded border border-neutral-200 bg-white px-2 py-0.5 text-neutral-600 text-xs hover:bg-neutral-50"
                    >
                      Copy
                    </button>
                  </div>
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-neutral-700">
                    {f.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── OKF Import ── */}
      <Card>
        <CardHeader>
          <CardTitle>OKF Import</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleImport} className="flex flex-col gap-3 max-w-lg">
            <div className="flex flex-col gap-1">
              <label htmlFor="import-path" className="text-neutral-700 text-sm">
                File path
              </label>
              <Input
                id="import-path"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                placeholder="e.g. /project/decision.md"
                className="text-sm font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="import-content" className="text-neutral-700 text-sm">
                File content (OKF markdown)
              </label>
              <textarea
                id="import-content"
                value={importContent}
                onChange={(e) => setImportContent(e.target.value)}
                rows={8}
                className="w-full rounded-md border border-neutral-200 bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
                placeholder="---&#10;type: decision&#10;title: My Decision&#10;---&#10;&#10;Body content here."
              />
            </div>
            {importError !== null && (
              <p className="text-red-600 text-sm">Import failed: {importError}</p>
            )}
            {importResult !== null && (
              <p className="text-neutral-600 text-sm">
                Done: {importResult.imported} imported, {importResult.skipped} skipped,{" "}
                {importResult.failed} failed.
              </p>
            )}
            <div>
              <Button
                type="submit"
                disabled={importing || !importPath.trim() || !importContent.trim()}
              >
                {importing ? "Importing…" : "Import"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * "Import bundle" (W5/2b) — upload an OKF `.zip`, unzip it CLIENT-SIDE (fflate), and POST the files to
 * `wiki_import_bundle`. No server-side fetch/URL. Imported pages land under `imported/<namespace>/…`
 * as PRIVATE drafts, excluded from search + the dream engine until a human reviews + promotes them
 * (the untrusted-ingress posture is enforced server-side; this UI just surfaces the outcome).
 */
import { useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { readZipToFiles } from "../lib/download-bundle"
import { wikiImportBundle } from "../server/fns"
import { Button } from "./ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"

export function ImportBundle() {
  const router = useRouter()
  const [namespace, setNamespace] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    imported: number
    skipped: number
    failed: number
  } | null>(null)

  const run = async () => {
    if (file === null || namespace.trim().length === 0) {
      setError("Pick a .zip and a namespace.")
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const files = await readZipToFiles(file)
      const res = await wikiImportBundle({ data: { files, namespace: namespace.trim() } })
      if (!res.ok) {
        setError(res.error)
      } else {
        setResult({
          imported: res.data.imported,
          skipped: res.data.skipped,
          failed: res.data.failed,
        })
        await router.invalidate()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed")
    }
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import bundle</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-neutral-500 text-sm">
          Upload an OKF <span className="font-mono">.zip</span>. Imported pages land under{" "}
          <span className="font-mono">imported/&lt;namespace&gt;/…</span> as{" "}
          <strong>private drafts</strong>, kept out of search until you review + publish them.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            placeholder="namespace (e.g. acme)"
            className="w-48 rounded border border-neutral-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-400"
          />
          <input
            type="file"
            accept=".zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-neutral-600 text-sm"
          />
          <Button onClick={run} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </div>
        {error !== null && <p className="text-red-600 text-sm">Import failed: {error}</p>}
        {result !== null && (
          <p className="text-neutral-700 text-sm">
            Imported {result.imported} · skipped {result.skipped} · failed {result.failed}. Find
            them under the <span className="font-mono">imported</span> namespace (Drafts).
          </p>
        )}
      </CardContent>
    </Card>
  )
}

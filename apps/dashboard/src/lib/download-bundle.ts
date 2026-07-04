/**
 * Client-side OKF bundle zip + download (W5/2a). The Worker returns `files[]`; the browser packages
 * them into a `.zip` with fflate (pure-JS, no server-side zip, no URL fetch) and triggers a download.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"

/** Read a `.zip` File into OKF `{path,content}[]` in the browser (unzip client-side; only .md/.markdown). */
export const readZipToFiles = async (file: File): Promise<{ path: string; content: string }[]> => {
  const buf = new Uint8Array(await file.arrayBuffer())
  const entries = unzipSync(buf)
  const files: { path: string; content: string }[] = []
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/")) continue // directory entry
    files.push({ path, content: strFromU8(bytes) })
  }
  return files
}

/** Zip `files[]` and download as `<name>.okf.zip`. Browser-only (uses Blob + a temp anchor). */
export const downloadBundle = (files: { path: string; content: string }[], name: string): void => {
  const entries: Record<string, Uint8Array> = {}
  for (const f of files) entries[f.path] = strToU8(f.content)
  const zipped = zipSync(entries, { level: 6 })
  // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob type-checks (BlobPart).
  const bytes = new Uint8Array(zipped)
  const blob = new Blob([bytes], { type: "application/zip" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${name}.okf.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Obsidian vault importer (Phase 1, docs/obsidian-brain-integration-plan.md §4).
 *
 * Enumerates a Remotely-Save R2 vault (prefix `vault/`) and emits one `kind:"doc"` item per
 * markdown note for the backfill pipeline. Each note becomes a searchable Brain document with:
 *   - `slug`    — vault-relative path minus extension (stable identity, e.g. "Projects/Acme/notes")
 *   - `path`    — normalised folder prefix (e.g. "/Projects/Acme") for scoped search/think
 *   - `tags`    — extracted from YAML frontmatter (flow array or block sequence)
 *   - `fingerprint` — "obsidian:<R2 ETag>" — unchanged notes dedup for free via the
 *                    `(tenant_id, scope, fingerprint)` UNIQUE index; only changed notes re-ingest
 *   - `content` — raw markdown body (staged by `runEnumerate` for the ingest consumer)
 *
 * `VaultR2` is a structural interface satisfied by `ScopedR2` from `@brain/db`. We do NOT import
 * `ScopedR2` directly: `@brain/db` → `@brain/ingest` already, so the reverse would be circular.
 *
 * NOTE: `parseDocument` from `@brain/db/memory/okf` cannot be imported for the same reason.
 * The minimal `extractTags` below covers the Obsidian-relevant frontmatter shapes.
 *
 * Items masquerade as `ImportedSession` (client:"obsidian", turns:[]) so they pass through the
 * existing `ImportBatch` type without widening the union. The extra doc fields (content,
 * contentType, path, tags) are consumed by `runEnumerate` (enumerate.ts) for staging and message
 * assembly; they are NOT session semantics.
 */
import type { ImportBatch, ImportedSession, ImportedTurn, Importer } from "./types"

// ── VaultR2 interface ─────────────────────────────────────────────────────────────────────────

/**
 * The minimal R2 surface the Obsidian importer needs. Satisfied structurally by `ScopedR2`
 * (from `@brain/db`) — callers may pass `services.blobs` directly.
 */
export interface VaultR2 {
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: { key: string; etag: string }[]
    truncated: boolean
    cursor?: string
  }>
  get(key: string): Promise<{ text(): Promise<string> } | null>
}

// ── Internal cursor types ──────────────────────────────────────────────────────────────────────

/** An enumerated vault file entry (in-memory only; never persisted in the cursor). */
interface ObsidianFile {
  /** Tenant-relative R2 key (e.g. "vault/Projects/Acme/notes.md"). */
  relKey: string
  /** Path within the vault, after stripping the vault prefix (e.g. "Projects/Acme/notes.md"). */
  vaultPath: string
  /** R2 ETag — content hash basis for delta detection. */
  etag: string
}

/**
 * Serialisable cursor persisted to `backfill_runs.cursor` between `nextBatch` calls.
 * SMALL by design — only the current position into the sorted file list. The file list
 * itself is rebuilt in-memory by `begin()` on each run (fresh or resumed), keeping the
 * cursor O(1) regardless of vault size (previously O(n) → D1 row-size issues on large vaults).
 */
interface ObsidianCursor {
  index: number
}

/** Files emitted per `nextBatch` call. Caps D1 cursor-persist volume to O(vault / BATCH_SIZE). */
const BATCH_SIZE = 25

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

/**
 * Minimal YAML frontmatter `tags` extractor. Handles the three Obsidian-common shapes:
 *   flow array:   `tags: [sales, revenue]`
 *   block sequence: `tags:\n  - sales\n  - revenue`
 *   scalar:       `tags: sales`
 * Cannot import `parseDocument` from `@brain/db/memory/okf` (circular dep); this covers Phase 1.
 */
const extractTags = (content: string): string[] => {
  // No `m` flag: frontmatter must be at file start; the `m` flag would let mid-body `---` pairs
  // be mis-parsed as frontmatter (okf's parseDocument uses the same anchored approach).
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (fmMatch === null) return []
  const lines = (fmMatch[1] ?? "").split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i++] ?? ""
    if (!line.startsWith("tags:")) continue
    const rest = line.slice("tags:".length).trim()
    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Flow array: tags: [a, b, c]
      return rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter((s) => s.length > 0)
    }
    if (rest.length > 0) {
      // Scalar: tags: something
      return [rest.replace(/^['"]|['"]$/g, "")]
    }
    // Block sequence:
    //   tags:
    //     - a
    //     - b
    const tags: string[] = []
    while (i < lines.length) {
      const itemMatch = /^\s*-\s+(.*)$/.exec(lines[i] ?? "")
      if (itemMatch === null) break
      const tag = (itemMatch[1] ?? "").trim().replace(/^['"]|['"]$/g, "")
      if (tag.length > 0) tags.push(tag)
      i++
    }
    return tags
  }
  return []
}

/**
 * Derive the Brain slug and path from a vault-relative note path.
 *   vaultPath "Projects/Acme/notes.md" → slug "Projects/Acme/notes", path "/Projects/Acme"
 *   vaultPath "inbox.md"               → slug "inbox",                path "/"
 */
const pathParts = (vaultPath: string): { slug: string; path: string } => {
  const slug = vaultPath.replace(/\.(md|markdown)$/i, "")
  const lastSlash = slug.lastIndexOf("/")
  const path = lastSlash === -1 ? "/" : `/${slug.slice(0, lastSlash)}`
  return { slug, path }
}

// ── Factory ────────────────────────────────────────────────────────────────────────────────────

/**
 * Build an Obsidian vault importer over an R2-backed vault prefix.
 *
 * @param blobs        Tenant-scoped R2 (pass `services.blobs` from BackfillServices).
 * @param opts.vaultPrefix  Tenant-relative prefix where vault files live (default `"vault/"`).
 */
export const createObsidianImporter = (
  blobs: VaultR2,
  opts: { vaultPrefix?: string } = {},
): Importer => {
  const vaultPrefix = opts.vaultPrefix ?? "vault/"
  // Populated by begin(); consumed by nextBatch(). Lives only in memory — never serialised.
  let cachedFiles: ObsidianFile[] | null = null

  return {
    source: "obsidian",

    /**
     * List all `.md`/`.markdown` files under `vaultPrefix`, sort deterministically, and cache
     * them in the closure for `nextBatch`. Both fresh and resumed runs always re-list — the
     * vault state may have changed since the last cursor was written. The cursor carries ONLY
     * the position (`{index}`), so it is O(1) regardless of vault size.
     *
     * On resume, `opts.resumeCursor` carries the saved `{index}` written by the last
     * successful `nextBatch`; `begin` starts the cursor there so no already-processed notes
     * are re-enumerated.
     */
    begin: async (beginOpts) => {
      const files: ObsidianFile[] = []
      let listCursor: string | undefined
      do {
        const result = await blobs.list({
          prefix: vaultPrefix,
          limit: 1000,
          ...(listCursor !== undefined ? { cursor: listCursor } : {}),
        })
        for (const obj of result.objects) {
          if (!/\.(md|markdown)$/i.test(obj.key)) continue
          // Absolute R2 key → tenant-relative: the tenant prefix has no "/", so the first segment
          // is always the tenant id.  e.g. "org_abc123/vault/foo.md" → "vault/foo.md"
          const relKey = obj.key.slice(obj.key.indexOf("/") + 1)
          const vaultPath = relKey.slice(vaultPrefix.length)
          if (vaultPath.length === 0) continue // root prefix key; not a file
          // Phase 2 loop-avoidance: skip Brain-authored files so vault_writeback notes are never
          // re-ingested as user edits. Primary filter: path prefix; files with `source: brain`
          // frontmatter would also be caught here by the path check since vault_writeback writes
          // exclusively under `Brain/`.
          if (vaultPath.startsWith("Brain/")) continue
          files.push({ relKey, vaultPath, etag: obj.etag })
        }
        listCursor = result.truncated ? result.cursor : undefined
      } while (listCursor !== undefined)

      // Deterministic order is required for stable resume-by-index across runs.
      files.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath))
      cachedFiles = files

      if (files.length === 0) return { cursor: null }

      // Honor resumeCursor: pick up at the saved index; start at 0 for a fresh run.
      let startIndex = 0
      if (beginOpts.resumeCursor !== undefined) {
        const saved = JSON.parse(beginOpts.resumeCursor) as ObsidianCursor
        startIndex = saved.index
      }
      if (startIndex >= files.length) return { cursor: null } // resume past EOF → done
      // Note: if the vault mutates between a crash and its retry, index-based resume may skip a
      // note whose sort-position shifted; the next full fresh run self-heals any resulting gap.

      return { cursor: JSON.stringify({ index: startIndex } satisfies ObsidianCursor) }
    },

    /**
     * Emit up to BATCH_SIZE doc items from the in-memory file list, skipping unreadable /
     * empty files. The next cursor carries only the position so D1 cursor writes are O(1).
     * Contract invariant upheld: an empty items array is always accompanied by a null cursor
     * (all remaining files were unreadable/empty → terminal page).
     */
    nextBatch: async (cursor): Promise<ImportBatch> => {
      if (cachedFiles === null) {
        throw new Error("obsidian importer: begin() must be called before nextBatch()")
      }
      const { index } = JSON.parse(cursor as string) as ObsidianCursor
      const files = cachedFiles

      const items: Array<
        ImportedSession & {
          content: string
          contentType: "text/markdown"
          path: string
          tags: string[]
        }
      > = []
      let i = index

      while (i < files.length) {
        const file = files[i]
        if (file === undefined) {
          i++
          continue
        }
        const obj = await blobs.get(file.relKey)
        if (obj === null) {
          i++
          continue // file disappeared since begin(); skip
        }
        const content = await obj.text()
        if (content.trim().length === 0) {
          i++
          continue // empty note; skip
        }

        const tags = extractTags(content)
        const { slug, path } = pathParts(file.vaultPath)

        // Item satisfies ImportedSession (client:"obsidian", turns:[]) so it fits ImportBatch
        // unchanged. The extra fields (content/contentType/path/tags) are NOT session data —
        // they're doc metadata picked up by runEnumerate before the item is JSON-serialised away.
        items.push({
          sourceSessionId: slug,
          client: "obsidian",
          turns: [] as ImportedTurn[],
          // Include vaultPath in the fingerprint so two notes with identical content at different
          // paths get distinct fingerprints (and thus distinct stage keys + DB rows).
          // Including etag ensures re-ingest when the content changes (delta detection).
          fingerprint: `obsidian:${file.vaultPath}:${file.etag}`,
          embeddingModel: "pending",
          embeddingDims: 0,
          content,
          contentType: "text/markdown",
          path,
          tags,
        })
        i++
        if (items.length >= BATCH_SIZE) break
      }

      const nextCursor: string | null =
        i >= files.length ? null : JSON.stringify({ index: i } satisfies ObsidianCursor)
      return { items, nextCursor }
    },

    /** No anchor to advance for vault imports; finalization is a no-op. */
    finalize: async () => undefined,
  }
}

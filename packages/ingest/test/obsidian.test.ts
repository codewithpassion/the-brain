import { describe, expect, test } from "bun:test"
import { MAX_CHUNKS_PER_DOC } from "@brain/shared"
import { createObsidianImporter, type VaultR2 } from "../src/sources/obsidian"
import { runImporterContract } from "../src/sources/contract"

/**
 * Obsidian vault importer (Phase 1). Tests cover:
 *  - folder→path mapping (slug, path)
 *  - frontmatter tag extraction (flow array, block sequence, no frontmatter)
 *  - delta/hash cursor: ETag → fingerprint
 *  - contract compliance: terminal null cursor; no empty-batch-with-non-null-cursor
 *  - graceful skip of unreadable (null) and empty files
 */

// ── Mock VaultR2 builder ──────────────────────────────────────────────────────────────────────

interface MockFile {
  key: string // absolute R2 key (includes tenant prefix)
  etag: string
  content: string | null // null simulates a file that disappears between list and get
}

/** Build a VaultR2 mock over a fixed set of files. */
const makeVault = (tenantId: string, files: MockFile[]): VaultR2 => {
  const store = new Map<string, MockFile>(files.map((f) => [f.key, f]))

  return {
    list: async (opts) => {
      const prefix = `${tenantId}/${opts?.prefix ?? ""}`
      const matching = files.filter((f) => f.key.startsWith(prefix))
      return { objects: matching.map((f) => ({ key: f.key, etag: f.etag })), truncated: false }
    },
    get: async (relKey) => {
      // relKey is tenant-relative (e.g. "vault/foo.md"); reconstruct absolute key
      const absKey = `${tenantId}/${relKey}`
      const file = store.get(absKey)
      if (file === undefined || file.content === null) return null
      return { text: async () => file.content as string }
    },
  }
}

const TENANT = "org_user123"

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe("Obsidian importer — folder→path mapping", () => {
  test("root note maps to path '/'", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/inbox.md`, etag: "e1", content: "# Inbox\nsome text" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(1)
    const item = sessions[0] as typeof sessions[0] & { path: string; tags: string[] }
    expect(item.sourceSessionId).toBe("inbox")
    // Extra fields carried through runImporterContract (typed via cast)
    expect((item as unknown as Record<string, unknown>).path).toBe("/")
    expect((item as unknown as Record<string, unknown>).tags).toEqual([])
  })

  test("nested note maps path to its parent folder", async () => {
    const vault = makeVault(TENANT, [
      {
        key: `${TENANT}/vault/Projects/Acme/notes.md`,
        etag: "e2",
        content: "# Notes",
      },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(1)
    const item = sessions[0]!
    expect(item.sourceSessionId).toBe("Projects/Acme/notes")
    expect((item as unknown as Record<string, unknown>).path).toBe("/Projects/Acme")
    expect(item.client).toBe("obsidian")
    expect(item.turns).toEqual([])
    expect(item.embeddingModel).toBe("pending")
    expect(item.embeddingDims).toBe(0)
  })

  test("fingerprint includes vaultPath and etag", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/note.md`, etag: "abc123", content: "Hello" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions[0]?.fingerprint).toBe("obsidian:note.md:abc123")
  })
})

describe("Obsidian importer — frontmatter tag extraction", () => {
  test("flow array tags: tags: [a, b, c]", async () => {
    const content = `---\ntitle: My Note\ntags: [sales, revenue, q1]\n---\n\nBody here.`
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/note.md`, etag: "e1", content },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect((sessions[0] as unknown as Record<string, unknown>).tags).toEqual([
      "sales",
      "revenue",
      "q1",
    ])
  })

  test("block sequence tags", async () => {
    const content = `---\ntitle: Report\ntags:\n  - finance\n  - 2026\n---\n\nBody.`
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/report.md`, etag: "e2", content },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect((sessions[0] as unknown as Record<string, unknown>).tags).toEqual(["finance", "2026"])
  })

  test("no frontmatter → empty tags", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/plain.md`, etag: "e3", content: "Just a plain note." },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect((sessions[0] as unknown as Record<string, unknown>).tags).toEqual([])
  })
})

describe("Obsidian importer — content staging field", () => {
  test("item carries the raw markdown in a content field", async () => {
    const markdownContent = "---\ntags: [test]\n---\n\n# Hello\n\nWorld."
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/hello.md`, etag: "e1", content: markdownContent },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect((sessions[0] as unknown as Record<string, unknown>).content).toBe(markdownContent)
    expect((sessions[0] as unknown as Record<string, unknown>).contentType).toBe("text/markdown")
  })
})

describe("Obsidian importer — contract compliance", () => {
  test("empty vault → zero items, never violates contract", async () => {
    const vault = makeVault(TENANT, [])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(0)
  })

  test("multiple notes satisfy runImporterContract (terminal null cursor)", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/a.md`, etag: "e1", content: "# A" },
      { key: `${TENANT}/vault/b.md`, etag: "e2", content: "# B" },
      { key: `${TENANT}/vault/c.md`, etag: "e3", content: "# C" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(3)
    expect(sessions.map((s) => s.sourceSessionId).sort()).toEqual(["a", "b", "c"])
  })

  test("unreadable file (null from get) is skipped without violating contract", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/good.md`, etag: "e1", content: "# Good" },
      // content: null simulates a file that disappeared between list() and get()
      { key: `${TENANT}/vault/gone.md`, etag: "e2", content: null },
      { key: `${TENANT}/vault/also-good.md`, etag: "e3", content: "# Also Good" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    // Contract: no empty batch with non-null cursor; gone.md is skipped transparently
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.sourceSessionId).sort()).toEqual(["also-good", "good"])
  })

  test("empty file is skipped without violating contract", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/empty.md`, etag: "e1", content: "" },
      { key: `${TENANT}/vault/whitespace.md`, etag: "e2", content: "   \n  " },
      { key: `${TENANT}/vault/real.md`, etag: "e3", content: "# Real" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sourceSessionId).toBe("real")
  })

  test("non-markdown files in vault are ignored", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/image.png`, etag: "e1", content: "binary" },
      { key: `${TENANT}/vault/config.json`, etag: "e2", content: "{}" },
      { key: `${TENANT}/vault/note.md`, etag: "e3", content: "# Note" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sourceSessionId).toBe("note")
  })

  test("custom vaultPrefix is respected", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/my-vault/note.md`, etag: "e1", content: "# Note" },
      { key: `${TENANT}/vault/other.md`, etag: "e2", content: "# Other" },
    ])
    const sessions = await runImporterContract(
      createObsidianImporter(vault, { vaultPrefix: "my-vault/" }),
    )
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sourceSessionId).toBe("note")
  })
})

describe("Obsidian importer — delta detection (vaultPath + ETag fingerprint)", () => {
  test("different ETags produce different fingerprints (content changed)", async () => {
    const vault1 = makeVault(TENANT, [
      { key: `${TENANT}/vault/note.md`, etag: "etag-v1", content: "Version 1" },
    ])
    const vault2 = makeVault(TENANT, [
      { key: `${TENANT}/vault/note.md`, etag: "etag-v2", content: "Version 2" },
    ])
    const [s1] = await runImporterContract(createObsidianImporter(vault1))
    const [s2] = await runImporterContract(createObsidianImporter(vault2))
    expect(s1?.fingerprint).toBe("obsidian:note.md:etag-v1")
    expect(s2?.fingerprint).toBe("obsidian:note.md:etag-v2")
    expect(s1?.fingerprint).not.toBe(s2?.fingerprint)
  })

  test("unchanged ETag produces the same fingerprint (dedup by DB on re-sync)", async () => {
    const vault = makeVault(TENANT, [
      { key: `${TENANT}/vault/stable.md`, etag: "same-etag", content: "Unchanged" },
    ])
    const s1 = await runImporterContract(createObsidianImporter(vault))
    const s2 = await runImporterContract(createObsidianImporter(vault))
    expect(s1[0]?.fingerprint).toBe(s2[0]?.fingerprint)
  })

  test("same content at different paths → distinct fingerprints (no collision)", async () => {
    // Both notes have identical content (→ identical R2 etags). Without vaultPath in the
    // fingerprint, stageKey() would be identical, the second put() would overwrite the first,
    // and the second consumer message would hit the deterministic-id conflict and be dropped —
    // silently losing one note. vaultPath:etag ensures per-location identity.
    const identicalContent = "# TODO"
    const vault = makeVault(TENANT, [
      {
        key: `${TENANT}/vault/Projects/A/todo.md`,
        etag: "same-etag",
        content: identicalContent,
      },
      {
        key: `${TENANT}/vault/Projects/B/todo.md`,
        etag: "same-etag",
        content: identicalContent,
      },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(2)
    const fps = sessions.map((s) => s.fingerprint)
    expect(fps[0]).toBe("obsidian:Projects/A/todo.md:same-etag")
    expect(fps[1]).toBe("obsidian:Projects/B/todo.md:same-etag")
    expect(fps[0]).not.toBe(fps[1])
  })
})

// ── FIX 1 regression guard ─────────────────────────────────────────────────────────────────────

describe("Obsidian importer — Vectorize id length cap (FIX 1 regression guard)", () => {
  test("backfill doc UUID + worst-case chunk index stays ≤ 64-byte Vectorize cap", () => {
    // Previously consume.ts built docId as `ingest-${tenantId}-${fingerprint}` where
    // fingerprint = `obsidian:${vaultPath}:${etag}`. A long vault path pushed the vector id
    // (docId + ":" + chunkIndex) past Cloudflare's 64-byte Vectorize limit → every note failed.
    // After FIX 1 consume.ts lets insertDocument generate a UUID (36 chars).
    // Worst case: UUID(36) + ":" + (MAX_CHUNKS_PER_DOC−1 = 3999, 4 digits) = 41 bytes.
    const docId = crypto.randomUUID() // same format insertDocument now generates
    const vectorId = `${docId}:${MAX_CHUNKS_PER_DOC - 1}` // worst-case chunk index
    expect(new TextEncoder().encode(vectorId).byteLength).toBeLessThanOrEqual(64)
  })

  test("old-style docId with realistic long tenantId + Obsidian fingerprint would have EXCEEDED 64 bytes", () => {
    // Non-vacuous: confirm the old code was actually broken for realistic inputs.
    const tenantId = "org_2abc123456789012345678901234567" // realistic Clerk org id (32 chars)
    const vaultPath = "Projects/Client/2026/Q1/meeting-notes-draft-v2.md" // realistic path
    const etag = "abc123def456789012345678" // realistic ETag
    const fingerprint = `obsidian:${vaultPath}:${etag}`
    const oldDocId = `ingest-${tenantId}-${fingerprint}` // the old format
    const oldVectorId = `${oldDocId}:0` // even chunk index 0
    expect(new TextEncoder().encode(oldVectorId).byteLength).toBeGreaterThan(64) // was broken
  })
})

// ── FIX 3 — cursor resume + multi-file batching ───────────────────────────────────────────────

describe("Obsidian importer — cursor resume + batching (FIX 3)", () => {
  /** Build a vault with N numbered markdown files. */
  const makeNoteVault = (tenantId: string, count: number): VaultR2 => {
    const files = Array.from({ length: count }, (_, i) => ({
      key: `${tenantId}/vault/note-${String(i).padStart(3, "0")}.md`,
      etag: `etag-${i}`,
      content: `# Note ${i}`,
    }))
    const store = new Map(files.map((f) => [f.key, f]))
    return {
      list: async (opts) => {
        const prefix = `${tenantId}/${opts?.prefix ?? ""}`
        const matching = files.filter((f) => f.key.startsWith(prefix))
        return { objects: matching.map((f) => ({ key: f.key, etag: f.etag })), truncated: false }
      },
      get: async (relKey) => {
        const absKey = `${tenantId}/${relKey}`
        const file = store.get(absKey)
        if (file === undefined || file.content === null) return null
        return { text: async () => file.content }
      },
    }
  }

  test("nextBatch emits multiple files per call (≤ 25 per batch)", async () => {
    const vault = makeNoteVault("org_batch", 30)
    const importer = createObsidianImporter(vault)
    const begin = await importer.begin({})
    expect(begin.cursor).not.toBeNull()

    // First batch: must be ≤ 25 items with a non-null next cursor (more remain).
    const batch1 = await importer.nextBatch(begin.cursor!)
    expect(batch1.items.length).toBeGreaterThan(1) // multi-item (not the old one-at-a-time)
    expect(batch1.items.length).toBeLessThanOrEqual(25)
    expect(batch1.nextCursor).not.toBeNull() // 5 more remain

    // Second batch drains the rest.
    const batch2 = await importer.nextBatch(batch1.nextCursor!)
    expect(batch2.items.length).toBe(30 - batch1.items.length)
    expect(batch2.nextCursor).toBeNull() // terminal
  })

  test("resume from saved cursor replays from the saved index, not from the start", async () => {
    const TOTAL = 30
    const vault = makeNoteVault("org_resume", TOTAL)

    // ── First run: drain the first batch, then "crash". ──────────────────────────────────
    const imp1 = createObsidianImporter(vault)
    const begin1 = await imp1.begin({})
    expect(begin1.cursor).not.toBeNull()
    const batch1 = await imp1.nextBatch(begin1.cursor!)
    const firstBatchCount = batch1.items.length
    expect(batch1.nextCursor).not.toBeNull() // crash point: more items remain

    // ── Second run: resume from the batch-1 next cursor. ─────────────────────────────────
    // Simulate a fresh importer (new run start) resuming at the saved cursor.
    const imp2 = createObsidianImporter(vault)
    const begin2 = await imp2.begin({ resumeCursor: batch1.nextCursor! })
    expect(begin2.cursor).not.toBeNull()

    // Drain the rest.
    const remaining: string[] = []
    let cursor: string | null = begin2.cursor
    while (cursor !== null) {
      const batch = await imp2.nextBatch(cursor)
      remaining.push(...batch.items.map((s) => s.sourceSessionId))
      cursor = batch.nextCursor
    }

    // Together, first run + resumed second run must cover all 30 notes with no overlap.
    const firstIds = batch1.items.map((s) => s.sourceSessionId)
    expect(new Set([...firstIds, ...remaining]).size).toBe(TOTAL) // no overlap, no gap
    expect(firstIds.length + remaining.length).toBe(TOTAL) // exact count
  })

  test("file list is sorted deterministically — same order on re-list (stable resume)", async () => {
    const vault = makeNoteVault("org_sort", 10)

    const imp1 = createObsidianImporter(vault)
    const begin1 = await imp1.begin({})
    const batch1 = await imp1.nextBatch(begin1.cursor!)
    const firstIds1 = batch1.items.map((s) => s.sourceSessionId)

    // A second fresh run (same vault) must list in the same order.
    const imp2 = createObsidianImporter(vault)
    const begin2 = await imp2.begin({})
    const batch2 = await imp2.nextBatch(begin2.cursor!)
    const firstIds2 = batch2.items.map((s) => s.sourceSessionId)

    expect(firstIds1).toEqual(firstIds2)
  })
})

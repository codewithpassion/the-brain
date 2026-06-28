/**
 * Phase 2 Obsidian importer tests — write-back loop avoidance.
 *
 * The Obsidian importer must skip files under the reserved `Brain/` path prefix so that
 * brain-authored notes written back to the vault via `vault_writeback` are never re-ingested
 * as user edits (loop avoidance; docs/obsidian-brain-integration-plan.md §6, Phase 2).
 */
import { describe, expect, test } from "bun:test"
import { runImporterContract } from "../src/sources/contract"
import { createObsidianImporter, type VaultR2 } from "../src/sources/obsidian"

const TENANT = "org_user123"

/** Build a VaultR2 mock over a fixed set of files. */
interface MockFile {
  key: string
  etag: string
  content: string | null
}
const makeVault = (files: MockFile[]): VaultR2 => {
  const store = new Map<string, MockFile>(files.map((f) => [f.key, f]))
  return {
    list: async (opts) => {
      const prefix = `${TENANT}/${opts?.prefix ?? ""}`
      const matching = files.filter((f) => f.key.startsWith(prefix))
      return { objects: matching.map((f) => ({ key: f.key, etag: f.etag })), truncated: false }
    },
    get: async (relKey) => {
      const absKey = `${TENANT}/${relKey}`
      const file = store.get(absKey)
      if (file === undefined || file.content === null) return null
      return { text: async () => file.content as string }
    },
  }
}

describe("Obsidian importer — Brain/ exclusion (write-back loop avoidance)", () => {
  test("files under Brain/ are skipped entirely and not emitted as items", async () => {
    const vault = makeVault([
      { key: `${TENANT}/vault/my-note.md`, etag: "e1", content: "# User note" },
      {
        key: `${TENANT}/vault/Brain/daily-2026-06-28.md`,
        etag: "e2",
        content: "---\nsource: brain\n---\n# Brain note",
      },
      { key: `${TENANT}/vault/Brain/synthesis.md`, etag: "e3", content: "Brain synthesis" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))

    // Only the user's note should be emitted; Brain/ files are excluded.
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sourceSessionId).toBe("my-note")
  })

  test("Brain/ is case-sensitive — 'brain/' (lowercase) is NOT excluded", async () => {
    const vault = makeVault([
      { key: `${TENANT}/vault/brain/note.md`, etag: "e1", content: "# Lowercase brain" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    // Lowercase 'brain/' does not match the reserved 'Brain/' prefix — ingested normally.
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sourceSessionId).toBe("brain/note")
  })

  test("files in subfolders of Brain/ are also excluded", async () => {
    const vault = makeVault([
      { key: `${TENANT}/vault/Brain/2026/Q2/weekly.md`, etag: "e1", content: "Weekly" },
      { key: `${TENANT}/vault/Projects/work.md`, etag: "e2", content: "Work note" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sourceSessionId).toBe("Projects/work")
  })

  test("a vault with only Brain/ files produces zero items (empty batch → contract-safe)", async () => {
    const vault = makeVault([
      { key: `${TENANT}/vault/Brain/index.md`, etag: "e1", content: "# Index" },
    ])
    const sessions = await runImporterContract(createObsidianImporter(vault))
    expect(sessions).toHaveLength(0)
  })
})

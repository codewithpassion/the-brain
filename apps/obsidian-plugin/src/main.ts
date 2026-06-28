/**
 * Brain Obsidian Plugin — main entry point.
 *
 * Five commands:
 *   1. Ask the Brain        — think op via editorCallback (selection → insert cited answer)
 *   2. Search Brain         — search op via SearchModal
 *   3. Brain backlinks      — get_backlinks op for the active note → new note listing links
 *   4. Capture note → Brain — memory_set op for the active note's content
 *   5. Pull Brain notes     — okf_export op → write bundle into the Brain vault folder
 *
 * Mobile rules observed:
 *   - No `fs`, `crypto`, `path`, `child_process`, or `Buffer` (Node.js APIs absent on mobile).
 *   - All HTTP: `requestUrl` from obsidian (via BrainClient).
 *   - All file I/O: Vault API (createFolder / create / modify / read / getAbstractFileByPath).
 *   - Frontmatter: metadataCache (parsed by Obsidian, no regex YAML parsing).
 */
import { Notice, Plugin, TFile, TFolder } from "obsidian"
import type { OkfExportFile, ThinkOutput } from "./client"
import { BrainClient } from "./client"
import { SearchModal } from "./modals"
import type { BrainSettings } from "./settings"
import { BrainSettingTab, DEFAULT_SETTINGS } from "./settings"

export default class BrainPlugin extends Plugin {
  override settings: BrainSettings = { ...DEFAULT_SETTINGS }
  private client: BrainClient | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()

    this.addSettingTab(new BrainSettingTab(this.app, this))

    // ── Command 1: Ask the Brain ─────────────────────────────────────────────
    // Requires an active Markdown editor. Uses selection if present; falls back to
    // the note's base name as the query. Inserts a callout block at the cursor.
    this.addCommand({
      id: "brain-think",
      name: "Ask the Brain",
      editorCallback: (editor, view) => {
        const selection = editor.getSelection().trim()
        const query = selection.length > 0 ? selection : (view.file?.basename ?? "")
        if (query.length === 0) {
          new Notice("Brain: open a note or select text to ask a question.")
          return
        }
        void this.runThink(query, editor)
      },
    })

    // ── Command 2: Search Brain ──────────────────────────────────────────────
    this.addCommand({
      id: "brain-search",
      name: "Search Brain",
      callback: () => {
        new SearchModal(this.app, this).open()
      },
    })

    // ── Command 3: Brain backlinks for active note ───────────────────────────
    this.addCommand({
      id: "brain-backlinks",
      name: "Show Brain backlinks for active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (file === null) return false
        if (!checking) void this.runBacklinks(file)
        return true
      },
    })

    // ── Command 4: Capture active note → Brain memory ────────────────────────
    this.addCommand({
      id: "brain-capture",
      name: "Capture active note to Brain memory",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (file === null) return false
        if (!checking) void this.runCapture(file)
        return true
      },
    })

    // ── Command 5: Pull Brain notes into vault ───────────────────────────────
    this.addCommand({
      id: "brain-pull",
      name: "Pull Brain notes into vault",
      callback: () => {
        void this.runPull()
      },
    })

    // Ribbon icon — opens Search modal (nice-to-have, mobile-compatible).
    this.addRibbonIcon("brain", "Brain", () => {
      new SearchModal(this.app, this).open()
    })
  }

  override onunload(): void {
    // Nothing to tear down; Obsidian disposes commands/ribbon icons automatically.
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = await this.loadData()
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved) as BrainSettings
    this.refreshClient()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    this.refreshClient()
  }

  /** Rebuild the client whenever the URL or key changes. */
  refreshClient(): void {
    const { apiBaseUrl, apiKey } = this.settings
    if (apiBaseUrl.length > 0 && apiKey.length > 0) {
      this.client = new BrainClient(apiBaseUrl, apiKey)
    } else {
      this.client = null
    }
  }

  /**
   * Return the active client, or throw a user-friendly error if not configured.
   * Commands call this rather than accessing `this.client` directly.
   */
  getClient(): BrainClient {
    if (this.client === null) {
      throw new Error(
        "Brain plugin not configured. Open Settings → Brain and enter your API URL and key.",
      )
    }
    return this.client
  }

  // ── Command implementations ─────────────────────────────────────────────────

  private async runThink(query: string, editor: import("obsidian").Editor): Promise<void> {
    const notice = new Notice("Brain: thinking…", 0)
    try {
      const client = this.getClient()
      const input = {
        query,
        ...(this.settings.defaultScope.length > 0 ? { scope: this.settings.defaultScope } : {}),
      }
      const result: ThinkOutput = await client.think(input)
      notice.hide()
      // Insert after the selection end so the user's query text is preserved.
      editor.replaceRange(formatThinkResult(result), editor.getCursor("to"))
    } catch (err) {
      notice.hide()
      new Notice(`Brain: ${String(err)}`)
    }
  }

  private async runBacklinks(file: TFile): Promise<void> {
    // Use the note path without .md as the Brain slug.
    const slug = file.path.replace(/\.md$/, "")
    const notice = new Notice("Brain: fetching backlinks…", 0)
    try {
      const client = this.getClient()
      const result = await client.getBacklinks({ target: slug })
      notice.hide()

      if (result.links.length === 0) {
        new Notice(`Brain: no backlinks found for "${slug}".`)
        return
      }

      const lines = [
        `# Brain backlinks — ${file.basename}`,
        "",
        `Slug: \`${slug}\``,
        "",
        ...result.links.map(
          (l) =>
            `- **${l.fromId}** → (${l.linkType})${l.context.length > 0 ? `: _${l.context}_` : ""}`,
        ),
        "",
      ]
      // Derive dest from the note's full vault path so notes with the same
      // basename in different folders don't overwrite each other.
      const safeName = file.path.replace(/\.md$/, "").replace(/\//g, " » ")
      const destPath = `${this.settings.brainFolder}/Backlinks — ${safeName}.md`
      await this.writeVaultFile(destPath, lines.join("\n"))
      await this.app.workspace.openLinkText(destPath, "/", false)
    } catch (err) {
      notice.hide()
      new Notice(`Brain: ${String(err)}`)
    }
  }

  private async runCapture(file: TFile): Promise<void> {
    const notice = new Notice("Brain: capturing note…", 0)
    try {
      const client = this.getClient()
      const content = await this.app.vault.read(file)

      // Derive slug from vault path (strip .md extension).
      const slug = file.path.replace(/\.md$/, "")

      // Read type from YAML frontmatter via metadataCache (mobile-safe, no manual YAML parsing).
      const cache = this.app.metadataCache.getFileCache(file)
      const type = (cache?.frontmatter?.brain_type as string | undefined) ?? "note"

      const input = {
        slug,
        type,
        body: content,
        title: file.basename,
        ...(this.settings.defaultScope.length > 0 ? { scope: this.settings.defaultScope } : {}),
      }
      const result = await client.memorySet(input)
      notice.hide()
      new Notice(
        `Brain: captured "${result.slug}" (v${result.version.toString()}${result.changed ? ", updated" : ", unchanged"}).`,
      )
    } catch (err) {
      notice.hide()
      new Notice(`Brain: ${String(err)}`)
    }
  }

  private async runPull(): Promise<void> {
    const notice = new Notice("Brain: pulling notes…", 0)
    try {
      const client = this.getClient()
      const result = await client.okfExport({})
      notice.hide()

      if (result.files.length === 0) {
        new Notice("Brain: no notes to pull.")
        return
      }

      await this.writeOkfBundle(result.files)
      new Notice(
        `Brain: pulled ${result.files.length.toString()} notes into "${this.settings.brainFolder}".`,
      )
    } catch (err) {
      notice.hide()
      new Notice(`Brain: ${String(err)}`)
    }
  }

  // ── Vault helpers ───────────────────────────────────────────────────────────

  /**
   * Write an OKF bundle into the vault under the configured Brain folder.
   * Each file's `path` is relative; we prefix it with `brainFolder/`.
   */
  private async writeOkfBundle(files: OkfExportFile[]): Promise<void> {
    await this.ensureFolder(this.settings.brainFolder)
    for (const file of files) {
      const safePath = this.sanitizeRelPath(file.path)
      if (safePath.length === 0) continue
      const targetPath = `${this.settings.brainFolder}/${safePath}`
      await this.writeVaultFile(targetPath, file.content)
    }
  }

  /**
   * Strip leading slashes and remove `.` / `..` segments from a server-supplied
   * relative path so it cannot escape the Brain folder.
   */
  private sanitizeRelPath(rawPath: string): string {
    return rawPath
      .replace(/^\/+/, "")
      .split("/")
      .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
      .join("/")
  }

  /**
   * Create or overwrite a vault file, ensuring its parent folder exists.
   * Uses Vault API only — no fs, path, or Buffer.
   */
  private async writeVaultFile(targetPath: string, content: string): Promise<void> {
    // Ensure parent folder exists.
    const lastSlash = targetPath.lastIndexOf("/")
    if (lastSlash > 0) {
      await this.ensureFolder(targetPath.slice(0, lastSlash))
    }

    const existing = this.app.vault.getAbstractFileByPath(targetPath)
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content)
    } else if (existing === null) {
      await this.app.vault.create(targetPath, content)
    } else if (existing instanceof TFolder) {
      new Notice(`Brain: cannot write "${targetPath}" — a folder already exists at that path.`)
    }
  }

  /** Create a vault folder if it does not already exist. */
  private async ensureFolder(folderPath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(folderPath)
    if (existing === null) {
      await this.app.vault.createFolder(folderPath)
    }
  }
}

// ── Formatters ──────────────────────────────────────────────────────────────

/**
 * Format a `think` result as an Obsidian callout block.
 * Inserted at the cursor position in the active editor.
 */
function formatThinkResult(result: ThinkOutput): string {
  const lines: string[] = ["", "> [!brain] Brain", `> ${result.answer.replace(/\n/g, "\n> ")}`]

  if (result.citations.length > 0) {
    lines.push("> ")
    lines.push(`> **Sources:** ${result.citations.map((c) => `[[${c.slug}]]`).join(", ")}`)
  }

  if (result.gaps.length > 0) {
    lines.push("> ")
    lines.push(`> **Gaps:** ${result.gaps.join("; ")}`)
  }

  if (result.warnings.length > 0) {
    lines.push("> ")
    lines.push(`> **Warnings:** ${result.warnings.join("; ")}`)
  }

  lines.push("")
  return lines.join("\n")
}

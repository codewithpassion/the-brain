import { type App, Modal, Setting } from "obsidian"
import type { SearchHit } from "./client"
import type BrainPlugin from "./main"

/**
 * SearchModal — live search against POST /search.
 *
 * Fires a search once the user has typed ≥ 3 characters. Clicking a result calls
 * `openLinkText`, which resolves the slug inside the vault (if a note exists with that
 * path) or asks the user to create it.
 */
export class SearchModal extends Modal {
  private _searchTimer: ReturnType<typeof window.setTimeout> | null = null
  private _latestQuery = ""

  constructor(
    app: App,
    private readonly plugin: BrainPlugin,
  ) {
    super(app)
  }

  override onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl("h2", { text: "Search Brain" })

    const resultsEl = contentEl.createDiv({ cls: "brain-search-results" })

    new Setting(contentEl).setName("Query").addText((text) => {
      text.setPlaceholder("Search the Brain…").onChange((value) => {
        // Clear any pending debounce timer.
        if (this._searchTimer !== null) {
          window.clearTimeout(this._searchTimer)
          this._searchTimer = null
        }
        if (value.length >= 3) {
          // Debounce: wait 200 ms before firing so rapid keystrokes don't flood the API.
          this._searchTimer = window.setTimeout(() => {
            this._latestQuery = value
            void this.runSearch(value, resultsEl)
          }, 200)
        } else {
          this._latestQuery = ""
          resultsEl.empty()
        }
      })
      // Auto-focus the input so the user can start typing immediately.
      window.setTimeout(() => text.inputEl.focus(), 10)
    })
  }

  private async runSearch(query: string, container: HTMLElement): Promise<void> {
    container.empty()
    container.createEl("p", { text: "Searching…", cls: "brain-status" })
    try {
      const result = await this.plugin.getClient().search({ query, topK: 10 })
      // Discard stale responses: a slower earlier request must not overwrite a newer query's results.
      if (query !== this._latestQuery) return
      container.empty()
      if (result.hits.length === 0) {
        container.createEl("p", { text: "No results.", cls: "brain-status" })
        return
      }
      for (const hit of result.hits) {
        this.renderHit(hit, container)
      }
    } catch (err) {
      if (query !== this._latestQuery) return
      container.empty()
      container.createEl("p", {
        text: `Error: ${String(err)}`,
        cls: "brain-status brain-error",
      })
    }
  }

  private renderHit(hit: SearchHit, container: HTMLElement): void {
    const item = container.createDiv({ cls: "brain-search-item" })
    item.createEl("strong", { text: hit.slug })
    item.createEl("p", { text: hit.snippet, cls: "brain-snippet" })
    item.addEventListener("click", () => {
      void this.app.workspace.openLinkText(hit.slug, "/", false)
      this.close()
    })
  }

  override onClose(): void {
    if (this._searchTimer !== null) {
      window.clearTimeout(this._searchTimer)
      this._searchTimer = null
    }
    this.contentEl.empty()
  }
}

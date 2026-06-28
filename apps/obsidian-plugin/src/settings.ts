import { type App, PluginSettingTab, Setting } from "obsidian"
import type BrainPlugin from "./main"

export interface BrainSettings {
  /** Base URL of the Brain API worker, without trailing slash. */
  apiBaseUrl: string
  /** bk_ API key. Stored in plain text by Obsidian's data.json — see README. */
  apiKey: string
  /** Optional scope to pre-filter think/search queries. Leave blank for no filter. */
  defaultScope: string
  /** Vault folder where pulled Brain notes are written. */
  brainFolder: string
}

export const DEFAULT_SETTINGS: BrainSettings = {
  apiBaseUrl: "https://brain-api.dominik-fretz.workers.dev",
  apiKey: "",
  defaultScope: "",
  brainFolder: "Brain",
}

export class BrainSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BrainPlugin,
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl("h2", { text: "Brain settings" })

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("URL of your deployed Brain API worker.")
      .addText((text) => {
        text
          .setPlaceholder("https://brain-api.example.workers.dev")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        "Your bk_ API key. " +
          "Stored in plain text inside Obsidian's plugin data.json — " +
          "see README for security notes.",
      )
      .addText((text) => {
        text.inputEl.type = "password"
        text
          .setPlaceholder("bk_…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName("Default scope")
      .setDesc(
        "Optional scope pre-filter applied to every think/search query. " +
          "Leave blank to search across all your content.",
      )
      .addText((text) => {
        text
          .setPlaceholder("my-project")
          .setValue(this.plugin.settings.defaultScope)
          .onChange(async (value) => {
            this.plugin.settings.defaultScope = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName("Brain folder")
      .setDesc("Vault folder where Pull Brain Notes writes files (created if absent).")
      .addText((text) => {
        text
          .setPlaceholder("Brain")
          .setValue(this.plugin.settings.brainFolder)
          .onChange(async (value) => {
            this.plugin.settings.brainFolder = value.trim() || "Brain"
            await this.plugin.saveSettings()
          })
      })
  }
}

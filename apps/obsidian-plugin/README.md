# Brain Obsidian Plugin

Connects Obsidian to your deployed [Brain API](https://brain-api.dominik-fretz.workers.dev).

## Features

| Command | Description |
|---|---|
| **Ask the Brain** | Think query — uses selection or note title, inserts cited answer callout at cursor |
| **Search Brain** | Live search modal (≥ 3 chars) with clickable results |
| **Show Brain backlinks** | Fetches notes that link to the active note's slug; writes a backlinks note |
| **Capture active note** | Pushes current note content to `memory_set`; reads `brain_type` from YAML front matter |
| **Pull Brain notes** | Calls `okf_export` and writes the returned bundle into your Brain vault folder |

A ribbon icon (brain) opens the Search modal.

## Installation

### BRAT (recommended during beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Add the plugin source URL in BRAT settings.
3. Enable "Brain" in **Settings → Community plugins**.

### Manual

1. Download the latest `main.js` and `manifest.json` from Releases.
2. Copy them to `.obsidian/plugins/brain-obsidian/` in your vault.
3. Enable "Brain" in **Settings → Community plugins**.

## Configuration

Open **Settings → Brain** and fill in:

| Field | Default | Notes |
|---|---|---|
| **API base URL** | `https://brain-api.dominik-fretz.workers.dev` | Your deployed Worker URL |
| **API key** | *(empty)* | A `bk_` key from the Brain admin panel |
| **Default scope** | *(empty)* | Pre-filter all queries to a scope; leave blank for all content |
| **Brain folder** | `Brain` | Vault folder for pulled notes and backlinks output |

### API key security

> **Important:** Obsidian stores plugin settings in plain text inside
> `.obsidian/plugins/brain-obsidian/data.json`. This file is not encrypted.
> Do **not** commit your vault's `.obsidian/` directory to a public repository.
> If your vault is synced via iCloud, Obsidian Sync, or similar, the key travels
> with the sync. Treat `bk_` keys like passwords and rotate them if exposed.

The plugin does **not** implement any encryption of the stored key. The
`password`-style input in the settings tab only prevents shoulder-surfing — the
value is plaintext at rest.

## Using the `brain_type` frontmatter field

When you capture a note, the plugin reads the `brain_type` field from YAML
frontmatter to set the OKF `type`. If absent, it defaults to `"note"`.

```yaml
---
brain_type: decision
---
```

Recognised types are whatever your Brain API accepts (e.g., `note`, `decision`, `fact`, `okr`).

## Mobile support

The plugin is `isDesktopOnly: false`. It uses:

- `requestUrl` (from `obsidian`) for all HTTP — avoids CORS, works on iOS/Android.
- The Vault API for all file I/O — no Node.js `fs` or `path` modules.
- `metadataCache` for frontmatter — no manual YAML parsing.

No Node.js built-in modules are imported in the plugin source.

## Build

```bash
cd apps/obsidian-plugin
bun install          # install devDeps (obsidian types, esbuild)
bun run build        # produces main.js
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
```

The plugin connects to `https://brain-api.dominik-fretz.workers.dev` by default (configurable in settings).

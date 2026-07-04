# v3 Editor Spike Notes (W4a) — evidence for the D2 decision

Throwaway spike (built in `/tmp/tiptap-spike`, not committed — the reproducible essence is captured
here). Goal: confirm/refute the plan's TipTap favorite on our exact stack. Decision:
`docs/v3-editor-decision.md`. Verdict: **TipTap 3**.

## Stack under test
- React 19.2, react-dom 19.2, Vite 8.1.3 (rolldown/oxc), `@vitejs/plugin-react` 6, bun 1.3.11.
- TipTap 3.27.1 (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/suggestion`,
  `@tiptap/extension-mention`, `@tiptap/markdown`, `@tiptap/extension-table`).
- BlockNote 0.51.4 (evaluated by docs + peer-dep characterization, not built — it is the fallback).

## Gate results

### 1. React 19.2 peer support (fast disqualifier check) — BOTH PASS
- `@tiptap/react` peer: `react: ^17 || ^18 || ^19`.
- `@blocknote/react` peer: `react: ^18 || ^19`; but BlockNote pulls **Mantine** (`@mantine/core`
  latest requires `react ^19.2.0`) — a whole second UI framework alongside our Tailwind/shadcn.

### 2. [[wikilink]] custom node + `[[` autocomplete (MAKE-OR-BREAK) — TipTap PASS
Built a real `WikiLink` node (see prototype below): a ProseMirror inline `atom` node with
`target`/`label`/`pending` attrs, a markdown `serialize` hook (`[[target|label]]`), red-link styling
via the `pending` attr, and `[[` autocomplete via `@tiptap/suggestion` (multi-char trigger — the
plugin escapes `char` into its match regex). **The full app compiled clean** (73 modules, no type or
build errors) with StarterKit + Markdown + Mention + WikiLink together on React 19.2 / Vite 8.
- TipTap is headless → the wikilink node is pure ProseMirror, full control, styled by us.
- BlockNote's opinionated **block** model makes custom **inline** content the newer/harder path — a
  real risk for the one feature Outline itself lacks and we must have.

### 3. Markdown round-trip (our page bodies are markdown) — TipTap PASS (native in v3)
`@tiptap/markdown` 3.27.1 gives bidirectional markdown: `contentType:'markdown'` to load,
`editor.getMarkdown()` to save; GFM via `marked`. Headless round-trip (via happy-dom) results:

```
IN : # Title \n Hello **bold** and _em_ and `code` \n - a \n - b \n | x | y | ...
OUT: # Title \n Hello **bold** and *em* and `code` \n - a \n - b        (StarterKit: no table node)
OUT (with @tiptap/extension-table registered): the | x | y | table round-trips exactly.
```
Findings: **lossless for every registered node type**; `_em_`→`*em*` and table padding are
**CommonMark-equivalent normalization** (semantic, not byte, fidelity — same as Outline). A node
whose extension is not registered is dropped, so register table (+row/header/cell) etc.
Correction to prior assumption: "TipTap markdown is weak" was **stale** — v3 made it first-class.

### 4. y-prosemirror / Yjs (D4 collab gate for W6) — BOTH PASS; TipTap lower-level
- TipTap: `@tiptap/extension-collaboration` → `@tiptap/y-tiptap` ^3.0.5 → y-prosemirror 1.3.7 (raw
  ProseMirror binding). Best control for our own `WikiRoom` DO Yjs provider.
- BlockNote: depends on `y-prosemirror` ^1.3.7 directly, wrapped at a higher level.

### 5. Slash menu + bubble toolbar — available
- Slash menu: `@tiptap/suggestion` with `char:'/'` (same primitive as the wikilink/mention).
- Bubble/selection toolbar: `BubbleMenu` from `@tiptap/react/menus`.

### 6. SSR (CF Workers dashboard) — handled
`useEditor({ immediatelyRender: false })` prevents server render mismatch; the editor mounts
client-side only. For server-side JSON→markdown (no editor), `@tiptap/static-renderer` exists.

### 7. Bundle size (a footnote, not a gate — plan mitigates via code-split)
Production `vite build` (gzip):
- React + react-dom baseline shell: **60.9 KB**.
- Full editor app (React + StarterKit + Markdown+marked + Mention + WikiLink): **228.5 KB**.
- **Editor-specific delta ≈ 167 KB gzip.** Plan: code-split the edit route → lazy **client** chunk;
  it never enters the SSR **server** worker bundle. View mode uses react-markdown (much lighter), so
  the editor weight does not affect view mode or first paint.

## Reproduction
`bun install` in a vite+react-19 project with the deps above; `vite build` needs `esbuild` added as a
devDep under Vite 8 (rolldown). The `WikiLink` prototype and a headless `getMarkdown()` round-trip
harness reproduce sections 2–3 & 7.

## WikiLink prototype (the make-or-break, verbatim from the spike)
```ts
import { mergeAttributes, Node } from "@tiptap/core"
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"

export const WikiLinkPluginKey = new PluginKey("wikilink")

export const WikiLink = Node.create({
  name: "wikilink",
  group: "inline", inline: true, atom: true, selectable: true,
  addOptions() {
    return {
      HTMLAttributes: { class: "wikilink" },
      suggestion: {
        char: "[[",                       // multi-char trigger (escaped into Suggestion's regex)
        pluginKey: WikiLinkPluginKey,
        command: ({ editor, range, props }) => {
          editor.chain().focus()
            .insertContentAt(range, [{ type: "wikilink", attrs: props }, { type: "text", text: " " }])
            .run()
        },
      },
    }
  },
  addAttributes() {
    return { target: { default: null }, label: { default: null }, pending: { default: false } }
  },
  parseHTML() { return [{ tag: "span[data-wikilink]" }] },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(
      { "data-wikilink": node.attrs.target, "data-pending": node.attrs.pending ? "1" : "0" },
      this.options.HTMLAttributes, HTMLAttributes,
    ), `${node.attrs.label ?? node.attrs.target}`]
  },
  addStorage() {
    return { markdown: { serialize(state, node) {
      const t = node.attrs.target, l = node.attrs.label
      state.write(l && l !== t ? `[[${t}|${l}]]` : `[[${t}]]`)
    } } }
  },
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })]
  },
})
```
Autocomplete `items` query hits `wiki_list_pages` + `search_entities` (Phase 5); `command` inserts
the node; unresolved targets set `pending:true` → red link (matches the W1 `pending_links` table).

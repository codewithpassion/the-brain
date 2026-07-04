# v3 Editor Decision (D2) — **TipTap 3**

**Status: LOCKED.** Resolves Decision D2. The W4a spike confirmed the plan's favored kit with
evidence on our exact stack (apps/dashboard: TanStack Start on CF Workers SSR, React 19.2, Vite 8,
Tailwind v4 + shadcn-style ui). Evidence + reproduction: `docs/v3-editor-spike-notes.md`.

## Decision

Use **TipTap 3** (`@tiptap/react` 3.27.1, headless) for edit mode (W4b/Phase 5) and as the collab
substrate (W6). Use **react-markdown** for **view mode** rendering (Phase 4) — view mode is
deliberately decoupled from the editor kit (see below), so it does not wait on TipTap.

## Why TipTap over BlockNote, on our stack

| Gate | TipTap 3 | BlockNote | Winner |
|---|---|---|---|
| **[[wikilink]] custom node + `[[` autocomplete** (make-or-break) | Native ProseMirror inline `atom` node + `@tiptap/suggestion` multi-char trigger. Built & compiled clean. | Opinionated *block* model; custom **inline** content is the newer/harder path. | **TipTap** |
| **Markdown round-trip** (our bodies are markdown) | Native `@tiptap/markdown` (bidirectional, GFM). Headless round-trip verified lossless for registered nodes. | Block-model markdown; lossy for arbitrary markdown. | **TipTap** |
| **y-prosemirror** (D4/W6 collab gate) | `@tiptap/y-tiptap`→y-prosemirror; raw ProseMirror binding = full control for our own `WikiRoom` DO provider. | Also y-prosemirror, but wrapped higher-level. | **TipTap** (both pass) |
| **Styling fit** | Headless → styled with our Tailwind v4 + shadcn. | Ships **Mantine** (a whole second UI framework + theming) → design-system collision + bundle. | **TipTap** |
| **Slash menu + bubble toolbar** | `@tiptap/suggestion` slash menu + `BubbleMenu`. | Built-in. | tie |
| **React 19.2 / Vite 8 / SSR** | Builds clean; `immediatelyRender:false` for SSR. | React 19 OK; Mantine adds SSR surface. | **TipTap** |
| **Bundle** | ~167 KB gzip editor delta — code-split as a lazy client chunk. | Larger (Mantine + block UI). | **TipTap** |

BlockNote's block model + bundled Mantine are the disqualifiers *for us*: we need a **custom inline
wikilink node** and **markdown fidelity**, and we already have a design system (Tailwind/shadcn).

## Consequences / how it lands

- **View mode (Phase 4) uses `react-markdown`**, NOT the editor's read-only mode. Rationale: view
  mode only needs to *render* markdown; react-markdown is far lighter and keeps view mode
  **technically independent** of the editor choice (only the small `[[wikilink]]` remark transform
  is custom). Deps: `react-markdown` + `remark-gfm` (tables) + `rehype-highlight` (code) + a
  client-only Mermaid component + a remark plugin mapping `[[slug]]`→router link (red when pending).
- **Edit mode (Phase 5) uses TipTap 3**, code-split behind the `/wiki/$` edit route so the editor
  bundle is a lazy **client** chunk and never enters the SSR **server** worker bundle.
- **Extensions to register** for full page fidelity: StarterKit + `@tiptap/markdown` +
  `@tiptap/extension-table` (+ row/header/cell) + `@tiptap/extension-mention` + our custom
  `WikiLink` node (spike prototype in the notes). Tables round-trip once the table extension is
  registered; emphasis markers normalize to `*` (CommonMark-equivalent — semantic, not byte,
  fidelity, same as Outline).
- **W6 collab**: `@tiptap/extension-collaboration` over `@tiptap/y-tiptap`; our `WikiRoom` DO hosts
  the Yjs doc. Verified compatible up front (D4 gate).

## Accepted limitations

- Markdown round-trip is **semantically lossless (CommonMark-normalized)**, not byte-identical
  (emphasis marker + table padding normalize). Acceptable and industry-standard (Outline does the
  same). Any node type not registered as an extension is dropped on round-trip — the extension set
  above covers our page constructs.
- `@tiptap/markdown` pulls `marked`; `ExportMarkdown`/import *REST* helpers are TipTap **Pro** — we
  do **not** need them (the free `@tiptap/markdown` `getMarkdown()` + `contentType:'markdown'` and
  `@tiptap/static-renderer` cover our needs).

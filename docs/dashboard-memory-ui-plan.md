# Dashboard memory-authoring UI — plan (Memory · Facts · Session detail)

> **Goal:** close the dashboard gap — today the only human *write* path is document ingest. Add
> screens for the memory-authoring layers that already exist on the backend (CLI/MCP/REST) but have
> no UI. **Zero backend changes** — every op below already exists and is registered on all surfaces;
> this is a thin UI layer, exactly like the Vault Sync page was over the vault ops.

Pattern to mirror: `documents.index.tsx` + `documents.$id.tsx` (list + detail) and `api-keys.tsx`
(generate / list / revoke, show-once). Server fns in `src/server/fns.ts`, types in
`src/server/types.ts`, nav in `__root.tsx`, Result<T> wrapping + `brainCall` like the rest.

---

## 1. Memory (OKF agent memory) — the big one

Routes: `/memory` (list) + `/memory/$slug` (detail). Nav: add **Memory** to primary nav.
All ops exist — no backend work.

- **List** (`/memory`) — `memory_list({ path?, prefix, limit })` → table: slug, type, title, version,
  updated. A path filter input + a "whole subtree" (prefix) toggle. Rows link to detail.
- **Detail** (`/memory/$slug`) — `memory_get(slug)` → render frontmatter (type/title/tags/visibility)
  + markdown body. Actions:
  - **Edit** → textarea for body + fields → `memory_set({ slug, type, body, title?, ... })` (appends a
    version; unchanged = no-op).
  - **History** → `memory_history(slug)` → list versions newest-first; each has **Roll back to this**
    → `memory_rollback({ slug, toRevisionId })` (forward-only).
  - **Forget** → `memory_forget(slug)` (two-step confirm; history retained).
- **New memory** — a "New" form on the list page (slug + type + body) → `memory_set`.
- **OKF import/export** — on the list page:
  - **Export** → `okf_export()` → returns `{ files: [{path, content}] }`; offer download (concatenate
    or a simple multi-file display + copy; a real zip is a nice-to-have, not required for v1).
  - **Import** → paste/upload OKF files → `okf_import({ files: [{path, content}] })` → refresh list.

Types: `MemoryItem`, `MemoryRevision`, `OkfFile`, and the op result shapes.

## 2. Facts browser

Route: `/facts`. Nav: add **Facts**. Ops: `recall` (read) + `forget_fact` (write) — both exist.

- **List** — `recall({ query?/grep?, entitySlug?, since?, limit })` → table of `{ id, fact, kind }`
  (newest-first). Filter inputs: keyword/grep, entity, since-date.
- **Forget** — per-row `forget_fact({ factId })` (two-step confirm; soft-expire, lineage preserved).
- (Note: `recall` returns minimal fields by design — id/fact/kind. That's enough for browse+forget;
  a richer `list_facts` op is a possible later add, out of scope here.)

## 3. Session detail

Route: `/sessions/$id`. The list (`sessions.tsx`, `list_sessions`) already exists — make rows **link**
to detail. Op: `get_session_context` (read) — exists.

- **Detail** — `get_session_context({ brainSessionId: $id, memoryPrefix:false })` → render:
  - **Turns** — `turns[]` (idx, role, content) as a transcript.
  - **Hot-memory facts** — `facts[]` (id, fact, kind) visible to the session.
  - **Loaded memories** — `memories[]` (slug, type, title, body, version) if returned.
  - session header from the list row (client, status, turnCount, user, timestamps).
  - (`list_sessions.id` IS the `brainSessionId` — confirmed.)

---

## Build / test

- One cohesive frontend change set (shared `fns.ts` / `types.ts` / `__root.tsx`), gates:
  `bun x tsc --noEmit && bun run build` + biome.
- **Chrome e2e:** create a memory item → edit it → check history → roll back → forget; browse facts
  → forget one; open a session → see its turns/facts/memories. Then deploy.

**Out of scope:** any backend op (none needed), a true OKF zip download (v1 shows/copies files),
fact creation UI (facts are extracted/promoted, not hand-authored — only browse + forget here).

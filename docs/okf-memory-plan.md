# OKF-Compatible Agent Memory — Design & Plan

> **Goal (from the brief):** A path-keyed memory primitive for agent memories ("load in full based on a path", many named items under a path), with **version history + the ability to view old versions and roll back**, reflected across **all surfaces (CLI, MCP, REST/API)**. Plus: **compatibility with the Open Knowledge Format (OKF)** so memory is a portable, vendor-neutral knowledge bundle.
>
> **Status:** Design doc, grounded in a codebase audit (file:line citations below) + a research pass on OKF v0.1 (Google Cloud, published 2026-06-12). Decisions were made interactively with the maintainer. No code written yet when this doc landed — it is the plan the implementation follows.

---

## 0. TL;DR — the recommendation

Build agent memory as **OKF concepts on the docgraph `pages` layer**, not on `facts`. Pages are already
OKF-shaped (`frontmatter` JSON, `type`, `title`, `tags`, `doc_links`; concept identity = `slug`). This
feature **completes the deferred Phase-4 doc-graph write surface** — the architects already named the
ops it needs (`add_link`/`add_tag`/`get_versions`/`revert_version`, see `graph/ops.ts:8-10`) — and adds
OKF import/export. The cross-surface op-generation machinery already exists, so the real work lands in
one place: the **`ScopedGraph` write chokepoint**, which today is read-only and has no audited write path.

- **Concept = a `pages` row, identity = `slug`** (e.g. `agent/planner/prefs`). Namespace load = slug prefix.
- **Versioning via a new `page_revisions` table** (integer rowid handle → clean monotonic ordering).
- **Rollback is forward-only** — a revert writes a new live state + a revision row; history is never mutated.
- **8 ops** (`memory_set/get/list/history/rollback/forget` + `okf_import/okf_export`) → MCP + REST + CLI
  auto-generate from one Zod registration each.
- Pages gain the **audited-write guarantee** (a `memory_audit` batch) they lack today.

> **Scope honesty:** this is larger than putting memory on `facts` — it lands a foundational graph-write
> layer, not just one table. The upside is you get OKF interop *and* the deferred doc-graph mutation
> surface (links/tags/versions) in a single build.

---

## 1. Decisions (resolved with the maintainer)
- **Home:** `pages`/docgraph (OKF-native). Rejected: `facts` (atomic; better for one-line assertions,
  but not the linked-concept-document shape OKF describes).
- **Unit:** many named items under a path → OKF concept = `slug`; "path" = slug prefix, "name" = leaf.
- **OKF compatibility** is first-class (OKF v0.1).
- **Rollback** = forward-only.
- **Body storage:** inline in `compiled_truth` for memory-origin pages (see §4).
- **Versioning store:** dedicated `page_revisions` table, not `pageVersions` (see §5).

## 2. OKF in one paragraph (v0.1, Google Cloud, 2026-06-12)
A vendor-neutral **markdown** spec — no SDK. A **bundle** is a directory of markdown files (git repo,
tarball, zip, or subdir). A **concept** is one file; its **identity is the file path** minus `.md`
(`tables/users.md` → `tables/users`). Frontmatter is YAML; **`type` is the only required field**
(non-empty); reserved optional fields are `title`, `description`, `resource`, `tags`, `timestamp`;
custom keys are allowed and **consumers must accept unknown fields**. The body is free-form markdown;
inter-concept **links are plain markdown links** (forming a graph). Reserved files: `index.md`
(bundle root, optional `okf_version`) and `log.md` (change history) — neither is a concept.

## 3. OKF ↔ pages mapping (near 1:1)
| OKF v0.1 | pages layer |
|---|---|
| bundle (dir of concepts) | a `slug` subtree (prefix) |
| concept (one .md file) | one `pages` row; id-by-`slug` (unique per tenant: `ux_pages_tenant_slug`) |
| concept id = file path | `slug` (e.g. `agent/planner/prefs`) |
| frontmatter `type` (REQUIRED) | `pages.type` — validated non-empty for memory pages |
| `title` | `pages.title` (+ mirrored in frontmatter) |
| `description`/`resource`/`tags`/`timestamp`/custom | `pages.frontmatter` JSON (passthrough; unknown keys kept) |
| body markdown | `pages.compiled_truth` (§4) |
| inter-concept markdown links | parsed from body → `doc_links` (graph for free) |
| `tags` | `tags` table (+ frontmatter.tags) |
| `log.md` change history | `page_revisions` + `memory_audit` |
| `index.md` (`okf_version`) | generated on export; parsed (not a concept) on import |
| `timestamp` (created/modified) | `created_at`/`updated_at` + revision timestamps |

The maintainer's own global memory (`MEMORY.md` + per-fact frontmatter files + `[[links]]`) is already
an OKF-shaped bundle — a real round-trip target.

## 4. Body storage
Pages' "full body in R2" is undefined/deferred (`docgraph.ts:28` comment only). For **memory-origin
pages** (`ingested_via='memory'`), store the **full OKF markdown body inline in `compiled_truth`** (not
R2). Rationale: each `page_revisions` row becomes a complete, self-contained snapshot → faithful
rollback with zero R2 plumbing; OKF concept docs are wiki-sized, well within D1 TEXT. Ingest/Obsidian
pages keep their R2 convention untouched. R2 escalation is noted if memory bodies ever grow large (YAGNI).

## 5. Versioning: dedicated `page_revisions` table (NOT `pageVersions`)
`pageVersions` is entangled with the snapshot feature (`createSnapshot`, `store.ts:559-610`) and keys on
a text UUID + `snapshot_at` (tick-collision ordering). For clean per-page history + a stable version
handle, add:
```sql
CREATE TABLE page_revisions (
  id integer PRIMARY KEY,          -- rowid alias: monotonic, the version handle + ordering key
  tenant_id text NOT NULL,
  page_id text NOT NULL,
  version integer NOT NULL,        -- per-page 1..N (computed = prior max + 1 at write)
  slug text NOT NULL,              -- denormalized for history-by-slug even after soft-delete
  type text NOT NULL,
  title text NOT NULL DEFAULT '',
  compiled_truth text NOT NULL,    -- full body snapshot
  frontmatter text NOT NULL DEFAULT '{}',
  visibility text NOT NULL,
  author_user_id text,
  reason text,                     -- 'set' | 'revert:<fromVersion>' | 'import'
  created_at text NOT NULL
);
CREATE INDEX idx_page_revisions_page ON page_revisions (tenant_id, page_id, id DESC);
```
Order history by `id DESC` (monotonic, collision-free). `version` is the human-facing number; `id` is the
durable handle for rollback targeting.

## 6. Write chokepoint — extend `ScopedGraph` (mirror the facts audit-batch pattern)
All writes route through `ScopedGraph` (the §7 isolation spine), forcing `tenant_id`, `assertScopeAllowed`,
ownership gates, and a `memory_audit` row in ONE `db.batch` (pages have NO audit path today — add it).

- **`upsertMemory({slug, type, title?, frontmatter?, body, visibility?, scope?, teamId?})`**
  - Read current live page by `(tenant, slug)`.
  - **Existing page:** `content_hash` skip-unchanged is a no-op. Else, in ONE batch: (1) INSERT a
    `page_revisions` row capturing the **prior** live state (`version=priorMax+1, reason='set'`),
    (2) UPDATE the live `pages` row (compiled_truth/frontmatter/type/title/content_hash/updated_at),
    (3) reconcile `tags` + `doc_links` from the new body, (4) `memory_audit('page.set', slug, diff)`.
  - **New page:** INSERT `pages` + initial `page_revisions(version=1, reason='set')` + tags/links +
    audit, one batch. `type` validated non-empty (OKF). `slug` is the concept id.
- **`getMemory({slug})` / `listMemory({slugPrefix, prefix?})`** → live pages (`deleted_at IS NULL`), full
  isolation predicates (tenant/scope/visibility). Returns body + OKF frontmatter + metadata.
- **`getMemoryHistory({slug})`** → all `page_revisions` for the page, `id DESC`. Does NOT filter deleted.
- **`revertMemory({slug, toRevisionId})`** → re-check the revision belongs to tenant + this slug; in one
  batch: snapshot current state as a new revision (`reason='revert:<n>'`), set the live page content to
  the target revision, `memory_audit('page.revert', slug, {from,to})`. Forward-only.
- **`forgetMemory({slug})`** → soft-delete (`deleted_at`), ownership gate, `memory_audit('page.forget')`.
  Revisions retained.
- **Internal helpers** (complete the deferred §6.5 surface, used by upsert/import — not all surfaced):
  `reconcileTags`, `reconcileLinks` (parse `[..](slug)` / `[[slug]]` from body → `doc_links`,
  `link_source='okf'`, `origin_id=pageId`), edge-dedup via the existing `idx_doc_links_unique`.

## 7. OKF import/export
- **`okf_export({slug, prefix?})`** → an OKF **bundle**: `index.md` (frontmatter `okf_version: 0.1`),
  one `<slug>.md` per live page (frontmatter from type/title/`frontmatter`, body=compiled_truth), and a
  `log.md` rendered from `page_revisions`. Returned as a file map (and/or written to R2,
  key `${tenant}/okf-export/...`, returning the key for large bundles).
- **`okf_import({bundle})`** → parse concept files (path→slug, frontmatter→type/title/frontmatter,
  body→compiled_truth); skip reserved `index.md`/`log.md`; `upsertMemory` per concept (each import is
  itself versioned + audited). Accept unknown frontmatter keys (OKF rule). Materialize links.

## 8. Ops (define once → MCP + REST + CLI auto-generate)
New `packages/db/src/memory/ops.ts` with `defineOp` (zod), `surfaces:["mcp","rest","cli"]`:
`memory_set`, `memory_get`, `memory_list`, `memory_history`, `memory_rollback`, `memory_forget`,
`okf_export`, `okf_import`. Wiring (the only places touched per the surface map):
1. `registerMemoryOps(registry)` in `packages/surface/src/registry.ts:buildRegistry()`.
2. Surface invokers in `packages/surface/src/catalog.ts` (call `ScopedGraph` methods via services).
3. Add to `buildCatalog()`.
→ MCP tools, tRPC/REST routes, and CLI commands generate automatically; the same Zod schema validates on
all three; capability gates (`read`/`write`) apply uniformly. This is what makes it "reflected across
CLI/MCP/API" with no per-surface code.

CLI shape: `brain memory_set --slug agent/planner/prefs --type note --body ...`,
`brain memory_get --slug agent/planner` (lists subtree) / exact, `brain memory_history --slug ...`,
`brain memory_rollback --slug ... --to-revision-id N`, `brain okf_export --slug ... > bundle`.

## 9. Migration `000N_pages_memory.sql`
- `CREATE TABLE page_revisions (...)` + index (§5). Add the `pageRevisions` drizzle model to
  `schema/docgraph.ts`.
- No new column on `pages` (it already has type/title/frontmatter/compiled_truth/content_hash/
  ingested_via/deleted_at). The `doc_links` edge-dedup index already exists (0001) — reuse it.

## 10. Touched files
- `packages/db/src/schema/docgraph.ts` — add `pageRevisions` model.
- `packages/db/src/graph/scoped-graph.ts` — add write methods (today read-only).
- `packages/db/src/memory/ops.ts` (new) — define + register the 8 ops.
- `packages/surface/src/catalog.ts` + `registry.ts` — invokers + registration.
- `packages/db/drizzle/000N_pages_memory.sql` (new) — migration.
- Facts/promotion untouched.

## 11. Verification plan (goal-driven; stubbed-D1 harness is the primary gate — live deploy deferred)
1. **Migration:** `page_revisions` exists; `db:generate` diff clean (best-effort on real D1).
2. **Store unit tests** (stub R2/D1 like the sessions tests):
   - set(new)→get returns body+frontmatter; type non-empty enforced.
   - set(existing) updates the live row AND appends a revision capturing the prior state;
     `content_hash` skip-unchanged is a no-op (no new revision).
   - get(slugPrefix) lists the subtree; exact slug returns one.
   - history lists revisions `id DESC` with version numbers.
   - rollback to v1 → live body == v1; a new `revert:1` revision appended; history grows.
   - forget soft-deletes; get empty; history retained.
   - tags + doc_links reconciled from body links; backlinks resolve (existing `getBacklinks`).
3. **OKF round-trip:** export a subtree → bundle; re-import into a clean tenant → identical live pages +
   frontmatter; `index.md` carries `okf_version`; unknown frontmatter keys preserved.
4. **Isolation:** cross-tenant get/history/rollback/forget return nothing / no-op; visibility tier
   respected on get + on link-target gating; scope-out-of-grant rejected; every mutation writes a
   `memory_audit` row.
5. **Surface generation:** each of the 8 ops appears as an MCP tool, a tRPC procedure, and a CLI command
   (registry drift check). Manual round-trip: set over MCP, get over REST, history+rollback over CLI.

## 12. Open defaults (flag, not blocking)
- Reserved-name handling on import: `index.md`/`log.md` are bundle structure, never concepts.
- Keep links/tags **derived** inside set/import for v1 (narrower surface; OKF body is the source of
  truth) rather than surfacing raw `add_link`/`add_tag` ops.
- `okf_version` pinned to `0.1`; consumer accepts unknown frontmatter (forward-compat rule).

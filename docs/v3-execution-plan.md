# The Brain v3 — execution plan (phased, browser-verified, reviewed, committed)

> Executes [`docs/v3-implementation-plan.md`](./v3-implementation-plan.md). Decisions locked:
> D1 rebuild-native, D2 editor via spike (TipTap-favored), D3 backing-documents, D4 collab in-scope, D5 `entities/<kind>/<name>`.
> Every phase ends with the same four gates, in order:
> **(a) local verify → (b) deploy + browser E2E (Chrome, Clerk Google sign-in) → (c) review session → (d) commit.**
> No phase starts until the previous phase's commit exists. HEAD at start = `ff83334` (v2 complete).

## Standing conventions (every phase)

### (a) Local verify
```bash
bunx turbo run check test --concurrency=1 --force   # serial (parallel bun check segfaults under load)
cd apps/api && bun run test                          # workerd canaries incl. any new one
```
New behaviour ships with tests in the same phase (unit in the owning package; canary in `apps/api/test/` when isolation or a pipeline is touched). Dashboard-only phases add component/route tests where a harness exists + rely on the browser E2E.

### (b) Deploy + browser E2E (Claude-in-Chrome)
1. Apply migrations if the phase adds any: `cd apps/api && bunx wrangler d1 migrations apply the-brain --remote`.
2. Deploy: `cd apps/api && bun run deploy`; when the dashboard changed, `cd apps/dashboard && bun run deploy`.
3. Chrome session on `https://brain-dashboard.dominik-fretz.workers.dev` (Clerk Google sign-in, click-through). Run the phase's E2E script; screenshot key screens; check the console on every screen. On any failure: fix → redeploy → re-run before (c).

### (c) Review session
Multi-angle `/code-review` fan-out over the phase diff (line-scan + removed-behavior/cross-file + reuse/simplify + altitude/conventions; add a dedicated **isolation** angle for any phase touching Scoped*/new read-write paths, and a dedicated **security** angle for W6 (WebSocket/DO auth) and W5 (bundle import = untrusted content ingress)). Verify single-source findings adversarially; fix every confirmed finding; re-review until clean.

### (d) Commit
One commit per phase, conventional message (`feat(wiki): …`), body listing what shipped + "browser-verified + reviewed", standard trailers. Never bundle two phases.

> **Note on the v2 deploy backlog:** migrations 0005–0009 and the v2 worker deploys are still
> unapplied (deferred). v3's Phase 1 migration is **0010**. Before v3's first remote apply, the v2
> migrations must be applied in order (0005→0009 then 0010) — fold this into Phase 1 gate (b), or
> apply the v2 backlog + run the v2 E2E scripts first as a "Phase 0" if you want v2 verified live
> before building v3 on top. Recommended: a short **Phase 0** does exactly that.

---

## Phase 0 — v2 live-verify + migration catch-up — ~0.5 day
**Implement:** nothing new. Apply v2 migrations 0005–0009 remotely; deploy api + dashboard; run the
accumulated v2 browser-E2E scripts from `scratchpad/v2/deferred-gates.md` (Dreams screen, hooks
inject, voice upload, filtered-search depth; Notion needs its human setup — defer if not ready).
**Gate:** browser E2E of the v2 surfaces is clean; run the `RUN_AI_GATES=1` slices that were
deferred. **Commit:** none (verification only) — or a small `chore:` if any hotfix is needed.
*(Skip only if you accept building v3 on unverified-live v2.)*

## Phase 1 — Pages become first-class: the wiki write path (W1) — ~1 week
**Implement:** extract `PageStore` from `MemoryStore` (shared upsert/revision/link-extract/tag
core; `memory_*` contract byte-identical); ops `wiki_save_page`/`wiki_get_page`/`wiki_list_pages`/
`wiki_move_page`/`wiki_delete_page` (registry/catalog/CLI/MCP derived, zod in the closed
json-schema set); red-link handling (`pending_links` table or `doc_links.resolved` flag —
decide at migration); relax memory-only listing guards so memory pages appear in wiki listings
while `memory_*` stays memory-scoped; migration **0010** (`pending_links`/flag, `pages.entity_id`,
listing indexes).
**Browser E2E:** via CLI/MCP create a page, `[[link]]` to a missing slug → red link recorded;
create that slug → link resolves; `wiki_list_pages` returns the tree incl. memory items; move a
page → links re-point + redirect stub.
**Review:** full + isolation pass (new write path all through Scoped*/audit; memory ops unregressed).
**Commit:** `feat(wiki): first-class pages — PageStore, wiki_* ops, red-links (W1)`

## Phase 2 — Entity pages + idea pages (W2) — ~1 week
**Implement:** entity pages (`entities/<kind>/<name>`, `pages.entity_id`, visibility inherited);
minting — lazy-on-visit, dream kind `entitypages` (backfill via `runDreamJob`, budgeted/cursored),
D4 merge re-points loser→winner page with redirect; live-rendered mention/relation/timeline
sections (not stored); dream reflection ALSO updates the target's entity page through `PageStore`
(versioned, dream-authored, anti-loop excluded per W-i4); promote `/brain/insights/*` to pages
(`ingested_via='insight'`, `[[slug]]` Sources → real `doc_links`).
**Browser E2E:** `/wiki/entities/...` shows an agent-maintained page with live sections; trigger a
dream → the entity page updates + history shows the dream author; insight pages linkable/backlinked.
**Review:** full + isolation (entity-page visibility == entity visibility; merges re-point) +
anti-loop pass. **Commit:** `feat(wiki): entity pages + idea pages, dream-maintained (W2)`

## Phase 3 — Wiki search integration: backing documents (W3) — ~3-4 days
**Implement:** every page write upserts a lightweight backing `documents` row (namespace
`/wiki/<slug>`, `sourceKind='page'`) through the ingest spine (chunks/FTS/vectors/citations/KG);
edits supersede; delete cascades; `origin='wiki-agent'` when the revision author is system (anti-loop
excludes like dream docs); reuse the skip-unchanged hash so unchanged saves don't re-embed.
**Browser E2E:** save a page → findable via `search` + cited by `think` within a minute; recall/think
cites an entity page; delete → gone from search.
**Review:** full + isolation + anti-loop (agent pages never reflection targets). **Commit:**
`feat(wiki): pages searchable via backing documents (W3)`

## Phase 4 — Editor spike + view mode (W4a) — ~1 week
**Implement:** **spike first (1 day)** — TipTap vs BlockNote on the SSR worker: markdown
round-trip, `[[wikilink]]` custom node + autocomplete, slash menu, **Yjs/y-prosemirror
compatibility (D4 gate)**, bundle size. Lock the choice (resolves D2) in a one-page note committed
to `docs/`. Then **view mode**: `/wiki` + `/wiki/$` routes, sidebar tree (namespaces + entities +
memory + drafts), markdown renderer with `[[wikilink]]`→router links (red when pending), code
highlighting, Mermaid, tables; backlinks panel (`get_backlinks`); tags; timeline; history+diff
panel; dark mode.
**Browser E2E:** browse the sidebar, open an entity page, see rendered markdown + resolved/red
wikilinks + backlinks panel + history diff; console clean.
**Review:** full (+ perf/bundle eyeball). **Commit:** `feat(wiki): editor kit decision + wiki view mode, sidebar, backlinks (W4a)`

## Phase 5 — Edit mode + quick-switcher (W4b) — ~1.5 weeks
**Implement:** the chosen editor in edit mode — slash `/` menu, floating toolbar, `[[wikilink]]`
autocomplete (queries `wiki_list_pages`+`search_entities`, create-on-enter for red links),
`@`-mention entities (inserts entity-page link), image upload to R2, markdown paste/round-trip,
draft autosave + explicit Save-as-revision; Cmd+K quick-switcher (pages+entities+documents);
Memory screen + document detail upgraded to the same editor/renderer.
**Browser E2E:** create a page via a red link, edit with slash menu + wikilink autocomplete + a
mention; save → backlinks update live; history shows the revision + rollback works; Cmd+K jumps.
**Review:** full + isolation (edit writes through Scoped*/PageStore). **Commit:**
`feat(wiki): rich edit mode — slash menu, wikilink/@mention autocomplete, Cmd+K (W4b)`

## Phase 6 — Indexes + OKF bundles + agent maintenance (W5) — ~1 week
**Implement:** auto-maintained `index` pages per namespace + root `/wiki/index` (cheap hook on save
+ nightly dream kind `indexes`, LLM-optional with deterministic fallback); `okf_export` gains
subtree/namespace bundle packaging (per-section + root index, `okf_version`) + wiki "Share as
bundle" zip download; `okf_import` accepts a full bundle (path or GitHub URL) → namespaced pages,
wikilinks resolved/red-linked, searchable via W3, draft-visibility + never instruction-grade;
`brain wiki import`; MCP guide documents the progressive-disclosure pattern + "save durable
learnings as pages".
**Browser E2E:** export `entities/` as a bundle zip; import Cole's example bundle (or a fixture) via
the dashboard → browseable/searchable/linked pages; root index current after several edits.
**Review:** full + **security** (bundle import = untrusted content ingress: draft-visibility,
injection-posture, no instruction escalation) + isolation. **Commit:**
`feat(wiki): OKF index pages + shareable bundle export/import + agent maintenance (W5)`

## Phase 7 — Realtime collab + presence (W6) — ~1.5 weeks
**Implement:** `WikiRoom` Durable Object (new `new_sqlite_classes` migration tag) — per-page Yjs
room (key = tenant+slug), Clerk→Principal auth + visibility check **before** WS upgrade
(fail-closed), Yjs state in DO SQLite, periodic + on-idle flush into `PageStore` revisions (DO is a
hot cache, `PageStore` stays source of truth for history/audit/OKF); `y-prosemirror` on the editor;
live cursors + presence avatars; single-editor optimistic-lock is the degraded mode when the
DO/WS is unreachable. Dashboard SSR worker gets a binding/route to the DO.
**Browser E2E:** two Clerk users of one tenant edit one page — live cursors, converged body, one
flushed revision in history with attribution; a user lacking page visibility is refused the room
(fail-closed); DO restart loses no committed revision.
**Review:** full + **security** (WS/DO auth, room isolation) + isolation. **Commit:**
`feat(wiki): realtime collaborative editing — Yjs on WikiRoom Durable Object (W6)`

## Phase gate summary

| Phase | Ships | Canary | Browser E2E focus | Prefix |
|---|---|---|---|---|
| 0 | v2 live-verify + migration catch-up | — | v2 surfaces green live | `chore:` (if any) |
| 1 | W1 first-class pages | wiki isolation, red-link | create/move/link a page via CLI+MCP | `feat(wiki):` |
| 2 | W2 entity/idea pages | entity-page visibility, anti-loop | dream-maintained entity page | `feat(wiki):` |
| 3 | W3 backing-doc search | anti-loop, lifecycle | page found by think, cited | `feat(wiki):` |
| 4 | W4a spike + view mode | — | sidebar, render, backlinks, history | `feat(wiki):` |
| 5 | W4b edit mode + Cmd+K | edit-path isolation | slash/wikilink/mention, save, rollback | `feat(wiki):` |
| 6 | W5 indexes + OKF bundles | index idempotency, bundle round-trip | export+import a bundle | `feat(wiki):` |
| 7 | W6 collab | room isolation, no-revision-loss | two-user live edit | `feat(wiki):` |

Total ~7–9 weeks sequential; W2/W3 interleave after W1; the W4 spike runs immediately.

## Execution-flow risks
- **Live E2E mutates real tenant data.** Use a dogfood tenant for planted pages/imports; clean up
  after each phase (`wiki_delete_page` / `forget`), so dreams don't consolidate test noise.
- **Editor lands in the SSR worker** — measure bundle at the W4 spike; code-split the editor route.
- **Anti-loop compounds** (dreams write pages → back documents → feed dreams): one provenance model
  (authorship + origin) enforced in every candidate SELECT; the extended dream canary is the gate.
- **Collab flush correctness** — the DO must never be the source of truth; every acceptance run
  asserts the flushed revision is canonical and DO-restart-durable.

# The Brain v3 — implementation plan: the LLM Wiki (Outline-grade pages over the knowledge graph)

> Inputs: (1) the Karpathy-LLM-wiki / **OKF** transcript (`~/devel/bruce/agent/data/transcripts/2026-07-04…cole_medin.md`);
> (2) a deep-dive of **outline/outline** (v1.8.1: license, editor internals, architecture, UI inventory);
> (3) a substrate recon of this repo @ `ff83334` (v2 complete). Evidence and file:line references
> live in the research notes; this plan states conclusions.
> Style and invariants follow `docs/v2-implementation-plan.md`; everything rides the existing spine
> (op-registry, `Scoped*`, ingest, dream engine, budget, governance).

## Vision

One sentence: **turn the Brain's knowledge graph into a living wiki** — every entity and idea gets a
real page with an Outline-grade editing experience; `[[wikilinks]]`, backlinks, tags and timelines
connect them; the dream engine *maintains* the wiki the way Karpathy described (read new sources →
integrate → update entity pages → maintain indexes); and the whole thing speaks **OKF** so any wiki
can be exported as a shareable bundle and any OKF bundle can be imported as first-class pages.

Three sources of truth converge here, and the striking finding is how little fights us:

| Pillar | Source | Status in the Brain today |
|---|---|---|
| LLM-maintained wiki (entity pages, indexes, progressive disclosure) | Karpathy / OKF transcript | Dream engine already reads-integrates-consolidates; **OKF is already our memory format** (`type` required, `okf_export`/`okf_import` ship today) |
| Wiki data layer (pages, links, tags, revisions) | our own v1/v2 work | **Built and battle-tested** — but only agent memory writes it, and nothing renders it |
| Editing & navigation UX | Outline | **Absent** — no editor, no markdown renderer, no wiki routes |

## What exists vs. what's missing (gap analysis)

**Already built (the wiki's skeleton):**
- `pages` + `doc_links` + `tags` + `timeline_entries` + `page_revisions` — typed page graph with
  backlink index, idempotent curation ops (`add_link`/`add_tag`/`add_timeline_entry`, Phase 9),
  per-edit version history with forward-only rollback, Clerk-attributed authorship, full audit.
- `[[wikilink]] → doc_links` extraction **already runs** on every memory write
  (`MemoryStore.extractLinkSlugs` → linkSource `okf`) — the edges exist; no UI shows them.
- OKF import/export of page bundles (frontmatter with required `type`, reserved `index.md`).
- Entities (canonical names, aliases, mentions, relations, D4 dedup) + `entity_mentions.sourceKind`
  already includes `'page'` — the KG↔page bridge is pre-wired.
- Dream insights are proto-idea-pages (`/brain/insights/*` documents, cited markdown with `[[slug]]`
  Sources) — the LLM already *writes* wiki-shaped artifacts nightly.

**Missing (the wiki itself):**
1. Pages are **memory-only** (`ingested_via='memory'`): no human/wiki authoring path, no red-link
   stub creation, unresolved wikilinks silently dropped.
2. Pages are **invisible to search/think/recall** — no FTS, no vectors, no citations.
3. **No entity pages**: entities have no slug, no body, no detail route.
4. **Zero rendering/editing UI**: memory edit is a monospace `<textarea>`; bodies render in `<pre>`;
   no markdown renderer dependency exists in the dashboard at all.
5. **No index pages / progressive disclosure** as first-class maintained artifacts.
6. Insights live as documents, outside the page graph (their wikilinks are cosmetic).
7. No sharing story beyond raw OKF export (no "bundle" packaging of a subtree).

---

## The Outline question: what "reuse what they built" can mean

Research verdict (details in the research notes):

- **License**: outline/outline is **BSL 1.1** (converts to Apache-2.0 per-version after ~4 years;
  v1.8.1 → 2030). The Additional Use Grant permits everything **except running a "Document
  Service"** (a commercial hosted offering where third parties create teams+documents). Personal /
  internal / self-hosted use of the code — including embedding pieces — is **permitted**. The old
  standalone `rich-markdown-editor` is BSD-3 but **archived** (React 16, no collab, stale).
- **The editor** is ProseMirror (29 node types, markdown round-trip first-class, Mermaid/Math/
  embeds/mentions/comments). But the signature chrome — slash menu, floating toolbar, mention
  picker — lives in `app/` (not the extractable `shared/editor`), and `shared/editor` hard-depends
  on **React 17 + styled-components v5**, both hostile to our React 19 + Tailwind/shadcn stack.
- **Outline the app can never run on Cloudflare Workers** (Koa/Sequelize/Postgres/Redis/Hocuspocus
  — long-lived Node server). Running it means a second, off-Cloudflare stateful stack.
- **Collab**: Outline's Yjs choice ports cleanly — `y-prosemirror` on the client is
  transport-agnostic, and **Yjs backs onto Durable Objects** (`y-durableobjects` / PartyKit
  patterns). Hocuspocus itself does not. Our repo already proves the DO pattern (`BrainMCP`).

**Three strategies, one recommendation:**

| | A. Run Outline alongside + sync | B. Extract/port `shared/editor` | C. Rebuild Outline's UX on a maintained MIT ProseMirror kit |
|---|---|---|---|
| License | BSL, fine for us | BSL, fine for us (legal review before any commercial offering) | Clean MIT |
| Effort | Low code, HIGH ops (VPS + Postgres + Redis + S3 forever) | High (React 17→19 port, styled-components excision, rebuild all chrome anyway) | Medium (chrome comes batteries-included; we build wikilinks/backlinks ourselves) |
| Fit | UX lives outside our dashboard; Brain reduced to a sync target | Fights our stack at every seam | Native React 19 + Tailwind/shadcn + Workers |
| Outcome | Outline's exact UX, weak integration | Outline's exact schema, worst of both | Outline's *experience*, our substrate, deep integration |

**Recommendation: C** — build the wiki UI **in our dashboard** on **TipTap** (MIT, ProseMirror-based,
the same foundation Outline chose) with the Outline feature inventory as the explicit spec, plus
**Outline-as-reference**: since BSL permits it for our use, we consult/port *specific* pieces where
they're the best implementation (their `prosemirror-markdown` serialization rules, node specs,
input rules) with attribution comments, instead of wholesale UI extraction. Yjs-on-DO is the
collab path when we want it.
*(Alternative editor kit: BlockNote — more batteries, more opinionated/Notion-block-shaped, less
room for a custom `[[wikilink]]` grammar. TipTap keeps us closest to Outline's behavior. Final
call is Decision D2 below; W4 starts with a 1-day spike comparing both on our stack.)*

What we replicate from Outline's UX inventory (the spec for W4/W5):
sidebar collection/tree nav · Cmd+K quick-switcher · WYSIWYG-markdown editor with slash `/` menu,
floating selection toolbar, `@`-mentions, `:emoji:` · `[[wikilink]]` autocomplete (Outline lacks
this; Obsidian-style, ours is better because the graph exists) · backlinks panel · tags ·
templates-lite · revision history with diff · dark mode · keyboard-first. Explicitly **not** v3:
comments/threads, reactions, public share links, read-insights (listed under Deferred).

---

## Design principles (extend the HARD invariants)

- **W-i1 One page store.** Wiki pages ARE `pages` rows — the same table memory uses, not a parallel
  system. `ingested_via` distinguishes provenance (`memory` | `wiki` | `entity` | `insight`).
  Memory items simply become pages you can also see in the wiki (they already carry OKF `type`).
- **W-i2 OKF-native.** Every page has frontmatter with required `type`; slugs are OKF concept ids;
  namespaces (slug prefixes) are the "sections"; `index` pages per namespace + a root index are
  first-class, agent-maintained artifacts. Export of any subtree = a valid OKF bundle.
- **W-i3 The agent is a first-class author, the human is the editor-in-chief.** Dream/ingest write
  and update pages under the same versioning + audit as humans; `page_revisions.authorUserId`
  distinguishes them; nothing the agent writes is instruction-grade by authorship (trust rules
  unchanged from v2, D-i1).
- **W-i4 Anti-loop discipline carries over (D-i2).** Agent-authored wiki content must not feed
  back into extraction/dreams unbounded: pages carry provenance, and dream candidate SELECTs treat
  agent-authored pages exactly as they treat `origin='dream'` documents today.
- **W-i5 Isolation unchanged.** All page reads/writes stay behind `Scoped*` + visibility/scope
  predicates; entity pages inherit the entity's {world,team} visibility; the wiki UI adds zero new
  authorization semantics.
- **W-i6 Search must see the wiki.** A page that can't be found by `think`/`search`/`recall` is not
  memory. (Mechanism = Decision D3.)

---

## Workstreams

```
W1 (page layer generalization)  ────────►  foundation, first
W2 (entity + idea pages)        ──┐ after W1 (needs page minting)
W3 (wiki search integration)    ──┤ after W1, parallel with W2
W4 (editor + wiki UI)           ──┤ spike early (incl. Yjs check); bulk after W1
W5 (indexes, OKF bundles, agent maintenance) ── after W2+W3
W6 (collab/presence on DO)      ────────►  after W4 (IN SCOPE per D4)
```

Definition of done for v3: **open `/wiki`, browse a sidebar of namespaces + entity pages, click an
entity page that the dream engine wrote and has kept current, edit it in a rich editor with
`[[wikilink]]` autocomplete, see backlinks update, find the page via `think` with a citation, and
export the subtree as an OKF bundle someone else's agent can consume.**

### W1 — Pages become first-class (the wiki write path) — ~1 week

1. **Generalize the page store.** Extract the page-CRUD core out of `MemoryStore` (upsert/revision/
   link-extraction/tag-reconcile) into a `PageStore` that both memory and wiki use; `memory_set`
   keeps its exact contract (`ingested_via='memory'`, ownership gate). New ops:
   `wiki_save_page` (slug, body, frontmatter; versioned; `ingested_via='wiki'`),
   `wiki_get_page` (page + rendered-ready body + backlinks + tags + timeline),
   `wiki_list_pages` (by namespace prefix / type / tag, tree-shaped for the sidebar),
   `wiki_move_page` (slug rename with link re-pointing + redirect stub — wiki-only),
   `wiki_delete_page` (soft). All registry/catalog/CLI/MCP via the existing derivation.
2. **Red links.** Link extraction gains "unresolved wikilink" handling: instead of dropping, record
   in a small `pending_links` table (or `doc_links` with a `resolved=0` flag — pick at migration
   time); creating a page with a matching slug resolves them retroactively. The editor renders
   unresolved links red and "click to create".
3. **Relax the memory-only guards deliberately** (the `ingested_via='memory'` filters in
   MemoryStore) so memory items appear in wiki listings (they're pages; W-i1) while `memory_*` ops
   keep operating only on memory-provenance pages.
4. **Migration 0010**: `pending_links` (or the flag), `pages.entity_id` (nullable FK → entities,
   for W2), any missing indexes (`pages(tenant, slug-prefix)` listing support).

Acceptance: create/edit/move a page via `wiki_save_page` from MCP + CLI; `[[link]]` to a
non-existent page creates a red link; creating that page resolves it; memory items show up in
`wiki_list_pages`; canary: wiki writes are tenant/scope-isolated, versioned, audited; memory ops
untouched (existing canaries green).

### W2 — Entity pages + idea pages (the graph becomes browseable) — ~1 week

1. **Entity pages**: a page whose subject IS an entity. Slug convention `entities/<kind>/<slugified
   canonical-name>`; `pages.entity_id` links it; visibility inherited from the entity. Minting:
   (a) lazily on first visit to an entity in the wiki UI ("create page" from the entity stub view),
   (b) by the dream engine (below), (c) bulk-backfill op `wiki_mint_entity_pages` (budgeted,
   cursored via `runDreamJob` — it's a dream kind: `entitypages`).
   An entity page's body: agent-written summary; auto-sections rendered live (not stored): mentions
   (from `entity_mentions`), relations (from `entity_relations` → links to other entity pages),
   timeline. D4 merges re-point the loser's page (redirect stub → winner's page).
2. **Dream reflection targets entity pages** (evolves Phase-2/D2): where reflection today writes an
   insight *document*, it now ALSO updates the target's entity page — merging new knowledge into
   the page body through `PageStore` (versioned; the human can always roll back). Anti-loop: pages
   authored by the dream are excluded from reflection-target selection like `origin='dream'` docs
   (W-i4). Insight documents stay (they're the cited evidence artifacts); the entity page links to
   its insights.
3. **Idea pages**: promote `/brain/insights/*` to the page graph — mint a page per insight
   (`ingested_via='insight'`, body = the insight markdown), with its `[[slug]]` Sources parsed into
   real `doc_links`. New insights mint pages at creation.
4. **Consolidation ↔ wiki**: the daily digest links to touched entity pages; contradictions
   filed by dreams reference the entity page for context.

Acceptance: browsing `/wiki/entities/...` shows agent-maintained pages with live
mention/relation/timeline sections; a nightly dream updates an entity page and the page history
shows the dream as author; insight pages are linkable and backlinked; graph canary extended: entity
page visibility == entity visibility, merges re-point pages.

### W3 — The wiki is searchable (Decision D3 executed) — ~3-4 days

**Recommended mechanism: activate the dormant backing-document model** (`pages.documentId` FK the
schema already anticipates): every page write upserts a lightweight backing `documents` row
(namespace `/wiki/<slug>`, `sourceKind='page'`) through the normal ingest spine → chunks, FTS,
vectors, citations, KG extraction all come free; `update_document`-style supersede handles edits;
page delete cascades. Anti-loop: backing docs carry `origin='wiki-agent'` when the page revision's
author is the system (W-i4), and reflection excludes them like dream docs.
*(Alternative: `pages_fts` + a fourth search arm — lighter writes, but re-implements chunking,
embedding, citation and recall integration that the spine already does. Only preferable if the
double-write proves too heavy; the plan bets on reuse.)*
KG extraction on wiki pages closes a loop from the transcript: human-authored wiki knowledge
feeds the entity graph, which feeds entity pages.

Acceptance: a wiki page is findable via `search` and cited by `think` within a minute of saving;
recall/think answers can cite entity pages; anti-loop canary: agent-authored pages never become
reflection targets; deleting a page removes it from search (existing lifecycle canaries pattern).

### W4 — The editor + wiki UI (the Outline experience) — ~2-3 weeks, the headline

Routes (dashboard, TanStack Start — drop-in per recon): `/wiki` (home = root index + recent +
quick-switcher), `/wiki/$` (splat page view/edit), layout with **sidebar tree** (namespaces as
collections; entities section; memory section; drafts = unpublished flag in frontmatter),
breadcrumbs, dark mode inherited.

1. **Spike (1 day, first)**: TipTap vs BlockNote on our stack — markdown round-trip fidelity,
   `[[wikilink]]` custom node + autocomplete feasibility, slash menu, bundle size on the SSR
   worker. Output: locked editor choice (Decision D2 resolved with evidence).
2. **View mode** (ships before edit mode): markdown renderer (react-markdown or the editor's
   read-only mode — spike decides) with `[[wikilink]]` → router links (red when pending),
   headings/anchors, code highlighting, Mermaid (Outline parity), tables; **backlinks panel**
   (from `get_backlinks` — the data has been waiting since v1); tags; timeline section; page
   history panel (reuse memory history UI patterns + diff view).
3. **Edit mode**: the chosen editor with — slash `/` block menu · floating selection toolbar ·
   `[[wikilink]]` autocomplete querying `wiki_list_pages`+`search_entities` (create-on-enter for
   red links) · `@`-mention (entities; inserts entity-page link) · image upload (R2 via the
   existing body store) · markdown paste/round-trip · autosave drafts with explicit
   Save-as-revision (versioning stays meaningful) · keyboard-first.
4. **Quick-switcher (Cmd+K)**: pages + entities + documents, powered by `search_entities` +
   `wiki_list_pages` + FTS; actions (new page, jump to graph view).
5. **Graph affordance**: entity page ↔ the existing `/graph` force view (deep link both ways);
   Outline has no graph — ours does, keep it.
6. **Memory/insights folded in**: Memory screen's editor upgrades to the same component (one
   editor everywhere); document detail views get the markdown renderer.

Acceptance (browser E2E): full Outline-inventory walkthrough — sidebar nav, Cmd+K, create page via
red link, edit with slash menu + wikilink autocomplete, backlinks update live after save, history
diff + rollback, entity mention → entity page, mobile-passable rendering, console clean.

### W5 — Indexes, bundles, and agent maintenance (the OKF story) — ~1 week

1. **Index pages** (the transcript's core mechanic): auto-maintained `index` page per namespace +
   root `/wiki/index` — one line + summary per child page ("two layers of indexing"). Maintained by
   (a) a cheap hook on page save (update the parent index entry) and (b) a nightly dream step
   (`indexes`: regenerate summaries for changed pages, budgeted, LLM-optional — deterministic
   fallback is title+first-para). Agents get progressive disclosure: `wiki_get_page('index')` →
   drill down — document this pattern in the MCP guide.
2. **OKF bundle export**: `okf_export` gains subtree/namespace selection + bundle packaging
   (index.md per section, root index, `okf_version`), downloadable zip from the wiki UI ("Share
   this section as a bundle") — Cole's use-case verbatim.
3. **OKF bundle import**: `okf_import` accepts a full bundle (or GitHub URL via the dashboard) →
   pages under a chosen namespace, wikilinks resolved/red-linked, indexes preserved; imported pages
   are searchable via W3. The CLI gets `brain wiki import <path|url>`.
4. **Agent maintenance loop documented + wired**: the MCP guide teaches "when you learn something
   durable, wiki_save_page it and link related concepts" — the Brain-side complement to the
   dream-side automation; capture/session promotion can suggest wiki updates (deferred if scope
   creeps).

Acceptance: export `entities/` as a bundle → a fresh agent given only the OKF spec + the zip
navigates it correctly; import Cole's example bundle → browseable, searchable, linked pages; the
root index stays current across a week of edits (canary: index regeneration idempotent, budgeted).

### W6 — Collab & presence (IN SCOPE per D4) — ~1-2 weeks

Yjs (`y-prosemirror` on the chosen editor) + a `WikiRoom` Durable Object (pattern proven by
`BrainMCP`): WebSocket transport per page (room key = tenant+slug, auth via the existing Clerk →
Principal flow before socket upgrade), Yjs doc state in DO SQLite with periodic + on-idle flush
into `PageStore` revisions **so history/audit/OKF stay canonical** (the DO is a hot cache + sync
fabric, never the source of truth). Presence/awareness = live cursors + "who's here" avatars in
the page header. Single-editor optimistic-lock remains the degraded mode when the DO/WS is
unreachable (offline-tolerant via y-indexeddb is a stretch goal, not acceptance).

Acceptance: two browser sessions (two Clerk users of the same tenant) edit one page with live
cursors; both see the same converged body; the flushed revision appears once in page history with
both authors attributed (or the flusher + a participants note — decide at implementation);
tenant/visibility isolation canary: a user without page visibility cannot join the room
(fail-closed before upgrade); DO restart loses no committed revision.

---

## New/changed surface summary

| Kind | Item |
|---|---|
| Tables (0010) | `pending_links` (or resolved-flag on `doc_links`); `pages.entity_id`; listing indexes |
| Stores | `PageStore` extracted from MemoryStore (shared core); backing-document write-through (W3) |
| Ops | `wiki_save_page`, `wiki_get_page`, `wiki_list_pages`, `wiki_move_page`, `wiki_delete_page`, `wiki_mint_entity_pages`; `okf_export`/`okf_import` gain bundle/subtree; existing memory/graph ops unchanged |
| Dream | reflection updates entity pages; new kinds `entitypages` (backfill mint) + `indexes` (nightly index maintenance) via `runDreamJob`/`dreamStepPlan` |
| Dashboard | `/wiki` section (sidebar tree, page view/edit, backlinks panel, Cmd+K, history/diff); editor component (TipTap or BlockNote per spike); markdown renderer; Memory screen upgraded to same editor |
| MCP/guide | wiki ops + progressive-disclosure pattern documented; purposeOf gains a Wiki family |
| CLI | generated wiki ops + `brain wiki import` |
| DO (W6, optional) | `WikiRoom` (Yjs transport + snapshot) |
| Canaries | wiki isolation (writes scoped, entity-page visibility inheritance), anti-loop (agent pages never reflection targets), red-link resolution, index idempotency, bundle round-trip (export→import→equal) |

## Decisions (made by Dominik, 2026-07-04)

- **D1 — Outline strategy: C, DECIDED** — rebuild the experience natively on a maintained MIT
  ProseMirror kit, with Outline's feature inventory as the spec and its BSL-permitted code as
  reference for specific internals. No Outline-alongside, no code extraction.
- **D2 — Editor kit**: resolved by the W4 spike (TipTap favored: closest to Outline's foundation,
  best custom-node control for wikilinks; BlockNote is the fallback if the spike says otherwise).
- **D3 — Search mechanism: backing-document write-through, DECIDED** (reuses the whole spine).
- **D4 — Collab: IN SCOPE for v3, DECIDED** — W6 (Yjs + `WikiRoom` Durable Object, live
  cursors/presence) is part of the v3 mainline, not optional. The editor spike (W4) must therefore
  verify Yjs compatibility of the chosen kit up front (both TipTap and BlockNote support
  y-prosemirror; the spike confirms on our stack).
- **D5 — Entity-page slug scheme**: `entities/<kind>/<name>` (default accepted).

## Risks

- **Editor scope creep** — the Outline inventory is seductive; W4 acceptance list is the contract,
  everything else (comments, reactions, share links, templates-full) goes to Deferred.
- **Double-write weight (D3)** — every page save also runs the ingest spine (chunks+embeddings).
  Mitigations: skip-unchanged content hash already exists; embeddings only on material change;
  if page-save latency hurts, queue the backing-doc refresh (the spine is already queue-shaped).
- **Anti-loop complexity compounds** — dreams write pages, pages back documents, documents feed
  dreams. One provenance model (W-i4: authorship + origin) enforced in every candidate SELECT,
  extended dream canary is the gate — same discipline that held in v2.
- **Dream-authored page quality** — a bad merge into an entity page is user-visible. Mitigations:
  everything versioned + one-click rollback (exists), dream edits marked by author in history,
  digest lists every page the dream touched (v2 transparency pattern).
- **Bundle import is a content-injection surface** — imported pages are third-party text entering
  search/context. Mitigations: imports are draft-visibility by default, never instruction-grade
  (v2 trust rules), and the injection-posture conventions (blockquote-untrusted) apply to any
  agent-facing rendering of imported content.
- **SSR bundle size** — the editor lands in the dashboard worker; spike measures it; code-split the
  editor route if needed.

## Effort estimate

W1 ~1w · W2 ~1w · W3 ~3-4d · W4 ~2-3w · W5 ~1w · W6 ~1-2w → **~7-9 weeks sequential**;
W2/W3 parallelize after W1, the W4 spike (incl. Yjs verification) runs immediately. Same
per-phase gates as v2 (serial check → deploy+browser E2E → multi-angle review → commit) per
`docs/v3-execution-plan.md`.

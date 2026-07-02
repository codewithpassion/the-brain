# The Brain v2 — detailed execution plan (phased, browser-verified, reviewed, committed)

> Executes [`docs/v2-implementation-plan.md`](./v2-implementation-plan.md) (W0.1–W0.3 deferred).
> Every phase ends with the same four gates, in order:
> **(a) local verify → (b) deploy + browser E2E via the connected Chrome browser (Clerk sign-in
> with the Gmail account) → (c) review session → (d) commit.**
> No phase starts until the previous phase's commit exists.

## Standing conventions (apply to every phase)

### (a) Local verify
```bash
bun check                      # biome strict + tsc strict + all tests + boundary-lint
cd apps/api && bun run test    # workerd canaries (incl. any new canary added in the phase)
```
New behaviour ships with tests in the same phase (unit in the owning package, canary in
`apps/api/test/` when isolation or a pipeline is touched).

### (b) Deploy + browser E2E (Claude-in-Chrome)
1. Apply migrations if the phase adds any:
   `cd apps/api && bunx wrangler d1 migrations apply the-brain --remote`
2. Deploy: `cd apps/api && bun run deploy` and, when the dashboard changed,
   `cd apps/dashboard && bun run deploy`.
3. Browser session (the connected Chrome browser, via the claude-in-chrome tools):
   - Open `https://brain-dashboard.dominik-fretz.workers.dev`.
   - If signed out: click **Sign in** → **Continue with Google** → pick the Gmail account
     registered on Clerk (dev instance `electric-bonefish-70.clerk.accounts.dev`). The account
     is already signed into Chrome, so this is click-through only — no password entry.
   - Run the phase's E2E script (listed per phase below). Screenshot the key screens as
     evidence; check the browser console for errors on every visited screen.
   - On any failure: fix, redeploy, re-run the script before moving to (c).

### (c) Review session
- Run `/code-review` over the phase's diff (working tree vs the previous phase's commit).
- Fix every confirmed correctness finding; re-review until none remain (the repo's
  "reviewed to ≥80%" convention from the Obsidian phases).
- Isolation-relevant phases (1, 2, 4, 6) additionally get a canary-focused pass: does any new
  read path bypass `Scoped*` / the D1 re-check? (boundary-lint + reviewer attention.)

### (d) Commit
One commit per phase, conventional message (`feat(dream): …`), body listing what shipped +
"browser-verified + reviewed" note, with the repo's standard trailers. Never bundle two phases.

---

## Phase 0 — Hygiene sweep (W0.4) — ~half a day

**Implement**
- Fix stale device-flow comments: `apps/cli/src/auth/device.ts`, `apps/cli/src/commands/auth.ts`.
- Update `README.md` "Deferred" list: device flow is end-to-end; note W0.1–0.3 deferral.
- Triage `test.todo`/`.skip` (`packages/db/test/ai.test.ts`, `apps/api` slice/rerank/sessions/
  graph canaries): implement the cheap ones, convert the rest to a tracked list in this doc.

**Browser E2E (baseline run — proves the harness itself)**
1. Sign in per convention (b). Verify the Clerk Google flow completes and lands on Search.
2. Visit every nav screen (Search, Documents, Memory, Graph, Sessions, Add; Admin → Stats,
   Members, API Keys, Vault Sync, Audit, Jobs, Facts) — each renders, console clean.
3. Run one `think` query from the Search screen and confirm a cited answer renders.

**Review:** light pass (docs/comments diff). **Commit:** `chore: hygiene sweep — stale device-flow notes, test.todo triage, W0 deferral notes`

### Deferred test todos (triaged 2026-07-02)

The `sessions`/`graph` canaries carry `test.todo` only in their header comments (documenting the
todos they were *converted from*); both are real green canaries now — nothing to implement. The
remaining live `test.todo`/`.skip` markers are all real-AI gates (`RUN_AI_GATES=1`), so each needs
a deployed worker + live Workers AI and cannot run in the stubbed `bun check`/workerd harness. They
stay in place until W0.2 (scheduled real-AI gate) lands:

- `packages/db/test/ai.test.ts:355` — reranker index→chunk remap shape gate. Deferred: needs the
  real `@cf/baai/bge-reranker-base` neuron (PRD §10.6); no local stub asserts the live shape.
- `apps/api/test/slice.e2e.test.ts:252` — `ingest→think` over bge-m3 + bge-reranker + llama-3.3-70b
  cites the doc. Deferred: run remote against the deployed worker with real Vectorize + Workers AI.
- `apps/api/test/rerank-shape.gate.test.ts:28` — live reranker shape gate. Deferred: same real-AI
  dependency as above; the team-lead runs it out-of-band with `RUN_AI_GATES=1`.

---

## Phase 1 — Dream engine core: fact consolidation (D1) — ~4–5 days

**Implement**
- Migration `0005`: `dream_runs` table (id, tenant_id, kind `consolidation|reflection|dedup|hygiene`,
  cursor, counts JSON, tokens_spent, status, started_at/finished_at). Registered in
  `packages/db/drizzle/`.
- `packages/db/src/dream/`: `select.ts` (candidate facts: active, not superseded/consolidated,
  `is_dream_generated=0`; grouped by `(entity_slug, kind)` then embedding clusters at
  cosine ≥ 0.85), `judge.ts` (typed-JSON `gen()` verdicts merge/supersede/contradict/keep, with
  the KG extractor's salvage parsing), `apply.ts` (one `db.batch` per cluster: consolidated fact
  `is_dream_generated=1` + lineage pointers + `memory_review` rows for contradictions + audit
  rows in the same batch), `run.ts` (`runDreamConsolidation` — budget slice via `token_spend`
  `surface='dream'`, resumable cursor, idempotent per-day).
- `apps/api/src/dream/workflow.ts`: `DreamWorkflow` (id `dream-${tenantId}-${yyyymmdd}`);
  nightly cron `0 3 * * *` added to `wrangler.jsonc` + `scheduled()` dispatch.
- Ops: `dream_now` (admin trigger), `list_dream_runs`; `recall` gains
  `includeSuperseded?: boolean` (default false).
- **Dream canary** (`apps/api/test/dream.canary.test.ts`): two tenants with planted duplicate +
  contradicting facts → run consolidates within tenant only; contradiction lands in
  `memory_review`; tiny budget stops with a resumable cursor; same-day re-run is a no-op;
  dream-generated facts are never re-consolidated (anti-loop).

**Browser E2E**
1. Seed via dashboard: on **Facts**… facts are session-promoted, so instead use MCP/CLI to
   plant 6 overlapping facts (e.g. three phrasings of a pricing decision + one contradiction),
   then trigger `dream_now` (CLI: `brain dream-now`).
2. **Jobs** screen: the dream run row appears with counts (clusters/merged/contradictions).
3. **Facts** screen: superseded duplicates are hidden by default; the consolidated fact shows;
   toggling "include superseded" (add the toggle to `facts.tsx` in this phase) reveals lineage.
4. **Audit** screen: audit rows for the merges exist.
5. Ask a `think`/`recall` question the consolidated fact answers — one clean fact, not three
   near-duplicates.

**Review:** full `/code-review` + isolation pass (new read/write paths all via `Scoped*`).
**Commit:** `feat(dream): nightly fact consolidation — DreamWorkflow, dream_runs, contradictions → review, dream canary`

---

## Phase 2 — Reflection: cited insights (D2) — ~3–4 days

**Implement**
- Migration `0006`: `documents.origin` (nullable TEXT; `'dream'` for insights).
- `packages/db/src/dream/reflect.ts`: pick targets (entities by recent mention growth +
  namespaces/tags with most new chunks since last run) → run the existing think pipeline with a
  reflection prompt → store insight as a normal ingested document (namespace
  `brain/insights/<target>`, tag `insight`, `origin='dream'`), full citations preserved.
- Anti-loop: candidate SELECTs in `select.ts`/`reflect.ts` exclude `origin='dream'` docs and
  `is_dream_generated` facts (depth ≤ 1); covered by extending the dream canary.
- Optional writeback: mirror insights to the vault `Brain/insights/` via `vault_writeback`.
- Wire as the second step group of `DreamWorkflow`, budget-gated after consolidation.

**Browser E2E**
1. Ingest 3–4 themed docs from the **Add** screen (same topic, one containing an open question).
2. Trigger `dream_now`; **Jobs** shows a reflection run.
3. **Documents** screen filtered to namespace `brain/insights/`: the insight doc exists; open it —
   cited markdown renders, citations link/resolve to the source docs.
4. **Search** screen: a related question surfaces the insight among results; `think` cites it.
5. If vault writeback enabled: Obsidian (or Vault Sync WebDAV listing) shows
   `Brain/insights/<target>.md`.

**Review:** `/code-review` + isolation pass + explicit anti-loop check.
**Commit:** `feat(dream): reflection — cited insight documents over entities/namespaces (+ vault writeback)`

---

## Phase 3 — Digest + Dreams dashboard screen (D3) — ~2–3 days

**Implement**
- `packages/db/src/dream/digest.ts`: final `DreamWorkflow` step — synthesize the run's own
  outputs (new facts, consolidations, pending contradictions, new insights, notable new docs)
  into one capped markdown digest; store via `memory_set` at `agent/digest/daily` (versioned
  for free; flows through `okf_export` and the Obsidian plugin's Pull).
- Dashboard **Dreams** screen (`apps/dashboard/src/routes/dreams.tsx` + nav entry): recent
  `dream_runs` with counts, latest digest rendered, pending contradictions (deep-link into the
  existing review flow), insights list (links to Documents).

**Browser E2E**
1. Trigger `dream_now`; open **Dreams**: run history renders, today's digest renders as
   markdown, the Phase-1 contradiction appears under "pending review".
2. Click the contradiction → lands on the review flow; approve/resolve it; back on Dreams it
   leaves the pending list.
3. **Memory** screen: `agent/digest/daily` exists with version history (yesterday vs today after
   a second run).
4. Insights list links open the right documents.

**Review:** `/code-review` (dashboard + digest). **Commit:** `feat(dream): daily digest at agent/digest/daily + Dreams dashboard screen`

---

## Phase 4 — Cross-session entity dedup sweep (D4) — ~2–3 days

**Implement**
- `packages/db/src/dream/dedup.ts`: tenant-wide sweep reusing `graph/dedup.ts` vector dedup —
  candidate pairs above threshold → `gen()` same-entity confirmation → merge (re-point
  `entity_mentions`/`entity_relations`, soft-delete loser, audit in same batch). Budgeted,
  cursored, idempotent; wired as a `DreamWorkflow` step group (`kind='dedup'`).
- Extend graph canary: dedup never merges across tenants or scopes; merged entity's backlinks
  survive.

**Browser E2E**
1. Ingest two docs referring to the same entity under variant names ("Cloudflare Workers" /
   "CF Workers"); confirm on **Graph** two near-duplicate entities exist.
2. Trigger `dream_now`; **Graph** now shows one merged entity; its detail shows mentions from
   both docs; `traverse_graph` from a neighbor reaches it.
3. **Dreams** run row shows dedup counts; **Audit** shows the merge.

**Review:** `/code-review` + graph-isolation pass. **Commit:** `feat(dream): cross-session entity dedup sweep (deferred PRD Phase-3.5)`

---

## Phase 5 — Memory hygiene: decay & notability (D5) — ~1–2 days

**Implement**
- `packages/db/src/dream/hygiene.ts` (LLM-free SQL): confidence decay for facts unrecalled for
  N days and uncorroborated (step down; below floor → set `valid_until`, report in digest);
  notability boost from `memory_recall_traces` counts.
- Small `fusion.ts` change: notability weighted into the existing boost stage (flagged).
- Digest gains a "expiring/decayed" section.

**Browser E2E**
1. Plant an old, never-recalled draft fact (backdated via seed); run `dream_now`.
2. **Facts**: its confidence dropped / it shows as expiring; **Dreams** digest lists it.
3. Recall a frequently-used fact a few times via Search; after the next run its ranking in
   `recall`/`search` visibly improves (compare positions before/after).

**Review:** `/code-review` (ranking changes get extra scrutiny — no isolation surface).
**Commit:** `feat(dream): memory hygiene — confidence decay + recall-driven notability boost`

---

## Phase 6 — Injection: frozen snapshots + hook kit (W2) — ~1 week

**Implement**
- Activate `brain_snapshots` storage (DDL exists): snapshot = capped (~2–4 KB) markdown of
  instruction-grade memory + top recent facts + `agent/digest/daily` + pinned pages.
  `create_snapshot` gains `kind:'session-context'`; `get_session_context(snapshotId)` returns it
  (drop `snapshotStubbed`).
- Auto-refresh: last `DreamWorkflow` step (plus a cheap 5-min-cron path) refreshes each
  tenant's `session-context` snapshot.
- CLI hook kit: `brain context --snapshot` (prints snapshot markdown), `brain capture`
  (stdin → `capture_turn`), `brain hooks install` (writes Claude Code SessionStart + Stop hooks
  into `.claude/settings.json`, using existing auth).
- Snapshot canary: snapshot content respects visibility/scopes; tenant-isolated.

**Browser E2E**
1. **Sessions** detail for a fresh hooked session (start one locally in a hooked repo): the
   captured turns appear; session context shows the injected snapshot content.
2. **Memory**/**Dreams**: snapshot refresh timestamp advances after a dream run.
3. Verify in the local hooked repo that a new Claude Code session opens with the digest +
   instruction memory present without any tool call (paste evidence into the phase notes).

**Review:** `/code-review` + isolation pass (snapshot assembly is a new read path).
**Commit:** `feat(inject): frozen session-context snapshots + brain hooks install (SessionStart/Stop)`

---

## Phase 7 — Quick thoughts + voice memos (W3.3 + W3.2) — ~3–4 days

**Implement**
- `add_thought` op (all surfaces): one string → small document under
  `brain/thoughts/<yyyy-mm>`, tag `thought`, optional immediate fact extraction. Dashboard
  quick-add box (Search or Add screen), CLI `brain think-note`, Obsidian command.
- `transcribe()` chokepoint in `packages/db/src/ai/` (`@cf/openai/whisper`, same budget/degrade
  contract); `POST /documents` + dashboard **Add** accept audio → transcript enters the normal
  doc pipeline with `content_type='voice'`.

**Browser E2E**
1. **Add/Search**: type a one-line thought into quick-add → it appears under Documents
   (`brain/thoughts/…`) and is findable via Search within a minute.
2. **Add**: upload a short voice memo (m4a/mp3 fixture) → document appears with the transcript
   body; `think` over its content returns a cited answer.
3. Console/network clean during upload (multipart path).

**Review:** `/code-review`. **Commit:** `feat(ingest): add_thought quick capture + voice memos via whisper transcribe()`

---

## Phase 8 — Notion integration (W3.1) — ~1 week

**Implement** per `docs/notion-integration-plan.md` (already reviewed design): Notion OAuth
(Brain holds the token; `notion_connections` table), block→markdown conversion, cron poll +
webhook ingress, reusing the vault/backfill ingest spine; connection management ops + a
dashboard **Notion** section beside Vault Sync.

**Browser E2E**
1. Dashboard → Admin → Notion: click **Connect** → complete the real Notion OAuth consent in
   the browser → connection shows as active.
2. Edit a page in the connected Notion workspace; after poll/webhook, it appears in
   **Documents** with correct markdown; Search finds it; the entity graph gains its entities.
3. Revoke the connection → syncing stops (edit again, verify nothing new ingests).

**Review:** `/code-review` + isolation pass (new ingress + stored third-party tokens).
**Commit:** `feat(notion): OAuth connect + poll/webhook sync through the ingest spine`

---

## Phase 9 — Retrieval & graph polish (W4) — ~1 week

**Implement**
- Query expansion (flag; default on for `think`, off for `search`).
- Vectorize metadata push-down for namespace/tag filters (metadata indexes exist).
- Synthesis map/refine for over-budget evidence sets (replaces truncate-to-fit).
- Mutating graph ops: `add_link`, `add_tag`, `add_timeline_entry`, `get_versions`,
  `revert_version` + minimal dashboard affordances (add tag/link from Graph/Document detail).
- Oversized-doc `ChunkPart` materialization (`ingest.ts:86` TODO).

**Browser E2E**
1. **Search** with a namespace filter over a large corpus: results stay full-depth (compare a
   filtered query's result count/quality before vs after push-down).
2. A deliberately broad `think` (many-doc topic): answer synthesizes across evidence instead of
   truncating (gaps list shrinks vs before).
3. **Graph**: add a tag and a link from the UI; they persist and appear in backlinks/tags ops.

**Review:** `/code-review` (retrieval-quality diffs eyeballed against saved before/after runs).
**Commit:** `feat(search,graph): query expansion, metadata push-down, map/refine synthesis, graph write ops`

---

## Phase gate summary

| Phase | Ships | Canary added | Browser E2E focus | Commit prefix |
|---|---|---|---|---|
| 0 | hygiene | — | full-nav smoke + Clerk Google sign-in | `chore:` |
| 1 | D1 consolidation | dream canary | Facts/Jobs/Audit + recall dedupe | `feat(dream):` |
| 2 | D2 insights | anti-loop ext | insight doc + search finds it | `feat(dream):` |
| 3 | D3 digest + Dreams UI | — | Dreams screen + review flow | `feat(dream):` |
| 4 | D4 entity dedup | graph ext | Graph merge visible | `feat(dream):` |
| 5 | D5 hygiene | — | decay/boost visible in Facts | `feat(dream):` |
| 6 | W2 snapshots + hooks | snapshot | Sessions + hooked-session inject | `feat(inject):` |
| 7 | thoughts + voice | — | quick-add + audio upload | `feat(ingest):` |
| 8 | Notion | ingress | real OAuth connect + sync | `feat(notion):` |
| 9 | W4 polish | — | filtered search depth + graph edits | `feat(search,graph):` |

Total: ~5–6 weeks sequential; phases 4/5, 7, 8, 9 can interleave after Phase 3 if parallelized.

## Risks specific to this execution flow

- **Browser E2E against the live deploy mutates real tenant data.** Use a dedicated dogfood
  tenant for planted facts/docs (Phase 1/4 seeds); clean up planted artifacts after each phase
  (`forget_fact` / `delete_document`) so dreams don't consolidate test noise into the real brain.
- **Clerk dev instance:** the Google sign-in is on the dev Clerk instance
  (`electric-bonefish-70`); if the session expires mid-run, re-auth is click-through — but any
  Clerk instance change must be reflected in `wrangler.jsonc` vars first.
- **W0.1–0.3 remain deferred:** the browser E2E pass at each phase is currently the *only*
  real-AI verification. Do not skip it, and run the AI-gated slice test (`RUN_AI_GATES=1`)
  whenever a phase touches models or the search pipeline.

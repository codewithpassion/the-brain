# The Brain v2 — implementation plan: closing the loop (ingest → analyze → dream → find)

> Companion to [`docs/gap-analysis.md`](./gap-analysis.md) (2026-07-02). Targets gaps G1–G5.
> Style and invariants follow `IMPLEMENTATION_PLAN.md`; everything below rides the existing
> spine (op-registry, `Scoped*` chokepoints, `embed()/gen()/rerank()`, Workflows/Queues/cron,
> `token_spend`, governance) — no new architectural primitives are introduced.

## Objectives

1. **Dream:** the Brain periodically re-reads its own memory — consolidating facts, generating
   cited insights, surfacing contradictions, producing digests, deduping entities, and decaying
   stale memory. (G1 — the headline.)
2. **Inject:** a curated, capped snapshot of what matters lands in every session automatically
   (pillar ②). (G2)
3. **Trust:** the AI paths are continuously verified against real models; CI exists. (G3 —
   **deferred**, see W0)
4. **Breadth:** more memory types in — Notion, voice, quick thoughts, then Gmail/GitHub. (G4)
5. **Polish:** the deferred retrieval/graph refinements. (G5)

## Sequencing

```
W0 (hygiene)             ──────────────►  small, first
W1 (Dream engine)        ──────────────►  the core deliverable; phased D1→D5
W2 (Injection)           ──┐ parallel after W1-D1 (digest feeds the snapshot)
W3 (Ingest breadth)      ──┤ parallel, independent
W4 (Retrieval polish)    ──┘ parallel, independent
```

Definition of done for v2: **a nightly dream run consolidates facts and writes a cited digest,
and that digest is injected into the next session's context.**

---

## W0 — Hygiene (do first; ~half a day)

- **W0.4 Hygiene sweep.** Fix stale device-flow comments (`apps/cli/src/auth/device.ts`,
  `commands/auth.ts`, README "Deferred" list); burn down `test.todo`/`.skip` markers or convert
  them to tracked issues.

**Acceptance:** README no longer claims device flow is client-only.

### Deferred (decided 2026-07-02): verification safety net

The empty-KG production bug (`88ea341`/`d00d29a`/`bd81877`) showed that every test stubs
Workers AI + Vectorize, so model deprecations and API-shape changes are invisible. Closing that
is **deferred** — recorded here so it isn't forgotten:

- **W0.1 (deferred) GitHub Actions CI.** One pipeline: `bun check` → workerd canary suites,
  required on every push to main. *(There is currently no `.github/` at all.)*
- **W0.2 (deferred) Real-AI gate, scheduled.** A small suite hitting the deployed worker with
  `RUN_AI_GATES=1` semantics: embed probe (assert 1024d), ingest → KG non-empty, `think` →
  cited answer, rerank → index→chunk remap shape. Weekly + before deploys; alert on failure.
- **W0.3 (deferred) Model-deprecation tripwire.** The gate fails loudly on a model deprecation;
  failure records a run row so the dashboard Jobs screen shows red.

Consequence while deferred: `bun check` stays a local convention, and the only guard against
another silent AI-path breakage is manually running the AI-gated slice test (`RUN_AI_GATES=1`)
after model or pipeline changes.

---

## W1 — The Dream engine (G1; the headline; ~2–3 weeks, phased)

### Design principles (extend the HARD invariants)

- **D-i1** Dream output is never trusted above its station: consolidated facts inherit the max
  trust of their inputs but are **capped at `evidence`**; insights/digests are `draft`.
  Promotion to `instruction` stays human-only via `memory_review` (existing invariant 9).
- **D-i2** Anti-loop: every dream-produced row sets `is_dream_generated=1` (facts) or
  `origin='dream'` (documents); fact-extraction and dreaming both **skip dream-generated input**
  (the guard gbrain specified; the column finally gets its writer). Insights may cite dream
  output but never dream *over* it (depth ≤ 1).
- **D-i3** Dreams are budgeted and resumable: every `gen()`/`embed()` call carries
  `surface='dream'` in `token_spend`; a per-run token budget (default: 10% of remaining monthly
  ceiling) stops the run cleanly; a cursor row makes the next run resume where it stopped.
- **D-i4** Dreams go through `Scoped*` like everything else — one tenant's dream never reads
  another tenant's memory; every mutation writes its `memory_audit` row in the same `db.batch`.
- **D-i5** Dreams are non-destructive: consolidation soft-supersedes (originals keep their rows,
  `superseded_by`/`consolidated_into` set); nothing is deleted; every dream action is reversible
  by clearing those pointers.

### D1 — Fact consolidation (the first dream)

**New workflow `DreamWorkflow`** (deterministic id `dream-${tenantId}-${yyyymmdd}`), triggered by
a new nightly cron (`0 3 * * *` — keep the 5-min cron for the existing sweeps) and by a manual op.

Steps (each a `step.do`, counts-only outputs):
1. **Select candidates:** active facts (`valid_until` null/future, not superseded, not consolidated,
   `is_dream_generated=0`), grouped by `(entity_slug, kind)` first, then residual facts clustered
   by embedding similarity (embed fact text, cosine ≥ `COSINE_RELATED` 0.85 — constant exists).
2. **Judge each cluster** with `genExtract`-style typed JSON: `{action: merge|supersede|contradict|keep,
   merged_text?, confidence, rationale}`. Salvage-parse like the KG extractor.
3. **Apply in one `db.batch` per cluster:** `merge` → insert one consolidated fact
   (`is_dream_generated=1`, `source='dream'`, lineage via `consolidated_into` on the inputs);
   `supersede` → set `superseded_by`; `contradict` → insert a `memory_review` row (kind
   `contradiction`, both fact ids in payload) for a human; audit rows in the same batch.
4. **Record the run:** `dream_runs` row (mirror `backfill_runs`: tenant, cursor, counts —
   clusters judged / merged / superseded / contradictions, tokens spent, status).

**Schema:** new `dream_runs` table (or `backfill_runs.kind='dream'` — decide at migration time;
prefer a separate table so the Jobs screen can label it). No changes to `facts` — its dream
columns already exist.

**New ops (registry, all surfaces):** `dream_now` (admin, trigger a run), `list_dream_runs`
(read). `recall` gains an `includeSuperseded?: boolean` (default false — **consolidation
immediately improves recall quality** by hiding superseded duplicates).

**Acceptance:** seed 20 overlapping/contradicting facts across two tenants → nightly run merges
duplicates, flags the planted contradiction into `memory_review`, never crosses tenants (extend
the canary suite with a **dream canary**), respects a tiny token budget by stopping with a
resumable cursor, and a re-run of the same day's id is a no-op.

### D2 — Reflection: cited insights (dreaming over documents + graph)

Second phase of the same `DreamWorkflow` (budget permitting), or its own step group:

1. **Pick reflection targets:** top-N entities by recent mention growth + tags/namespaces with
   the most new chunks since the last run (cheap SQL over `entity_mentions`/`documents`).
2. For each target, run the **existing think pipeline** (hybrid search → rerank → cited
   synthesis) with a reflection prompt: "what is known, what changed recently, what is
   unresolved or contradictory, what connects to what" — reusing `search/pipeline.ts` +
   `synthesis.ts` verbatim keeps citations and budget guards for free.
3. **Store each insight as a document** ingested through the normal spine: namespace
   `brain/insights/<target>`, `origin='dream'` (new nullable column on `documents`), tags
   `['insight']`, body = the cited markdown. It is thereby searchable, graph-linked, and shows
   up in `think` answers — the Brain's own thoughts become memories it can find again.
   KG-extraction runs on it normally; **dreaming skips `origin='dream'` docs** (D-i2).
4. **Vault write-back (optional, cheap):** mirror insights into the reserved write-back-only
   `Brain/` folder via the existing `vault_writeback` — insights appear inside Obsidian with
   zero loop risk (the folder is already never re-ingested).

**Acceptance:** after ingesting a themed doc set, the nightly run produces ≥1 insight doc whose
citations resolve to real chunks; searching a related question surfaces the insight; the insight
doc is never itself a reflection target.

### D3 — Digest (the dream's report; feeds W2 injection)

1. Final step of the run: synthesize a **daily digest** from the run's own outputs (new
   facts learned, consolidations, contradictions awaiting review, new insights, notable new
   documents) — one capped markdown artifact per tenant.
2. Store it at the addressable memory path `agent/digest/daily` via the existing `memory_set`
   (versioned for free; `okf_export` includes it; the Obsidian plugin's "Pull notes" fetches it).
3. **Dashboard "Dreams" screen:** last runs (from `dream_runs`), latest digest rendered,
   contradictions pending review (deep-link to the existing review flow), insights list.

**Acceptance:** `memory_get agent/digest/daily` returns today's digest; the dashboard shows the
run and pending contradictions.

### D4 — Cross-session entity dedup (the deferred "Phase-3.5")

A dream step that sweeps the whole entity set per tenant using the **existing**
`graph/dedup.ts` vector dedup: candidate pairs above threshold → `gen()` confirm same-entity →
merge (re-point `entity_mentions`/`entity_relations`, soft-delete the loser, audit). Budgeted,
cursored, idempotent. Extend the graph canary: dedup never merges across tenants or scopes.

### D5 — Memory hygiene: decay & notability

- Confidence decay: facts unreferenced by recall traces for N days and uncorroborated get
  confidence stepped down; below a floor → `valid_until` set (soft-expire), reported in digest.
- Notability re-score: facts repeatedly recalled (recall-trace counts) get boosted notability —
  which the existing trust/title boost stage can weight in fusion (small change in `fusion.ts`).
- Both run as the cheapest dream steps (pure SQL + counts; no LLM).

**Effort estimates (W1):** D1 ~4–5 d · D2 ~3–4 d · D3 ~2–3 d (incl. dashboard) · D4 ~2–3 d ·
D5 ~1–2 d, plus dream canary suite ~2 d.

---

## W2 — Injection: frozen snapshots + hooks (G2; ~1 week; after D3)

- **W2.1 Real `brain_snapshots`.** Implement the deferred storage (DDL exists): a snapshot =
  curated capped context — instruction-grade memory + top recent facts + `agent/digest/daily` +
  pinned pages — rendered to markdown, size-capped (~2–4 KB, the video's "capped frozen
  snapshot" lesson). `create_snapshot` gains a `kind:'session-context'`;
  `get_session_context(snapshotId)` stops returning `snapshotStubbed`.
- **W2.2 Auto-refresh:** the dream run's last step (or the 5-min cron, cheap-path) refreshes the
  tenant's `session-context` snapshot so it is always current at session start.
- **W2.3 Claude Code hook kit.** `brain hooks install` (CLI): writes a SessionStart hook
  (`brain context --snapshot` → stdout → injected) and a Stop hook (`brain capture` → 
  `capture_turn`), using the existing device-flow/token auth. Document the same for the MCP
  path (`get_session_context` at session start — the MCP instructions already tell agents to).
- **W2.4 README/docs:** replace the "frozen-snapshot deferred" notes.

**Acceptance:** a fresh Claude Code session in a hooked repo starts with the digest + instructions
in context without any tool call; a turn captured via Stop hook shows up in `list_sessions`.

---

## W3 — Ingest breadth (G4; independent; prioritized)

1. **W3.1 Notion (~1 week).** Execute `docs/notion-integration-plan.md` as written (OAuth,
   block→markdown, cron poll + webhook, reuse the vault/backfill ingest spine). The plan is
   already reviewed; zero code exists.
2. **W3.2 Voice memos (~2–3 d).** `POST /documents` (and dashboard Add) accepts audio →
   `@cf/openai/whisper` behind a new `transcribe()` chokepoint in `packages/db/src/ai/` (same
   degrade/budget rules) → transcript enters the normal doc pipeline, `content_type='voice'`.
   This is the literal "ingest thoughts" capability.
3. **W3.3 Quick thought capture (~1 d).** `add_thought` convenience op: one string → a small
   document (namespace `brain/thoughts/<yyyy-mm>`, tagged `thought`) + optional immediate fact
   extraction. Surfaces: MCP + CLI (`brain think-note "..."`) + dashboard quick-add + Obsidian
   command. (Today the closest path is `ingest_document`, which is clunky for one sentence.)
4. **W3.4 Gmail + GitHub importers (~1 week, later).** The PRD §4.7 contract and the importer
   SDK already define the shape; build as `packages/ingest/sources/{gmail,github}.ts` + backfill
   sources. Do last — Notion/voice/thoughts serve the goal more directly.

---

## W4 — Retrieval & graph polish (G5; independent; ~1 week total)

- **W4.1 Query expansion** (flagged, default on for `think`, off for `search`) — the deferral in
  `search/ops.ts:10`.
- **W4.2 Metadata push-down:** namespace/tag filters into Vectorize metadata (indexes already
  provisioned per PRD §10.4) so filtered queries stop shrinking the candidate pool post-hoc
  (`search/pipeline.ts:31`).
- **W4.3 Synthesis map/refine** for over-budget evidence sets (replace truncate-to-fit,
  `search/synthesis.ts:7`).
- **W4.4 Mutating graph surface:** `add_link`, `add_tag`, `add_timeline_entry`, `get_versions`,
  `revert_version` (`graph/ops.ts:10`) — lets humans and dreams curate the graph.
- **W4.5 Oversized-doc parts:** materialize `ChunkPart`s as their own document rows
  (`ingest.ts:86` TODO).

---

## New/changed surface summary

| Kind | Item |
|---|---|
| Tables | `dream_runs`; `documents.origin` (nullable); `brain_snapshots` (activate existing DDL) |
| Workflows | `DreamWorkflow` (D1–D5 steps) |
| Cron | nightly `0 3 * * *` (dream) |
| Ops | `dream_now`, `list_dream_runs`, `add_thought`; `recall.includeSuperseded`; `create_snapshot(kind)`; later: notion connect ops, transcribe path |
| Chokepoints | `transcribe()` (W3.2) — same budget/degrade contract as `embed/gen/rerank` |
| Dashboard | Dreams screen (runs, digest, contradictions, insights); quick-add thought |
| CLI | `brain hooks install`, `brain context --snapshot`, `brain capture`, `brain think-note` |
| Canaries | dream canary (cross-tenant + anti-loop + budget-stop), dedup canary, snapshot canary |

## Risks

- **Dream quality:** LLM merges can be wrong. Mitigations: non-destructive supersede (D-i5),
  contradiction → human review instead of auto-resolve, confidence floor for auto-merge
  (below it → review), digest transparency (every action listed and reversible).
- **Cost creep:** nightly LLM passes over growing memory. Mitigations: D-i3 budget slice +
  cursor; cluster-first (only clusters ≥2 reach the LLM); D5 hygiene is LLM-free.
- **Loop amplification:** insights re-feeding dreams. Mitigation: D-i2 depth-1 rule, enforced in
  the candidate SELECTs and covered by the dream canary.
- **D1 single-writer pressure:** dream writes batched per cluster, run at 03:00, `db.batch`
  only — same discipline as ingestion.

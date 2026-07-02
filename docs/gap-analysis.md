# The Brain — gap analysis: PRD & origin docs vs implementation (2026-07-02)

> Sources compared: `PRD.md` (v1, 4,508 lines), `IMPLEMENTATION_PLAN.md`, `docs/origin-video-transcript.md`,
> `docs/mined-projects.md`, the five `docs/*-plan.md` follow-up plans, and the codebase at `30cb617`.
> The measuring stick is the project goal: **a brain that can (1) ingest different types of
> memories/thoughts, (2) analyze them, (3) "dream" over them, and (4) find them again.**

## Verdict (TL;DR)

**The platform is built; the cognition is not.** v1 as specified by the PRD is essentially
complete and deployed — ingestion, hybrid search, cited synthesis, the graph, sessions/facts,
governance, and all four surfaces are real, and the isolation model is proven by workerd canaries.
Several post-PRD plans (OKF memory, Obsidian/vault sync, dashboard memory UI) also shipped.

What is missing is the part of the goal the PRD never specified: **the Brain never thinks about
what it remembers**. There is no dreaming/consolidation/reflection of any kind — the schema
scaffolding for it exists (`is_dream_generated`, `consolidated_at/into`, `superseded_by`) but
**zero code reads or writes those columns**. Every analysis the system performs happens at
ingest time (chunk/embed/KG-extract) or at session close (fact promotion). Nothing ever
revisits, merges, contradicts, decays, or synthesizes memories after they land.

Second-order finding: **green tests do not mean the AI paths work.** All tests — including the
workerd canaries — stub Workers AI and Vectorize. The recent `genExtract` bug window (deprecated
model + unsupported `response_format` + 256-token default → **empty entity graphs in production**,
commits `88ea341`/`d00d29a`/`bd81877`) is exactly the class of failure the current test tier
cannot catch. There is also no CI at all (no `.github/`).

## 1. What we set out to build

- **PRD §1.1 thesis:** fuse gbrain-cf (cited synthesis, hot facts), openbrains (structural
  isolation, governance), cf-graph (durable ingestion) on a pure Cloudflare stack.
- **The four pillars (origin video / PRD §1):** ① citations, ② injection ("the right memory
  shows up at the right time"), ③ semantic search, ④ scoped team access.
- **The goal statement (this analysis):** ingest → analyze → dream → find.

## 2. What has been achieved (with evidence)

### Fully delivered

| Area | State | Evidence |
|---|---|---|
| **Isolation platform** | Complete, canary-proven | `packages/db/src/scoped/*` chokepoints; `apps/api/test/*.canary.test.ts` in real workerd; boundary-lint |
| **Ingestion spine** | Complete | `BatchIngestWorkflow`, `POST /ingest`, `/documents` upload with `toMarkdown` (HTML/PDF/DOCX/images), dedup, R2 bodies |
| **Hybrid search + cited `think`** | Complete (pillars ① ③) | `packages/db/src/search/*`: FTS ∥ vector → RRF → trust/title boost → rerank → budget-guarded cited synthesis; recall traces |
| **Knowledge graph** | Complete (read side) | `EntityExtractionWorkflow`, BFS `traverse_graph`, `search_entities`, inline vector dedup |
| **Sessions + hot facts** | Complete | `capture_turn`/`finalize_session`/`recall`/`forget_fact`; `SessionPromoteWorkflow` + idle-promotion cron |
| **Governance** | Complete (pillar ④) | trust grades, human-only promotion (`memory_review`), break-glass, append-only audit + R2 export cron |
| **Addressable agent memory (OKF)** | Complete (post-PRD plan) | `memory_set/get/list/history/rollback/forget`, `okf_export/import`; `docs/okf-memory-plan.md` §13 confirms |
| **Obsidian / vault sync** | Complete (post-PRD plans) | WebDAV facade `/dav` + vault-events queue (near-real-time ingest) + mobile plugin (`apps/obsidian-plugin`) |
| **Four surfaces from one registry** | Complete | 56-op registry (`packages/surface`); MCP (~46 tools, capability-filtered) + tRPC/REST + CLI + dashboard, drift-guarded |
| **Dashboard** | All screens real | Search/Think, Documents, Memory, Facts, Sessions, Graph, Audit, Jobs, Stats, Members, API keys, Vault Sync — `ComingSoon` component exists but is unused |
| **Deployment** | Live | real D1/Vectorize/R2/KV/DO/queue ids in `wrangler.jsonc`; `brain-api.dominik-fretz.workers.dev`; the MCP server is connected and serving this very session |
| **Backfill + re-embed migration** | Complete | Enumerator workflow, backfill/reembed queues + DLQs, cron sweeps |
| **Cost cap** | Complete (app level) | `token_spend` 429 pre-check; AI Gateway attribution |

Notable: the CLI **device flow is actually end-to-end** (server endpoints + dashboard
`/cli/activate` exist) — the README and CLI comments claiming "server pending, use `--token`"
are stale.

### The goal's four verbs, scored

| Verb | Score | Notes |
|---|---|---|
| **Ingest** | 8/10 | Markdown, uploads (PDF/DOCX/HTML/images), ChatGPT + Claude-Code exports, Obsidian vault, live session turns. Missing: Notion (plan only), Gmail/GitHub (PRD §4.7 promised), voice/audio. |
| **Analyze** | 6/10 | Ingest-time only: chunk/embed, KG extraction, session→fact promotion. No post-hoc analysis, no cross-document reasoning, no contradiction detection. |
| **Dream** | 0/10 | Does not exist. Schema stubs only; no consolidation, reflection, insights, digests, decay, or cross-session entity dedup. |
| **Find** | 8/10 | Hybrid + rerank + cited synthesis is strong. Deferred: query expansion, metadata push-down (path/tag filters shrink the candidate pool post-hoc), map/refine synthesis (currently truncate-to-fit). |

## 3. Gap register (honest, ranked)

### G1 — No dreaming / consolidation layer (critical vs the goal; not in the PRD)
The single biggest gap between the goal and the system. Specifically absent:

- **Fact consolidation:** duplicate/overlapping/contradicting facts accumulate forever; the
  `superseded_by`/`consolidated_into`/`is_dream_generated` columns are written by nothing.
  gbrain (upstream) had a dream job; gbrain-cf and the PRD ported only the anti-loop guard.
- **Reflection / insight generation:** nothing synthesizes across documents/sessions ("these
  five meetings all circle the same unresolved decision") — no insight artifacts exist.
- **Digest:** no daily/weekly rollup of what the Brain learned; nothing to inject or read.
- **Contradiction surfacing:** `think` may retrieve contradicting evidence but nothing detects
  or queues contradictions for human review.
- **Memory hygiene:** no confidence decay, no notability re-scoring, no expiry of stale drafts.
- **Cross-session entity dedup:** explicitly deferred as "Phase-3.5" and still absent (dedup is
  inline at extraction time only), so the graph accretes near-duplicate entities.

### G2 — Injection (pillar ②) is the weakest pillar (PRD-deferred, still open)
Frozen-snapshot injection was deferred out of v1 and remains so: `brain_snapshots` DDL exists,
`get_session_context` carries `snapshotStubbed`, and there is no curated, capped, session-start
context artifact. There is also no packaged Claude Code hook story (SessionStart inject /
Stop-hook capture) — the exact pattern the origin video calls the Hermes lesson. The pieces
(`get_session_context`, `capture_turn`, MCP instructions) exist; the loop is not closed.

### G3 — AI paths are unverified by tests, and there is no CI (operational risk)
Every test fakes Workers AI + Vectorize. `RUN_AI_GATES=1` exists on the slice test but nothing
runs it. No `.github/` — `bun check` is a local convention. The empty-KG production bug proved
the exposure; a model deprecation tomorrow would again be invisible until a human notices.
The README milestone "measure real numbers against real primitives" is still pending.

### G4 — Ingest breadth below PRD promise (medium)
PRD §4.7 names gmail/ob1/github adapters; built are ChatGPT, Claude-Code, Obsidian (+ generic
markdown/upload). Notion has a full plan doc (`docs/notion-integration-plan.md`), zero code.
No audio/voice ("thoughts" as voice memos would need `whisper`), though images/PDFs work via
`toMarkdown` at upload.

### G5 — Deferred retrieval/graph refinements (low-medium, tracked in code comments)
- Query expansion OFF (`search/ops.ts:10`).
- Path/tag filter not pushed into Vectorize metadata → shrunken candidate pools (`search/pipeline.ts:31`).
- Synthesis is truncate-to-fit; map/refine deferred (`search/synthesis.ts:7`).
- Mutating graph surface (`add_link`, `add_tag`, timeline writes, version revert) deferred (`graph/ops.ts:10`).
- Oversized-doc multi-part materialization `TODO(P-later)` (`db/src/ingest.ts:86`).

### G6 — Hygiene (low)
Stale device-flow comments in `apps/cli` + README; a few `test.todo`/`.skip` markers;
stats screen can't show D1/Vectorize headroom (no op exposes it); AI Gateway spend enforcement
attribution-only (accepted v1 decision); shard fan-out deferred by design (fine at 1–2 tenants).

## 4. Honest diagnosis

1. **We built the librarian, not the thinker.** The Brain files everything perfectly, retrieves
   with citations, and isolates tenants rigorously — but it is entirely *reactive*. Every byte of
   intelligence is spent at write time or query time; between those moments the memory is inert.
   The goal's "dream over them" is a 0% area, and it is also the highest-leverage one: dreaming
   is what turns an archive into a brain (consolidated facts, discovered connections, surfaced
   contradictions, digestible summaries).
2. **The PRD was faithfully executed — the gap is above the PRD.** This is not implementation
   drift; the implementation *exceeds* the PRD (OKF, vault sync, device flow). The PRD simply
   scoped v1 to storage + retrieval and carried dreaming only as an anti-loop column. Closing the
   goal requires new design, not remediation.
3. **Trust in the AI paths is currently faith-based.** Isolation is superbly tested; the AI
   pipeline (embeddings quality, KG extraction, rerank shape, synthesis) has no automated
   verification against real models, and it has already silently broken once in production.
4. **Pillar ② (injection) is the pillar the origin video ranked "saves you the most time" and
   the one we deferred.** Everything needed to close it already exists server-side.

The detailed plan to close G1–G5 is in [`docs/v2-implementation-plan.md`](./v2-implementation-plan.md).

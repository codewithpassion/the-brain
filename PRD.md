# Brain Platform — Product Requirements Document

> A Cloudflare-native, multi-tenant "company brain": a governed memory layer that every agent, client, and human in an organization reads from and writes to, built entirely on Cloudflare primitives (Workers, D1, R2, Vectorize V2, Workers AI, AI Gateway, Workflows, Queues, KV, Durable Objects) with no Convex. It fuses the epistemic/search depth of gbrain-cf, the structural multi-tenant isolation and governance of openbrains, and the durable CF-native ingestion of cf-graph onto one pure-Cloudflare stack.

## Table of contents

1. [Vision, Goals, Personas & Scope](#1-vision-goals-personas--scope)
2. [Layered Services Architecture](#2-layered-services-architecture)
3. [Data Model & Storage](#3-data-model--storage)
4. [Ingestion & Document Loading](#4-ingestion--document-loading)
5. [Embedding, Hybrid Search, Rerank & Cited Synthesis](#5-embedding-hybrid-search-rerank--cited-synthesis)
6. [Graph Extraction & Traversal](#6-graph-extraction--traversal)
7. [Multi-Tenant Company Brain: Auth, Scoping, Trust & Audit](#7-multi-tenant-company-brain-auth-scoping-trust--audit)
8. [Session Capture, Hot Memory & Backfill](#8-session-capture-hot-memory--backfill)
9. [API, MCP Server, CLI & Frontend](#9-api-mcp-server-cli--frontend)
10. [Deployment, Observability, Testing & Rollout](#10-deployment-observability-testing--rollout)
- [Appendix: Open Questions & Residual Issues](#appendix-open-questions--residual-issues)

> **Section-numbering & cross-reference convention.** Sections are numbered to match the master plan's scheme. Inline `§N` citations throughout (e.g. "plan §4.1", "§5e", "§5g", "§5i", "§5f", "§0") refer to that **master-plan numbering, not to this document's headings** — they are preserved verbatim from the source sections. Two referenced plan sections are not reproduced as standalone sections here: **§0** (scale ceilings — roughly 6 GB per shard D1, and per Vectorize index a hard **10 M vectors** shared across all tenant namespaces — the binding ceiling, with a 7 M headroom alert and 50k namespaces/index as the secondary cap). **§3 is now included as a full consolidated data-model section.** The data model is also reproduced where each section owns it inline — documents/chunks in §4 (the **authoritative** `documents`/`chunks` DDL; §5 reproduces only a read-subset), the search-relevant schema in §5, the graph tables in §6, the tenancy/governance tables in §7, and the sessions/facts/backfill tables in §8. Likewise the isolation primitives `ScopedDB` / `ScopedVectorize` / `ScopedR2` referenced as "§5" are specified in §7 (the auth/scoping spine) and consumed everywhere else.

---

## 1. Vision, Goals, Personas & Scope

> Altitude note for the reader: this is the framing section. It owns the *why*, the *who*, and the *boundary of v1*. It deliberately does **not** reproduce the data model (§3), the isolation internals (§5), the search/think pipeline (§4.3), or the backfill spine (§6) — those are referenced and cited here, defined in full by their owning sections. The one schema-shaped artifact that genuinely belongs here is the `Principal` contract, because it is where tenancy and personas meet.

---

### 1.1 Vision

**Brain Platform is a single, multi-tenant "company brain": a governed memory layer that every agent, client, and human in an organization reads from and writes to, built entirely on Cloudflare primitives with no Convex.**

Three internal systems already prove the constituent capabilities but none is the whole:

- **cf-graph** (`/home/roboto/devel/cf-graph`) proves durable, CF-native binary ingestion and hybrid search — `IngestionWorkflow` (cf-graph:`apps/graph/src/api/workflows/ingestion.ts`), `toMarkdown` extraction (cf-graph:`apps/graph/src/api/services/cloudflare.ts`), RRF fusion (cf-graph:`apps/graph/src/api/search/rrf.ts`) — but its isolation is **metadata-filter-only** (`filter:{workspaceId}` in cf-graph:`apps/graph/src/api/services/documents.ts`), which leaks the whole index if a filter is forgotten, and it has no team/client model.
- **gbrain-cf** (`/home/roboto/devel/gbrain-cf`) proves the epistemic memory model and the cited-synthesis pipeline — the `think` op with slug citations, gaps, and `no_evidence`/`llm_unavailable` warnings (gbrain-cf:`src/ops/search.ts`), the hybrid engine (gbrain-cf:`src/search.ts`), typed facts (gbrain-cf:`src/ops/facts.ts`), resumable source sync (gbrain-cf:`src/sync.ts`) — but is **single-tenant** by construction: its OAuth props carry no userId/tenant (gbrain-cf:`src/oauth-props.ts`).
- **openbrains** (`/home/roboto/devel/openbrains`) proves structural multi-tenant isolation and governance — auth-first `requireUserId` (openbrains:`packages/convex/convex/_lib/identity.ts`), namespace-by-construction Vectorize (openbrains:`packages/services/src/deps/vectorize.ts`), trust grades + audit + recall traces (openbrains:`packages/convex/convex/schema.ts`), and the platform-neutral importer SDK (openbrains:`packages/ingest/src/sources/`) — but its backend is **Convex**, which we are not carrying forward.

**The unifying thesis:** take gbrain's epistemic/search depth, openbrains' isolation discipline, and cf-graph's durable ingestion, and re-found them on a pure Cloudflare stack (Workers + D1 + R2 + Vectorize V2 + Workers AI + AI Gateway + Workflows + Queues + KV + Durable Objects). Isolation becomes a structural property (`Scoped*` chokepoints), not a per-query convention; memory becomes governed (trust grades, audit, citations) rather than a flat vector dump; and a company's memory becomes shareable across a team and partitionable across clients — none of which any single source system does today.

The product keeps the **same three-surface shape** as the source systems — a CF Workers backend, a TanStack Start + shadcn dashboard, and an MCP server — so existing clients (Claude Code, Claude Desktop, ChatGPT, the `brain` CLI, the web app) all talk to one brain.

---

### 1.1a v1 deployment target (DECIDED)

**v1 ships to 1-2 tenants — internal dogfood for the owner's new service company.** This is a deliberate, narrow first deployment, not an "unknown scale" placeholder. Two consequences shape the whole document:

- **The multi-tenant ISOLATION model is fully v1.** Every row carries `tenant_id`, every vector is namespaced, every read goes through a `Scoped*` chokepoint (§5). 1-2 tenants does not relax isolation — the dogfood tenant and the company tenant are hard-isolated from day one, and isolation is what the source systems lack.
- **The horizontal SCALE-OUT machinery is DEFERRED to Phase N.** A **single D1 database** serves all v1 tenants (no shard fan-out). The `tenant_shards` columns stay for forward-compat but resolve to one shard. Vector/session counts are unknown but **SMALL**; the Vectorize per-index ceilings (10 M vectors / 50k namespaces) and the D1 6 GB shard trigger are **NON-BINDING at 1-2 tenants** and documented as Phase-N scale-out triggers, not v1 build work (§5e).

**Platform plan (DECIDED):** Cloudflare Workers **Paid** ($5/mo). Workers AI is billed by Neurons (Paid includes ~10,000 Neurons/day, then ~$0.011/1k Neurons). Per-model request-RATE limits are made as explicitly-LABELED conservative assumptions (§5.1/§5f) — unverified-until-staging and NON-BINDING at 1-2 tenants. Auth is **Clerk** (OAuth 2.1 upstream IdP, matching gbrain-cf + openbrains) — confirmed, no provider TBD. The platform cost ceiling is `MONTHLY_COST_CEILING_USD = 400` (configurable via env var, per-tenant-overridable); at 1-2 tenants this is effectively the whole-platform budget (§5f, SC8). The upgrade path — AI Gateway caching/retry/fallback + bring-your-own / OpenAI-compatible models via the AI provider abstraction (`AI_PROVIDER=openai-compatible`, cf-graph:`apps/graph/src/api/services/factory.ts`) — is documented but not built in v1.

---

### 1.2 Goals

**G1 — One brain, many tenants, zero cross-tenant leak by construction.** Every isolatable read and write flows through `ScopedDB`/`ScopedVectorize`/`ScopedR2` (defined in §5), enforced by a banned-import ESLint rule and blocking CI isolation tests (§5i). Generalizes openbrains' `requireUserId`-first invariant (openbrains:`packages/convex/convex/_lib/identity.ts`) and namespace-by-construction client (openbrains:`packages/services/src/deps/vectorize.ts`) from `userId` to `tenantId`.

**G2 — Governed memory, not a flat store.** Every memory carries trust grade (`instruction|evidence|draft`), provenance, and review status; every write emits an audit row in the same `db.batch` as the change; every recall writes a trace. Ports the openbrains governance tables (openbrains:`packages/convex/convex/schema.ts`, `memory/writeback.ts`, `memory/recall.ts`) to D1.

**G3 — Answers are cited and gap-aware.** The `think` op returns `{answer, evidence[], citations[], gaps[], warnings}` and refuses to fabricate — it names what is missing. Ported wholesale from gbrain-cf:`src/ops/search.ts`.

**G4 — High-quality retrieval.** Hybrid search (FTS5 bm25 ∥ Vectorize) fused with RRF, with a net-new `bge-reranker-base` rerank stage and optional LLM query expansion. Skeleton from gbrain-cf:`src/search.ts` + cf-graph:`apps/graph/src/api/search/rrf.ts`,`fts.ts`.

**G5 — Durable, resumable ingestion of any source at scale.** A three-stage spine (Enumerator Workflow → `brain-backfill` Queue → Batch-Ingest Workflow) backfills documents, GitHub repos, Gmail, OB1, and chat-session exports without losing progress on restart. Ingestion backbone from cf-graph:`apps/graph/src/api/workflows/ingestion.ts`; importer SDK from openbrains:`packages/ingest/src/sources/`; cursor/anchor discipline from gbrain-cf:`src/sync.ts`.

**G6 — First-class session storage from multiple sources, users, and teams.** A net-new `sessions`/`session_turns` store with three ingress paths (live MCP `capture_turn`, batch importer, webhook `/ingest`), promotion to typed facts, and embedding for long-term recall. No source system has a first-class session store.

**G7 — Cost is bounded per tenant.** The per-tenant hard cap is enforced by app-level `token_spend` accounting, which **pre-checks the tenant's budget and returns `429` BEFORE issuing the `env.AI.run` call** (the v1 model set is all native `@cf/` Workers AI billed in neurons; as of the 2026-06 AI Gateway spend-limits docs, native `@cf/` neuron-billed calls are covered by neither the Unified Billing nor the BYOK rails the spend-limit feature prices, so app-level `token_spend` is the enforcing cap — see §5f). All model calls are still proxied through AI Gateway with `tenant_id` custom metadata for per-tenant cost attribution/observability, and gateway spend limits become a second enforcement layer for any premium models later routed via Unified Billing (deferred, §5f). Cost (neurons) is one axis; **Workers AI request-RATE limits are a separate axis** bounded at the `embed()`/`gen()`/`rerank()` chokepoints and in the backfill/re-embed pacing (§5.1, §5f).

**G8 — Scale path designed in, not retrofitted (but NOT built in v1).** v1 runs a **single shared D1** + two base Vectorize indexes for **1-2 tenants** (internal dogfood, §1.1a). The horizontal scale-out machinery — D1-per-shard / index-per-shard fan-out — is **deferred to Phase N**: `tenant_shards` columns exist for forward-compat but resolve to one shard in v1, so the future move is a routing change (§5e), not a code rewrite. The Vectorize per-index ceilings (10 M vectors / 50k namespaces) and the D1 6 GB shard trigger are documented Phase-N scale-out **triggers**, explicitly **NON-BINDING at 1-2 tenants** — no sharding logic ships in v1.

**Success is measured by §1.6.**

---

### 1.3 Non-Goals (explicit)

Pulled directly from the authoritative plan; these give the scope teeth and keep us aligned.

| Non-goal | Rationale |
|---|---|
| **No Convex.** | The platform is pure Cloudflare. openbrains' Convex orchestration (`importsAction.ts`, `imports.ts`) is **rewritten** against D1+Queues; only the platform-neutral importer SDK (`packages/ingest`) is lifted. |
| **No AutoRAG / AI Search for the core.** | Its embedding model is fixed at index creation, it manages its own Vectorize index, and it cannot express our trust-grade / two-graph / multi-tenant schema. Not used even for v1. |
| **No cross-session semantic fact dedup in v1.** | Nearest-vector merge across facts (deduplicating semantically equivalent facts from different sessions) is **deferred to Phase 3.5**, gated behind a flag. v1 entity resolution is the deterministic `(tenant_id, kind, canonical_name)` key + alias union only (openbrains:`packages/convex/convex/entities.ts`). The `brain-entities` index (1024d/cosine) is provisioned in v1 alongside `brain-chunks`; Phase 3.5 adds the nearest-vector dedup logic on top of it. |
| **No DO-per-tenant working memory.** | Durable Objects are the **MCP server instance only** (cf-graph `MyMCP` pattern, cf-graph:`apps/graph/src/mcp/server.ts`). Hot facts live in D1 + FTS5 (gbrain-cf:`migrations/0004_facts.sql`). DO-per-tenant is a deferred optimization. |
| **No frozen-snapshot injection in v1.** | Snapshot storage + `get_session_context(snapshot_id)` pinning immutable versions is **deferred**. v1 injection = instruction-grade memory surfaced at session start (see Pillar 2, §1.5). |
| **No cross-model vector co-mingling.** | bge-m3 1024d is locked. Same dimension is **not** interchangeability — openbrains qwen3 vectors and any OB1/OpenAI 1536d vectors are **re-embedded, never copied** (openbrains:`packages/ingest/src/sources/ob1.ts` drops foreign embeddings, emits `embeddingModel:'pending'`). |
| **No horizontal scale-out (D1 sharding) in v1.** | v1 targets **1-2 tenants** (§1.1a) on a **single D1**; the Vectorize ceilings (10 M vectors / 50k namespaces) and the 6 GB D1 shard trigger are **non-binding at this scale** and serve as documented Phase-N scale-out triggers. Shard fan-out (§5e) is **deferred to Phase N**, not v1 — the `tenant_shards` columns ship resolving to one shard for forward-compat only. |
| **No interactive cross-await D1 transactions.** | D1 has none; atomicity is via `db.batch([...])` (every write + its audit row in one batch). This constrains the governance design, not a feature to add. |

---

### 1.4 Personas and the persona → tenancy-dimension mapping

The tenancy model is **org (tenant) → team → user → scope (project/client)**. Each dimension exists because a persona needs it — this mapping is the spine of the design and the justification for each isolation primitive.

#### Persona A — Solo power-user ("one brain for everything I do")
A single engineer/operator who wants every Claude Code session, every doc, and every chat transcript captured into one searchable, cited brain.
- **Tenancy shape:** `org` where the org effectively *is* the user. One `membership` row with `role=owner`; no teams; `scope` optional (the user may still partition by side-project, generalizing openbrains' personal `scope`, openbrains:`packages/convex/convex/schema.ts:9-28`).
- **Primary hooks:** the net-new ChatGPT/Claude-Code session importers (modeled on openbrains:`packages/ingest/src/sources/ob1.ts`) and live `capture_turn`; the `brain` CLI with OAuth device flow (CLI auth tables ported from cf-graph:`apps/graph/src/api/services/cli-tokens.ts`).
- **Why it drives the design:** establishes that *every* row carries `tenant_id` even when there is one user — no single-tenant shortcuts (the gbrain-cf trap, gbrain-cf:`src/oauth-props.ts`).

#### Persona B — Team ("our shared company brain")
A team where memory written by one member must be recallable by teammates, with role-based read/write/read-only.
- **Tenancy shape:** one `org`, multiple `teams`, many `memberships` with `role ∈ owner|admin|member|readonly` (generalizes cf-graph's binary `readOnly` flag, cf-graph:`apps/graph/src/api/db/schema.ts:113`). `team_id` is a filterable metadata dimension *within* the tenant namespace.
- **Why it drives the design — the cleanest design-to-persona link:** team-shared memory is **the reason `namespace = tenantId` was chosen and `namespace = userId` was rejected.** openbrains namespaces by `userId` (openbrains:`packages/services/src/deps/vectorize.ts`), which physically blocks team-wide recall. Brain Platform hard-wires `namespace = tenantId` and pushes `team_id`/`scope`/`visibility` to metadata (`trust_grade` stays in the `memory_use_policy` sidecar, never a Vectorize field — §3.2/§5.2), so a teammate's evidence is recallable while the tenant boundary stays physical.

#### Persona C — Multi-client agency ("one workspace, isolated per client")
An agency serving many clients from one org, where each client's memory must not bleed into another's, yet staff move freely between clients.
- **Tenancy shape (v1 default):** one `org`; each client is a `scope` (project/client sub-partition) under the agency tenant — generalizing openbrains `projects`/`scope` (openbrains:`packages/convex/convex/schema.ts:12`) with `tenant_id`/`team_id` added. `scope` is **soft** (it prevents accidental cross-client bleed in queries; the *hard* boundary is `tenant_id`). By default a principal's `allowedScopes='*'` so staff move freely between clients (the persona's explicit requirement). When a membership carries a restricted `allowedScopes`, the restriction is enforced at the **D1 correctness gate** with the same drop-don't-error rule used for `tenant_id` (`getChunksByIds`/`hydrateChunks` add `AND (allowedScopes='*' OR scope IN (...))` so the vector arm closes there, not in the Vectorize call), and an *explicit* out-of-grant `opts.scope` is rejected `403` (§7.3). Scope is also carried as Vectorize metadata and re-checked against the D1 row (§5c).
- **Why it drives the design:** introduces `scope` as a soft sub-partition distinct from the hard `tenant_id` boundary, and motivates a per-principal `allowedScopes` grant (default `'*'`) that is enforced — not merely filtered — at the D1 gate, plus a dedicated cross-scope isolation test (§10.6 canary #7, SC1).
- **Open ambiguity (see §1.7):** whether a "client" should ever be a *separate org* (hard isolation for compliance) rather than a `scope` (soft, shared-tenant). The v1 default is `scope`; the hard-isolation variant is the D1-per-tenant path in §5e.

#### The contract these personas converge on — `Principal`

Resolved once per request at the edge (`resolvePrincipal()`), threaded everywhere below auth; **never a bare token passes below the edge.** This is the single canonical definition of the `Principal` contract; §2, §7, and §9 refer back here rather than redefining it.

**Two orthogonal axes, never conflated** (the iteration-2 security fix). `allowedScopes` is the **data-partition** axis (which client/project rows the principal may touch); `capabilities` is the **capability** axis (read/write/admin). They come from different sources (an API key's stored `scopes` JSON → `capabilities`; a membership/scope grant → `allowedScopes`) and are consumed by different code (`scopeSatisfied`/`readOnly` reads `capabilities`; `ScopedDB`/`ScopedVectorize` read `allowedScopes`). Earlier drafts merged them into one `scopes` field — that bug (an API key's `["read","write"]` flowing into the data-partition predicate as if `read`/`write` were client slugs) is removed here. §7 and §9 reference this one shape rather than redefining it.

```ts
// packages/shared — the single identity/scope contract
export interface Principal {
  tenantId: string;            // org id — the HARD isolation boundary (Persona A/B/C)
  userId: string;              // authorship (Persona A)
  teamIds: string[];           // teams the user belongs to (Persona B)
  role: 'owner' | 'admin' | 'member' | 'readonly'; // generalizes cf-graph readOnly flag
  allowedScopes: string[] | '*'; // DATA partition: client/project sub-partitions the principal
                                 // may read/write (Persona C). '*' = all scopes in the tenant
                                 // (the default — honors "staff move freely between clients").
  capabilities: ('read' | 'write' | 'admin')[]; // CAPABILITY axis (NOT a data partition)
  readOnly: boolean;           // stamped from role and/or MCP key (cf-graph MyMCP)
}

// Resolution chain (generalizes cf-graph:apps/graph/src/api/middleware/auth.ts cliTokenFallback):
//  1. OAuth/Clerk JWT  → sub=userId → membership lookup → {tenantId, teamIds, role, allowedScopes}
//  2. HMAC machine token (bdev_ prefix, openbrains:apps/mcp/src/auth/device-token.ts) → tenant baked in
//  3. API key (bk_ prefix, SHA-256 hash, openbrains:packages/convex/convex/apiKeys.ts) → tenant-bound;
//       stored scopes JSON → capabilities (NOT allowedScopes); allowedScopes defaults to '*'
//  MCP transport: /mcp/<slug> rewrite (cf-graph:apps/graph/src/mcp/workspace-scoped-handler.ts)
//    → resolve slug → {tenantId, scope} against memberships → stamp readOnly from role
//  (Canonical credential prefixes are bdev_ for machine tokens and bk_ for API keys, used
//   identically in §2/§7.2/§9 wherever resolvePrincipal branches on the prefix.)
```

A typical request flow (read):
```
client → edge (resolvePrincipal → Principal) → service layer (takes Principal)
       → ScopedDB(principal) / ScopedVectorize(principal)  [the only way to touch tenant data]
       → CF primitives (D1 / Vectorize / R2)
       → D1 re-check drops any cross-tenant id, and any out-of-allowedScopes id, silently
         (no existence leak; openbrains drop-don't-error rule)
```

---

### 1.5 The four memory pillars (scope of the memory model)

Each pillar is stated as concept + the v1 acceptance test + the source it adapts. Mechanics belong to §4/§5.

#### Pillar 1 — Citations (answers grounded in evidence)
Every synthesized answer cites the slugs/sources it drew from and reports the structured gaps it can detect; it never fabricates when evidence is thin. Note the precise scope of "gap-aware": the ported gbrain `think` populates structured `gaps[]` in the **empty-evidence** (`no_evidence`) case, and the platform adds one **net-new** structured gap — `evidence_evicted:<n>` when synthesis drops lower-ranked evidence to fit the model context window (§5.5). The `SYNTH_SYSTEM` prompt *also* instructs the model to state in prose what is missing on partial evidence, but free-prose gap detection on partial-but-present evidence is not a separately asserted/tested guarantee in v1.
- **v1 form:** the `think` op returns `{answer, evidence[], citations[], gaps[], warnings}`, with `warnings:['no_evidence']` when nothing matches and `['llm_unavailable']` when the model is down (graceful degrade to raw evidence). Ported wholesale from gbrain-cf:`src/ops/search.ts` (verified: `SYNTH_SYSTEM` enforces "cite the slug… if insufficient, say so"; `dedupeSlugs` builds citations; empty-evidence path returns the no-evidence warning).
- **Acceptance test:** `think` on a tenant with one matching doc returns ≥1 citation pointing at that doc; `think` on an empty tenant returns `answer:''`, a populated `gaps[]`, and `warnings:['no_evidence']`.

#### Pillar 2 — Injection (the right memory shows up at the right time)
Trusted, governed memory is surfaced into a session proactively — instruction-grade memory at session start, plus on-demand context retrieval.
- **v1 form:** instruction-trust-grade facts/notes surfaced via a `get_session_context` MCP tool / SessionStart resource, drawn from live rows where `trust_grade='instruction'` **and** the access tier permits the requesting principal — both filters applied by the `ScopedDB.readFacts` choke-point (§7.3/§8.5), **not** by per-op prose: the visibility predicate is structural, so one user's `private` instruction-fact is never injected into another user's session (iter-3 intra-tenant RLS fix). Trust promotion to `instruction` requires human-confirmed `memory_review` (openbrains:`packages/convex/convex/schema.ts:73,89`; writeback hard-wires `evidence`, openbrains:`packages/convex/convex/memory/writeback.ts`).
- **Deferred (NOT v1):** frozen-snapshot injection — `brain_snapshots.manifest` pinning immutable version ids, resolved by `get_session_context(snapshot_id)` to a frozen brain view. Storage substrate is gbrain-cf `page_versions` (gbrain-cf:`migrations/0001_init.sql`); explicitly out of v1 scope.
- **Acceptance test (v1):** a fact promoted to `instruction` via review appears in `get_session_context` output; an `evidence`/`draft` fact does not; `snapshot_id` is accepted but documented as deferred.

#### Pillar 3 — Semantic search (meaning-based recall, hybrid + reranked)
Recall by meaning, not just keyword, fused with keyword bm25 and reranked.
- **v1 form:** `embed(query)` (+ optional expansion) → `[FTS5 bm25 ∥ Vectorize namespace=tenant]` → RRF (K=60, normalize-by-max) → title/trust boosts → `bge-reranker-base` rerank (degradable) → top-k. Engine from gbrain-cf:`src/search.ts`; FTS sanitizer from cf-graph:`apps/graph/src/api/search/fts.ts`; embedding chokepoint contract (`embed()` returns null, never throws) from gbrain-cf:`src/ai.ts`; thresholds (0.5 / 0.85) from openbrains:`packages/shared/src/tools/`.
- **Acceptance test:** a paraphrased query (no shared keywords with the stored doc) retrieves that doc via the vector arm; the rerank stage failing (binding error) degrades to RRF order rather than throwing.

#### Pillar 4 — Scoping (memory is partitioned and isolated)
Memory is partitioned by tenant (hard), team, and scope/client (soft), with strict per-tenant isolation enforced structurally.
- **v1 form:** `tenant_id NOT NULL` on every isolatable row; `namespace = tenantId` on every vector; `team_id`/`scope` as filterable metadata + `ScopedDB` predicates; R2 keys tenant-prefixed; D1 row is the correctness gate after every vector/FTS hit (drop cross-tenant ids — and out-of-`allowedScopes` ids — silently). Isolation primitives defined in §5; pattern lifted from openbrains:`packages/services/src/deps/vectorize.ts` (namespace-by-construction) + openbrains:`packages/convex/convex/memory/recall.ts` (drop-don't-error rule).
- **What the isolation guarantee actually rests on (precise framing).** A Vectorize namespace is a query-time partition parameter that *scopes the search space* — it is the same **class** of mechanism as a metadata filter and Cloudflare does not document it as a security/isolation boundary. The hard guarantee therefore rests on two things the platform owns, not on the namespace itself: (a) the un-omittable `ScopedVectorize` wiring that stamps `namespace = tenantId` on every upsert/query (a forgotten namespace is impossible because callers never construct the raw query), and (b) the mandatory D1 row re-check that drops any id whose live `tenant_id` does not match. The choice of `namespace = tenantId` over `namespace = userId` is justified on **team-recall** grounds (userId-namespacing physically blocks a teammate from recalling shared evidence), not on a hard-vs-soft security distinction.
- **Acceptance test (blocking in CI):** tenant A cannot retrieve tenant B's chunk via the vector arm OR the FTS arm; a BFS traversal cannot hop across tenants; a restricted-`allowedScopes` principal cannot read another client's scope (by naming it explicitly OR via an unscoped query) on the FTS arm, the vector arm, or `ScopedDB.listDocuments`; **a user cannot recall/search/`think` another user's `private` fact OR another user's `private` session chunk within the same tenant, and the `team` tier is enforced on both** (intra-tenant visibility on the facts AND hybrid arms, §7.5); **a restricted principal still recalls its OWN granted-scope content even when it ranks below the tenant-wide Vectorize top-K** (recall-completeness under topK pressure, §5.3); a raw unscoped `env.DB` query outside `packages/db` fails lint.

---

### 1.6 Success criteria (measurable)

| # | Criterion | Verification |
|---|---|---|
| SC1 | **Zero cross-tenant leak AND enforced cross-scope isolation AND enforced intra-tenant visibility (private/team/world).** | Blocking CI isolation suite green: vector-arm, FTS-arm, BFS-hop, and Vectorize-recheck **cross-tenant** tests all return empty for the foreign tenant; the **cross-scope** test (§10.6 canary #7) shows a restricted-`allowedScopes` principal cannot read another client's scope via the vector arm, the FTS arm, or `ScopedDB.listDocuments` (explicit out-of-grant `scope` → 403; unscoped query → only granted scopes returned); the **intra-tenant visibility** tests (canaries #8/#9) show a non-author, non-teammate user cannot recall/search/`think`/`get_session_context` another user's `private` fact and that the `team` tier is enforced (teammate yes, non-teammate no); the **recall-completeness** test (canary #10) shows a restricted principal still recalls its own granted-scope content under Vectorize topK pressure; the **write-isolation** test (canary #11) blocks out-of-grant body partition fields; banned-import lint passes (§5i). |
| SC2 | **Body-offload discipline holds (bodies/transcripts in R2).** | After ingest, full document markdown and full session transcripts live in R2 (`body_r2_key`); D1 holds only `markdown_preview` + index rows. **The D1 byte budget is dominated not by bodies but by `chunks.content` + the external-content FTS5 index built on it + `memory_audit`/`memory_recall_traces` growth** — those terms, not the offloaded bodies, drive the 6 GB shard trigger (§10.7), and a recall-trace/audit retention-or-rollup policy (§7 Open Questions) bounds them. Spot-checked per ingest path; enforced as a Phase-1 verify gate. |
| SC3 | **Cited, gap-aware answers.** | `think` returns ≥1 citation when evidence exists and `warnings:['no_evidence']` + populated `gaps[]` when it does not; when synthesis evicts lower-ranked evidence to fit the context window it emits `warnings:['evidence_evicted:<n>']` + a matching gap line (Pillar 1 test). |
| SC4 | **Retrieval recovers paraphrase.** | Paraphrase-query test retrieves the target doc via the vector arm; rerank failure degrades gracefully (Pillar 3 test). |
| SC5 | **Durable ingestion is resumable & idempotent.** | Kill an enumerator mid-run → resumes from saved cursor; duplicate Queue delivery → no double-ingest (deterministic instance id `ingest-${tenantId}-${fingerprint}`); re-upload unchanged content → `skipped`. |
| SC6 | **Sessions captured → promoted → recallable.** | Capture a session via all three ingress paths → finalize → typed facts written as `trust_grade='evidence'` with `source_session_id`; transcript body in R2, not D1; a missed Stop-hook is recovered by the idle-promotion cron, which keys on `sessions.last_activity_at` (refreshed on every `capture_turn`), **not** `ended_at` — so a session whose Stop-hook never fired (`ended_at` NULL) is still swept once idle (§8.3, iter-3 SC6 fix). Re-finalizing an edited session cleanly replaces its prior promoted facts (no duplicate append, §8.3). |
| SC7 | **Governance is enforced & auditable.** | Agent writeback cannot set `instruction` (hard-wired `evidence`); promotion requires `memory_review`; every write has a matching `memory_audit` row in the same batch; every kept recall hit writes a `memory_recall_trace`. **Durable tamper-evidence:** `memory_audit` is append-only in app code (enforced by the banned-import lint) and is periodically exported append-only to R2 so "auditable" has a backstop beyond app discipline (§7.6). |
| SC8 | **Spend is bounded per tenant.** | App-level `token_spend` accounting pre-checks the tenant budget against `MONTHLY_COST_CEILING_USD` (default `400`, configurable via env var and per-tenant-overridable; at 1-2 tenants this is effectively the whole-platform budget) and returns `429` (with `Retry-After`) **before** the `env.AI.run` call — this is the enforcing cap for the all-`@cf/` v1 model set on Workers **Paid**, which AI Gateway spend limits do not cover (they price only Unified Billing / BYOK rails). AI Gateway spend limits remain wired (for cost attribution now, and for enforcement once premium Unified-Billing models are routed, §5f); when both apply they agree within the gateway's eventual-consistency overshoot window. **Separately, Workers AI request-RATE limit responses degrade-or-queue rather than 429-ing the user** (§5.1). |
| SC9 | **Scale headroom is observable on BOTH axes (bytes AND write-throughput) — as a Phase-N trigger, not a v1 constraint.** | Dashboard shows D1 size, **per-shard D1 write-QPS**, and per-index vector count against the §0 Phase-N scale-out triggers (6 GB D1 / **10 M vectors per index** — shared across all tenant namespaces — with 50k namespaces/index as the secondary cap). At the **1-2 tenant** v1 target (§1.1a) these triggers are **non-binding** and expected to sit far below threshold; the observability ships for forward-compat so the eventual shard-split decision is data-driven, but no shard fan-out is built in v1. When (Phase N) a trigger is approached, the shard-split alert fires on **EITHER** D1 ≥ 6 GB **OR** sustained write-QPS approaching the single-writer ceiling, plus the **7 M vectors** headroom alert (before the 10 M hard cap). Because D1 is single-writer, recall-trace writes are decoupled from the read path (`ctx.waitUntil`/separate store) so reads don't burn write throughput (§10.7). The eventual swap to a shard is a `tenant_shards` routing change, not a code change. |
| SC10 | **Read-only MCP is honored.** | An MCP key/role with `readOnly=true` cannot invoke any write tool (cf-graph `MyMCP` read-only prop, cf-graph:`apps/graph/src/mcp/server.ts`). |

---

### 1.7 Scope boundary (in / deferred / rejected)

| In v1 | Deferred (later phase) | Rejected |
|---|---|---|
| Multi-tenant isolation (`Scoped*`, §5) | Cross-session semantic fact dedup (Phase 3.5) | Convex (any use) |
| Document ingestion + R2 body-offload | DO-per-tenant working memory | AutoRAG / AI Search for the core |
| Hybrid search + rerank + `think` (§4.3) | Frozen-snapshot injection | `namespace=userId` (blocks team memory) |
| Entity extraction + generalized BFS (deterministic keys only) | Horizontal scale-out: D1/Vectorize shard fan-out — Phase N (single D1 in v1; path designed, §5e) | cf-graph metadata-filter-only isolation |
| Backfill spine (Queues) + importers (§6) | R2 SQL / Pipelines analytics lake | Cross-model vector co-mingling |
| Sessions + governance + trust grades (§6, §5) | Hyperdrive / external Postgres | Single-tenant shortcuts |
| AI Gateway spend caps + `token_spend` (§5f) | Premium-model routing (Claude/OpenAI via gateway) | Interactive cross-await D1 transactions |
| Three surfaces: MCP DO, `brain` CLI, TanStack Start + shadcn dashboard | | |

---

### 1.7b Open questions

(Listed in the consolidated Residual Issues / Open Questions appendix.)

#### Code references

- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/_lib/identity.ts — requireUserId auth-first invariant — the discipline to generalize into resolvePrincipal()/requireTenant; every data access must resolve a Principal first.
- openbrains:/home/roboto/devel/openbrains/packages/services/src/deps/vectorize.ts — Namespace-by-construction Vectorize client (namespace=userId, scope as metadata, D1 row as correctness gate). Adopt as namespace=tenantId — the structural reason team memory works and the rejection of namespace=userId.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/schema.ts — projects/scope sub-partition model (Persona C), trust grades (memory_use_policy instruction|evidence|draft), memory_review/audit/recall_traces governance tables, api_keys scopes.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/writeback.ts — Agent writeback hard-wires trustGrade='evidence' (Pillar 2 / G2 / SC7) — the invariant that promotion to instruction needs human review.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/recall.ts — Drop-don't-error cross-tenant rule (no existence leak) + per-hit recall trace — the Pillar 4 scoping correctness gate (SC1/SC7).
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/ob1.ts — Importer that drops foreign embeddings and emits embeddingModel:'pending' — template for ChatGPT/Claude-Code session importers (Persona A, G6) and the no-cross-model-co-mingling non-goal.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/search.ts — think op: cited synthesis returning {answer, evidence, citations, gaps, warnings} with no_evidence/llm_unavailable graceful degrade — Pillar 1 / G3 / SC3 verbatim.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/search.ts — Hybrid engine (rrfFusion K=60, title/trust boosts, vectorSearch JOIN-to-D1, expandedHybridSearch) — Pillar 3 / G4 skeleton.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ai.ts — Embedding/model chokepoint (bge-m3 1024d, embed() returns null never throws) — the locked embedding model and degradation contract (Pillar 3).
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/oauth-props.ts — Proof of single-tenancy (AuthInfo has no userId/tenant) — the trap Brain Platform must not repeat (motivates Principal/tenant_id-everywhere).
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/db/schema.ts — workspaceId/userId scoping + api_keys(workspaceIds[], readOnly) — generalize readOnly flag to role enum (Persona B) and workspaceId to tenant_id.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/middleware/auth.ts — cliTokenFallback multi-token resolver chain (Clerk → API key → CLI JWT → one identity) — template for resolvePrincipal().
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/server.ts — MyMCP slug→workspace resolution + readOnly prop — template for read-only MCP (SC10) and slug→{tenantId,scope} resolution.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/ingestion.ts — Durable step-resumable ingestion backbone — G5 / SC5 (Batch-Ingest Workflow).
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/documents.ts — Metadata-filter-only Vectorize isolation (filter:{workspaceId}) — the weaker approach Brain Platform rejects in favor of namespace=tenantId.

---

## 2. Layered Services Architecture

The Brain Platform is a single Cloudflare Worker (`apps/api`, Hono) that exposes three request surfaces (REST, MCP, webhook), a service layer of tenant-agnostic domain logic, a mandatory isolation layer that is the *only* path to tenant data, durable orchestration (Workflows + Queues), and the raw CF primitives. The layering exists to push one invariant down to a single chokepoint: **every byte of tenant data is reached through a `Scoped*` object that hard-wires `tenant_id`.** None of the three mined projects has this layer — it is the structural delta that makes the platform multi-tenant.

The FOCUS names six layers (edge/API, MCP, orchestration, services, data, AI). The integrated plan (§2) inserts a seventh — the **isolation layer** — between services and data. This section adopts the six-layer spine and treats isolation as the cross-cutting layer the plan mandates. Layers 5/6 (data model) and the isolation mechanics are authored in §3 and §5 respectively; this section defines *responsibilities, component ownership, and request lifecycles*, and references those sections rather than re-specifying their schemas.

---

### 2.1 Layer overview (ASCII)

```
┌──────────────────────────────────────────────────────────────────────┐
│ L0 CLIENTS  Claude Code / Desktop · ChatGPT · CLI (`brain`) · Web      │
└──────────────────────────────────────────────────────────────────────┘
        │ OAuth2.1+PKCE  │  API key (SHA-256)  │  HMAC machine token
┌──────────────────────────────────────────────────────────────────────┐
│ L1 EDGE / AUTH (Worker entry)                                          │
│   workers-oauth-provider → resolvePrincipal()                         │
│   → Principal { tenantId, userId, teamIds[], role,                   │
│                 allowedScopes:string[]|'*', capabilities[], ro }     │
│   derives: cf-graph cliTokenFallback fan-out + openbrains multi-token  │
└──────────────────────────────────────────────────────────────────────┘
        │ Principal (a bare token NEVER crosses this line)
┌──────────────────────────────────────────────────────────────────────┐
│ L2 API SURFACES (all take Principal)                                  │
│   • Hono REST router (dashboard + CLI)                                │
│   • MCP server (Durable Object, /mcp/<slug>, read-only honored)      │
│   • Webhook POST /ingest    • Importer trigger endpoints              │
└──────────────────────────────────────────────────────────────────────┘
        │
┌──────────────────────────────────────────────────────────────────────┐
│ L3 SERVICE LAYER (tenant-AGNOSTIC logic, tenant-SCOPED inputs)        │
│   ingest · search/think · graph · facts · sessions · governance      │
│   (derive: gbrain ops/*, cf-graph services/*, openbrains services/*)  │
└──────────────────────────────────────────────────────────────────────┘
        │ services receive Scoped* handles, never raw bindings
┌──────────────────────────────────────────────────────────────────────┐
│ L4 ISOLATION LAYER  (the ONLY way to touch tenant data — §5)         │
│   ScopedDB(p)        injects AND tenant_id=? ; shard→single D1 (v1)  │
│   ScopedVectorize(p) hard-wires namespace=tenantId ; one index (v1)  │
│   ScopedR2(p)        prefixes keys with `${tenantId}/`               │
│   + post-query D1 re-check (vector + FTS arms)                        │
└──────────────────────────────────────────────────────────────────────┘
        │
┌──────────────────────────────────────────────────────────────────────┐
│ L5 ORCHESTRATION   Workflows (durable, step-resumable)               │
│   IngestionWorkflow · EnumeratorWorkflow · EntityExtractionWorkflow  │
│   · SessionPromoteWorkflow                                            │
│   Queues  brain-backfill(+DLQ) · brain-reembed(+DLQ)                 │
│   Cron    stale-source re-enqueue · re-embed sweep · idle-promote    │
└──────────────────────────────────────────────────────────────────────┘
        │  internal hops over Service/Workflow bindings (no HTTP secret)
┌──────────────────────────────────────────────────────────────────────┐
│ L6 CF PRIMITIVES + AI                                                 │
│   D1 · Vectorize V2 · R2 · KV(OAUTH_KV) · DO                         │
│   Workers AI  ─ all calls proxied ─▶ AI Gateway (tenant_id metadata; │
│     attribution/observability — NOT the enforcing cap for @cf/ models)│
│   per-tenant spend enforced app-side: token_spend pre-check → 429     │
│     BEFORE env.AI.run (§5f); request-RATE limits bounded at chokepoint│
│   embed bge-m3·gen llama-3.3-70b-fp8-fast·extract llama-3.1-8b·rerank │
└──────────────────────────────────────────────────────────────────────┘
```

**Monorepo (pnpm workspaces):** `apps/api` (Worker + service layer + Workflows + Queue consumers + MCP DO), `apps/dashboard` (TanStack Start + shadcn on Workers), `apps/cli` (`brain`), `packages/ingest` (importer SDK lifted from `openbrains:packages/ingest`, Convex orchestration dropped), `packages/db` (Drizzle schema + migrations + `ScopedDB` — **the only module permitted to import the raw `env.DB` binding**, enforced by ESLint banned-import per §5i), `packages/shared` (Zod tool schemas, model constants).

---

### 2.2 L1 — Edge / Auth

**Responsibility:** terminate transport, authenticate, and resolve a single `Principal` once per request. Below L1, code receives a `Principal`, never a raw token. The `Principal` shape is the canonical contract defined in §1.4 (`packages/shared`); the resolver is:

```ts
async function resolvePrincipal(req, env): Promise<Principal | null> {
  // (1) OAuth2.1 / Clerk JWT — jose jwtVerify(sub→userId), then membership lookup
  // (2) HMAC machine token (bdev_ prefix, openbrains device-token pattern; tenant baked into claims)
  // (3) API key (bk_ prefix) — SHA-256 hash → api_keys row (tenant-bound, read_only, expires_at);
  //     stored scopes JSON → Principal.capabilities, NOT Principal.allowedScopes (which defaults to '*')
}
```

**Derives from:** the fan-out resolver in `cf-graph:apps/graph/src/api/middleware/auth.ts` (`cliTokenFallback` tries Clerk → `wbai_` API key → CLI JWT and normalizes to one `userId`) and `openbrains:apps/mcp/src/index.ts` (OAuthProvider + Clerk + `resolveExternalToken` for HMAC tokens). **Delta:** both resolve to a bare `userId`; here the resolver additionally performs a **membership lookup** (`memberships` table — net-new, no mined project has one) to attach `tenantId`/`teamIds`/`role`. `workers-oauth-provider` is backed by KV (`OAUTH_KV`), per the CF stack.

---

### 2.3 L2 — API surfaces

| Surface | Component | Derives from | Delta |
|---|---|---|---|
| REST | Hono router | `cf-graph` tRPC `protectedProcedure` gate (`api/trpc/trpc.ts`) | gate yields a `Principal`, not a `userId` |
| MCP | Durable Object `MyMCP` | `cf-graph:apps/graph/src/mcp/server.ts` + `workspace-scoped-handler.ts` | `/mcp/<slug>` rewrite resolves slug → `{tenantId, scope}` via `memberships`; `readOnly` stamped from role |
| Webhook | `POST /ingest` | `gbrain:src/routes-platform.ts` (hash body, 256KB cap, audit row, 202) | enqueue to `brain-backfill` Queue instead of a D1 `jobs` row |
| Importer trigger | REST `POST /sources/:id/backfill` | net-new | spawns `EnumeratorWorkflow` |

**MCP routing (verified):** `cf-graph:.../mcp/workspace-scoped-handler.ts` splits `/mcp/<slug>/...`, validates the slug, rewrites the URL to `/mcp`, and injects the slug into `ctx.props`. `cf-graph:.../mcp/server.ts` `MyMCP.init()` reads `props.userId`+`props.workspaceSlug`, resolves the workspace, and conditionally registers mutation tools only when `props.readOnly !== true`. The platform reuses this verbatim but resolves the slug to a **tenant+scope** instead of a workspace, and the `Principal.readOnly` flag gates write-tool registration.

**Resolved DO decision (the one divergence flagged in the plan):** the Durable Object is the **MCP server instance and OAuth coordination only — never the system of record.** Hot facts, sessions, and all tenant data live in D1 + Vectorize + R2. DO-per-tenant working memory is an explicitly deferred optimization, out of scope for the core.

---

### 2.4 L3 — Service layer

Tenant-agnostic domain logic; every entry point takes a `Principal` and `Scoped*` handles. Each maps to a verified source module:

| Service | Public ops | Source module(s) | Delta |
|---|---|---|---|
| **ingest** | upload, ingestChunked, fingerprint-dedup | `cf-graph:.../services/documents.ts` (`uploadDocument`, `ingestChunked`), `gbrain:src/engine.ts` (`putPage` skip-unchanged) | add `tenant_id`; body→R2, preview→D1 |
| **search/think** | search, query, think | `gbrain:src/ops/search.ts`, `gbrain:src/search.ts` (`hybridSearch`, `expandedHybridSearch`, `rrfFusion`) | tenant-filtered both arms; +rerank; +token-budget guard |
| **graph** | traverse, links, backlinks, entities, orphans | `gbrain:src/engine.ts` (BFS), `openbrains:packages/convex/convex/entities.ts` (upsert/relate/clear algorithms) | generalize BFS to edge-table-agnostic; every hop carries `tenant_id` |
| **facts** | extract_facts, recall, forget_fact | `gbrain:src/ops/facts.ts` | +`tenant_id`; trust grade hard-wired `evidence` |
| **sessions** | capture_turn, finalize_session, get_context | net-new (modeled on `gbrain` facts + `cf-graph` ingestion) | first-class session store (§6) |
| **governance** | memory_review, audit, recall_traces | `openbrains:packages/convex/convex/memory/{writeback,recall}.ts` | reimplemented on D1 `db.batch` (no Convex tx) |

The service layer is registered as a flat op array (port of `gbrain:src/ops/index.ts` `operations[]` + `buildToolDefs()`, which turns op params into MCP `inputSchema`). REST, MCP, and Workflow callers all invoke the same op functions.

**Degradation contract (carried verbatim from `gbrain:src/search.ts` / `src/ai.ts`):** every AI/Vectorize-dependent arm tolerates a missing binding and falls back (keyword-only search; RRF-order without rerank; evidence-without-synthesis) and **never throws**. `embed()` returns `null` on failure rather than throwing.

---

### 2.5 L4 — Isolation layer (cross-cutting)

The single most important layer; full mechanics in §5. Three constructors, each taking a `Principal`:

- **`ScopedDB(p)`** — a repository over Drizzle that injects `AND tenant_id = ?` (+ scope filter) into every query, resolves the shard DB binding from `tenant_shards` (**v1 always resolves to a single shared D1 — no shard fan-out is built; sharding is a documented future layer, §5e**), and never exposes a raw table handle. This is the D1 substitute for native RLS. Replaces the per-query `eq(workspaceId)` sprinkling in `cf-graph:.../services/workspaces.ts` (the brittle hand-written-WHERE pattern). **Delta:** `workspace_id` (an app-level partition under one user) → `tenant_id` (the hard boundary).
- **`ScopedVectorize(p)`** — lifts `openbrains:packages/services/src/deps/vectorize.ts` `createVectorizeClient`, which hard-wires `namespace` on every `upsert`/`query` so it is physically impossible to omit. **Delta:** `namespace = userId` → `namespace = tenantId`; `team_id`/`scope`/`visibility`/`embedding_model` move to filterable metadata *within* the namespace (so team-shared recall works; `namespace=userId` would block it). **`trust_grade` is deliberately NOT a Vectorize metadata field** — it is never an index, filter, or upsert field; it lives **only** in the `memory_use_policy` sidecar (§3.2/§5.2), LEFT-JOINed at read with a default of `'evidence'`, so a trust promotion never rewrites a vector.
- **`ScopedR2(p)`** — prefixes every key with `${tenantId}/`.

**Post-query D1 re-check (correctness gate):** Vectorize metadata lags writes, so after every vector query the matched ids are JOINed back to live `ScopedDB` rows and re-checked on `tenant_id`/`scope`/`deleted_at` (and, when the principal's `allowedScopes` is restricted, on `scope ∈ allowedScopes`); cross-tenant ids — and out-of-grant scope ids — are silently dropped (no existence leak). An *explicit* out-of-grant `scope` argument is rejected `403` at the `ScopedDB`/`ScopedVectorize` entry (§7.3). The same JOIN-back gate covers the FTS5 arm — `MATCH` cannot carry `tenant_id`, so the bm25 hit set is re-checked against the tenant-scoped base table before any row leaves the arm. The pattern is proven in `gbrain:src/search.ts` `vectorSearch` (JOIN matches to `content_chunks JOIN pages ... WHERE p.deleted_at IS NULL`) and `openbrains:.../convex/memory/recall.ts` (drop cross-tenant ids).

---

### 2.6 L5 — Orchestration (Workflows + Queues)

| Component | Source | Role |
|---|---|---|
| `IngestionWorkflow` (Batch-Ingest) | `cf-graph:.../workflows/ingestion.ts` (near-verbatim) | extract → chunk → store-chunks-batch(10) → embed-batch(50) → KG-batch(5) → finalize, with per-phase retries/backoff and the D1 100-param batching constant |
| `EntityExtractionWorkflow` | `cf-graph:.../workflows/entity-extraction.ts` | batch-of-5 `step.do` with `retries:{limit:3,backoff:'exponential'}` |
| `EnumeratorWorkflow` | net-new (drives `openbrains` `Importer` contract) | one instance per `(tenantId, sourceId)`; each page is one named `step.do` (resume on restart); **enqueues references, never embeds inline** |
| `SessionPromoteWorkflow` | net-new (template = `cf-graph` ingestion) | fact extraction → atomic writeback → chunk + embed |
| `brain-backfill` Queue (+DLQ) | net-new (Queues — the primitive none of the three had) | per-message `ack()`/`retry()`; poison → DLQ |
| `brain-reembed` Queue (+DLQ) | net-new | model-drift re-embed sweep |
| Cron triggers | `gbrain:src/jobs.ts` (claim + sweep logic) | stale-source re-enqueue, re-embed sweep, idle-session promotion |

**Internal hops use native Service/Workflow bindings, not an HTTP shared secret (§5d).** The handler still reconstructs a `Principal` from the explicit `tenant_id` in the Workflow/Queue params and goes through `Scoped*` — bindings remove the network attack surface but do not bypass isolation. This supersedes `openbrains`' `X-OpenBrains-Internal-Secret` boundary and `gbrain`'s D1-`jobs`-table cron poller.

**`gbrain:src/jobs.ts` contributes the optimistic conditional claim** (`UPDATE jobs SET status='running' WHERE id=? AND status=? AND updated_at=?` — prevents double-run) and `STALE_RUNNING_MS` reclaim, retained for the enumerator-run row only (the Queue owns message-level dispatch).

---

### 2.7 L6 — CF primitives + AI

D1 (relational source of truth; bodies never stored here — **v1 is a single shared D1 for all 1-2 tenants; shard fan-out is a deferred future layer, §5e**), Vectorize V2 (two indexes provisioned in v1: `brain-chunks` 1024d/cosine for chunk search, `brain-entities` 1024d/cosine for entity search — §6.6/§6.7), R2 (bodies/transcripts, tenant-prefixed keys), KV (`OAUTH_KV`), DO (MCP instance). All Workers AI calls are proxied through **AI Gateway** with `tenant_id` custom metadata for per-tenant cost attribution/observability, backed by app-level `token_spend` accounting against `MONTHLY_COST_CEILING_USD` (§5f). The platform runs on Workers **Paid** ($5/mo; Workers AI billed by Neurons). Models (locked): embed `@cf/baai/bge-m3` (1024d), gen `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (~24k ctx), extract `@cf/meta/llama-3.1-8b-instruct`, rerank `@cf/baai/bge-reranker-base`. (Note: the `bge-base-en-v1.5` mention in the `cf-graph` ingestion source comment is stale; the platform locks `bge-m3`.)

**AI-provider abstraction (an explicit architectural seam, not a v1 feature).** Every AI call goes through a provider factory (modeled on cf-graph:`apps/graph/src/api/services/factory.ts`, `AI_PROVIDER` switch) rather than calling `env.AI.run` directly from services. In v1 the only wired provider is native Workers AI (`@cf/` models above) via AI Gateway. The seam exists so the documented upgrade path — AI Gateway caching/retry/fallback, and bring-your-own / OpenAI-compatible models (`AI_PROVIDER=openai-compatible`) — is a configuration change behind the same `embed()`/`gen()`/`rerank()` chokepoints, **not** a rewrite. None of that alternate routing is built in v1; the seam is the only forward-compat investment.

---

### 2.8 Request lifecycles

Each lifecycle is numbered and shows where the `tenant_id` chokepoint and post-query D1 re-check sit.

#### 2.8.1 `capture` — live session turn (net-new; weakest-grounded, so concrete)

```
Client(MCP capture_turn) → L1 resolvePrincipal → L2 MCP DO (readOnly? reject)
  → L3 sessions.captureTurn(principal, sessionId, role, content)
    → L4 ScopedDB.batch([                       (single D1 batch — no interactive tx)
         INSERT session_turns (tenant_id, session_id, idx, role, content),
         UPSERT sessions SET turn_count+1, updated_at,
         INSERT memory_audit (tenant_id, user_id, 'capture_turn', session_id) ])
    → if content large: L4 ScopedR2.put(`${tenantId}/sessions/${id}/turn-${idx}`, body)
  → 202
```

1. `resolvePrincipal` yields `Principal`; MCP DO rejects if `readOnly`.
2. `sessions.captureTurn` runs through `ScopedDB`: insert a **lean** `session_turns` row (role + short content, or an R2 ref for long turns), bump `sessions.turn_count`, and write a `memory_audit` row — **all in one `db.batch([...])`** (D1 has no interactive transactions across awaits; the audit-in-same-batch invariant derives from `openbrains:.../convex/memory/writeback.ts`).
3. Full transcript body, when oversized, goes to R2 via `ScopedR2` (`${tenantId}/sessions/...`).
4. The turn is **not embedded at capture time.** Promotion is deferred to `finalize_session` (§2.8.5 below references `SessionPromoteWorkflow`).
5. `capture_turn` shape models `gbrain:src/ops/facts.ts` `extract_facts` (turn_text + session_id), generalized with `tenant_id` and a `sessions`/`session_turns` index (§6).

```
[MCP] capture_turn ─┐
                    ▼
        ScopedDB.batch{turn, session++, audit} ──▶ D1
                    └─(big turn)─▶ ScopedR2 ──▶ R2
        (embedding deferred to finalize → SessionPromoteWorkflow)
```

#### 2.8.2 `search` — cheap hybrid (expansion OFF, rerank OFF)

```
Principal,q → L3 search.hybrid(scopedDB, scopedVec, q)
  ├─ embed(q) [bge-m3 via AI Gateway]                (null-safe; degrade)
  ├─ FTS arm:  ScopedDB MATCH q  → ids ──┐
  ├─ Vec arm:  ScopedVec.query(ns=tenant, q) → ids ─┤
  │                                                  ▼
  │            ── BOTH id sets JOIN back to ScopedDB rows ──
  │               (re-check tenant_id/scope/deleted_at; drop strangers)
  └─ rrfFusion(K=60, normalize-by-max) → applyTitleBoost(1.25) → top-k
```

1. `embed(q)` (degrades to keyword-only if unavailable).
2. FTS5 bm25 arm and Vectorize arm run in parallel; the Vectorize arm is hard-wired to `namespace=tenantId` by `ScopedVectorize`.
3. **Both** arms' id sets are JOINed back to `ScopedDB` rows and re-checked (the dual-arm chokepoint — §5c, §5g).
4. `rrfFusion` (K=60, normalize-by-max) then `applyTitleBoost`, paginate. Wholesale from `gbrain:src/search.ts` (`hybridSearch`, `rrfFusion`, `applyTitleBoost`) + `cf-graph:.../search/fts.ts` `sanitizeFtsQuery` hardening. **Delta vs gbrain:** both arms tenant-filtered (gbrain is single-tenant, no filter).

#### 2.8.3 `think` — search + reranked, token-budget-guarded synthesis

`think` ≠ `search`: it adds LLM query expansion, a cross-encoder rerank stage, and budget-guarded cited synthesis.

```
Principal,question → expandQuery (llama, opt-in)
  → for each phrasing: hybrid arms (as 2.8.2, tenant-filtered + D1 re-check)
  → rrfFusion merge → take top-N (~40 candidates)
  → bge-reranker-base { query, contexts:[{text}], top_k }   (index-mapped; degradable)
  → top-k (8–12)
  → SYNTHESIS TOKEN-BUDGET GUARD (against ~24k llama-3.3-70b window):
       reserve system+question+answer headroom; fill evidence highest-rerank-first
       until budget; dropped hits → warnings/gaps (never mid-doc truncation)
  → cited LLM synthesis → { answer, evidence[], citations[], gaps[], warnings }
```

1. Optional `expandQuery` (2–3 alternate phrasings; `gbrain:src/search.ts` `expandedHybridSearch`).
2. Hybrid retrieval per phrasing, RRF-merged — same tenant chokepoint + D1 re-check as `search`.
3. **Rerank** (net-new stage; verified signature `env.AI.run('@cf/baai/bge-reranker-base', { query, contexts:[{text}], top_k })`, output array indexes back into `contexts` — preserve the index→chunk map). Degradable: on error keep RRF order.
4. **Token-budget guard** (net-new): evidence added highest-rerank-score-first until the ~24k window budget is reached; overflow hits surfaced in `warnings`/`gaps`, never silently truncated mid-document; a single oversized top hit is summarized-then-synthesized.
5. Cited synthesis returns `{answer, evidence[], citations[], gaps[], warnings}`. Wholesale skeleton from `gbrain:src/ops/search.ts` `think` (numbered evidence blocks, slug citations, `no_evidence`/`llm_unavailable` warnings).
6. Each kept hit writes a `memory_recall_traces` row via `ScopedDB` (`openbrains:.../convex/memory/recall.ts`).

#### 2.8.4 `ingest` — document upload → durable indexing

```
[REST/MCP upload]
  → L3 ingest.upload(principal, file)
     ├─ ALLOWED_CONTENT_TYPES allowlist                 (cf-graph documents.ts)
     ├─ ScopedR2.put(`${tenantId}/docs/${id}`, blob)    (BODY → R2)
     ├─ fingerprint = sha256(normalizeForFingerprint(md))
     │     if matches existing documents.fingerprint → return {skipped}
     ├─ ScopedDB.insert documents{tenant_id, r2_key, markdown_preview, status:'pending'}
     └─ env.INGESTION_WORKFLOW.create(id=`ingest-${tenantId}-${fingerprint}`, {tenantId,...})
  ───────────── (durable, async, over Workflow binding) ─────────────
  IngestionWorkflow.run(params with tenant_id):
   1 status→processing                                  (ScopedDB)
   2 extract-text  R2.get → toMarkdown (PDF/DOCX/HTML)  (retries 3×)
   3 chunk-text    (strategy: paragraph-pack md / sliding 512-64 PDF)
   4 store-chunks-batch(10)  → chunks{tenant_id} + chunks_fts triggers
   5 embed-batch(50) bge-m3 → ScopedVectorize.upsert(ns=tenant, meta{team,scope})
                              + stamp embedded_at/embedding_model
   6 KG-batch(5)    → EntityExtractionWorkflow (entity tables, tenant_id)
   7 finalize       status→indexed
```

1. Allowlist check (`cf-graph:.../services/documents.ts` `ALLOWED_CONTENT_TYPES`), **body to R2 via `ScopedR2`**, fingerprint dedup (`sha256(normalizeForFingerprint(md))` — `openbrains:packages/ingest/src/{fingerprint,normalize}.ts` + `gbrain` skip-unchanged), `documents` row (preview only) via `ScopedDB`.
2. Workflow created with **deterministic id** `ingest-${tenantId}-${fingerprint}` (idempotent under at-least-once delivery).
3. `IngestionWorkflow` is `cf-graph:.../workflows/ingestion.ts` near-verbatim. **Delta:** every step is parameterized with `tenant_id`; chunks/FTS/vectors all carry it; vectors go through `ScopedVectorize` (`namespace=tenantId`); `embedded_at`/`embedding_model` stamped per row (cf-graph lacks this).
4. The D1 batch constants are real and limit-driven: `CHUNK_DB_BATCH_SIZE=10` (D1 100 bound-param cap), `EMBED_BATCH_SIZE=50`, `KG_BATCH_SIZE=5`.

#### 2.8.5 `backfill` — historical source enumeration (three-stage spine)

```
[trigger source backfill]
  → EnumeratorWorkflow(tenantId, sourceId):              (one instance per pair)
      begin → importer.begin({resumeCursor: anchor})
      loop step.do(`page-${n}`):
         batch = importer.nextBatch(cursor)               (openbrains Importer contract)
         for item in batch:
            ScopedR2.put(`${tenantId}/backfill/${runId}/${fingerprint}`, payload)
            brain-backfill.send({ tenantId, sourceId, runId, kind,
                                  payloadRef, fingerprint })     ← references only
         backfill_runs.cursor = batch.nextCursor          (ScopedDB; gbrain anchor discipline)
      finalize → advance anchor ONLY on a clean pass
  ─────────────────────────────────────────────────────────
  brain-backfill consumer (max_batch 10, retries 5, DLQ):
      per message: ack() / retry({delaySeconds})          (one poison ≠ batch fail)
      heavy item → IngestionWorkflow id=`ingest-${tenantId}-${fingerprint}` (idempotent)
      poison after 5 retries → brain-backfill-dlq
  ─────────────────────────────────────────────────────────
  brain-reembed (cron-fed): rows where embedding_model != bge-m3
      OR embedded_at IS NULL OR updated_at > embedded_at → re-embed + restamp
```

1. **EnumeratorWorkflow** drives the `openbrains:packages/ingest/src/sources/types.ts` `Importer` contract (`begin → nextBatch(cursor) → finalize`) with `gbrain:src/sync.ts` cursor/anchor discipline (anchor advances only on a clean pass; never on a degraded read). Each page is one named `step.do` so a restart resumes from the last completed page. It **only enqueues references** (payload to R2, ref in the message) — staying under the 10k-step and 1 MiB step-output caps.
2. **`brain-backfill` Queue** message `{ tenantId, sourceId, runId, kind, payloadRef, fingerprint }`. Consumer does per-message `ack()`/`retry()`; poison → DLQ (a real DLQ, vs `gbrain`'s dead `jobs.error`). Heavy items spawn `IngestionWorkflow` with the deterministic id (idempotent under duplicate delivery).
3. **`brain-reembed` Queue** (cron-fed) sweeps model/content drift — combines `gbrain:src/jobs.ts` `runEmbedJob` (`SELECT ... WHERE embedded_at IS NULL`) with `openbrains` per-row `embedding_model` tracking. Migration is budgeted/resumable (§6 cost model), traffic tagged `migration` in AI Gateway.
4. **Tenant threading:** every Queue message, Workflow param, `backfill_runs.cursor` row (via `ScopedDB`), D1 row, Vectorize namespace, and R2 key carries `tenant_id`. Importers are lifted from `openbrains:packages/ingest` (Gmail, OB1, GitHub-sync) minus the Convex orchestrator; net-new ChatGPT and Claude-Code session importers model `openbrains:.../sources/ob1.ts` (parse untrusted export, drop foreign embeddings, emit `embeddingModel:'pending'`).

---

### 2.9 Data-flow summary across layers

```
WRITE PATH:  client → L1 Principal → L2 surface → L3 service
             → L4 ScopedR2(body) + ScopedDB(index row) → L5 Workflow
             → L4 ScopedVectorize(ns=tenant) + ScopedDB(chunks/FTS) → L6
READ PATH:   client → L1 → L2 → L3 search/think
             → L4 ScopedVectorize.query(ns=tenant) ∥ ScopedDB FTS MATCH
             → L4 D1 re-check (drop cross-tenant) → fuse/rerank/synthesize → L6 AI Gateway
```

The invariant a reviewer should check: **no L3 service ever names a raw `env.DB`/`env.VECTORIZE`/`env.FILES` binding** — only `Scoped*` handles, enforced by ESLint banned-import (§5i) with the raw bindings importable only inside `packages/db`.

#### Code references

- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/ingestion.ts — IngestionWorkflow near-verbatim as Batch-Ingest Workflow: extract→chunk→store-chunks-batch(10)→embed-batch(50)→KG-batch(5)→finalize, per-phase retries/backoff, D1 100-param batching constants, status FSM. Add tenant_id to every step/row/vector and route vectors through ScopedVectorize. Note the bge-base-en-v1.5 comment is stale; lock bge-m3.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/server.ts — MyMCP McpAgent init() pattern: reads props.userId/workspaceSlug, resolves context, registers mutation tools only when props.readOnly !== true. Reuse for the per-tenant MCP DO; resolve slug to tenant+scope and gate writes on Principal.readOnly.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/workspace-scoped-handler.ts — /mcp/<slug> URL-rewrite + slug injection into ctx.props (with SLUG_PATTERN validation and MCP_PROTOCOL_PATHS passthrough). Reuse verbatim; resolve slug to {tenantId, scope} via memberships instead of workspace.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/middleware/auth.ts — cliTokenFallback multi-token fan-out (Clerk → wbai_ API key → CLI JWT → one userId). Template for resolvePrincipal()'s try-each chain; delta is a membership lookup to attach tenantId/teamIds/role.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/db/schema.ts — documents/chunks/kg_entities Drizzle table shape (currently workspace_id-scoped, no embedded_at/per-row embedding model). Generalize workspace_id→tenant_id and add staleness columns; bodies move to R2 with markdown→markdown_preview.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/search.ts — hybridSearch, expandedHybridSearch, rrfFusion (K=60, normalize-by-max), applyTitleBoost (1.25), vectorSearch (query→JOIN-back-to-live-D1, drops orphans), computeStale, expandQuery. The hybrid engine; add tenant filter to both arms + the D1 re-check generalization.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/search.ts — think op skeleton: expandedHybridSearch(limit:12) → numbered evidence blocks → strict-cite system prompt → {answer, evidence, citations, gaps, warnings:[no_evidence|llm_unavailable]}. Slot the rerank stage + token-budget guard before synthesis.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/facts.ts — extract_facts/recall/forget_fact op shapes (turn_text+session_id, since-parser, soft-expire). Models the capture_turn/session-promote path; add tenant_id and hard-wire trust_grade='evidence'.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/index.ts — Flat operations[] registry + buildToolDefs() (op params → MCP inputSchema) + validateParams. Reuse as the service-layer op registry consumed by REST, MCP, and Workflow callers.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/jobs.ts — Optimistic conditional job claim (UPDATE WHERE status=? AND updated_at=?) + STALE_RUNNING_MS reclaim + runEmbedJob (SELECT WHERE embedded_at IS NULL) sweep. Retain claim/reclaim for the enumerator-run row; the Queue replaces the cron poller as dispatcher.
- openbrains:/home/roboto/devel/openbrains/packages/services/src/deps/vectorize.ts — createVectorizeClient that hard-wires namespace on every upsert/query (impossible to omit). Rename userId→tenantId; move team_id/scope/visibility/embedding_model to metadata (trust_grade is sidecar-only — never a Vectorize index/filter/upsert field, §3.2/§5.2). THE ScopedVectorize artifact and the 'D1 row is correctness gate, metadata lags' rule.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/types.ts — Importer contract (begin/nextBatch(cursor)/finalize, {items,nextCursor}) and BrainBundleThought (provenance[], sourceRefs[], embeddingModel). Drive it from EnumeratorWorkflow; lift Gmail/OB1/GitHub importers minus the Convex orchestrator.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/writeback.ts — Atomic agent writeback: trustGrade hard-wired 'evidence' (no arg), thought+provenance+use_policy+audit in one transaction. Reimplement on D1 db.batch([...]) (no interactive tx); audit row in the same batch as the change.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/index.ts — OAuthProvider + Clerk default handler + resolveExternalToken for HMAC machine tokens, OAUTH_KV-backed. Template for L1 workers-oauth-provider wiring; internal-secret hop is replaced by native Service/Workflow bindings.

---

## 3. Data Model & Storage

This section is the **consolidated, authoritative data-model reference** for the Brain Platform. The storage definitions that drive the platform are specified, in depth, alongside the pipelines that own them — §4 (ingestion: `documents`/`chunks`), §6 (graph: `pages`/`doc_links`/`entities`/…), §7 (tenancy/governance: `orgs`/`teams`/`memberships`/`api_keys`/`memory_*`), §8 (sessions/facts/backfill), and §10 (ops: `mcp_request_log`). §3 gathers every one of those definitions into a single catalog so a reader does not have to reassemble the schema from six places.

> **Authority rule (read this first).** **§4 remains authoritative for `documents`, `chunks`, and `chunks_fts`** (including the FTS5 triggers); **§6 is authoritative for the graph tables**; **§7 for tenancy/governance**; **§8 for sessions/facts/backfill**. §3 **mirrors** those definitions verbatim for convenience and annotates each table with `(authoritative: §N)`. §3 introduces no column that contradicts the owning section, and it invents net-new DDL only for the three tables that are *named and called* by the other sections but whose DDL appears in none of them — `pages`, `ingest_log`, and `token_spend` — each marked `(consolidated here)` and grounded in the call sites / source migrations that constrain its shape.

**Platform substrate (no Convex).** Everything is Cloudflare-native: **D1** (relational source of truth, the `DB` binding, shardable behind `ScopedDB`), **R2** (`FILES` — raw bodies/transcripts/audit exports), **Vectorize V2** (`brain-chunks`, 1024-dim cosine), **Workers AI** (`@cf/baai/bge-m3` embeddings), **KV** (`OAUTH_KV`), and **Durable Objects** (the per-tenant `BrainMCP` server instance only). The relational layer is a fusion of three mined schemas — cf-graph's Drizzle `documents`/`chunks` (`cf-graph:apps/graph/src/api/db/schema.ts`), gbrain's SQL migrations (`gbrain-cf:migrations/0001_init.sql..0009_sync.sql`), and openbrains' Convex schema (`openbrains:packages/convex/convex/schema.ts`) — re-expressed as D1 DDL, re-scoped from cf-graph's single `workspace_id` / openbrains' single `userId` to the platform's `org → team → user → scope` tenancy spine.

---

### 3.0 Cross-cutting conventions (apply to the whole catalog)

These hold for **every** table below unless the table's note states a principled exception.

- **Ids.** Every base-table primary key is a **stable `nanoid` `TEXT`** (cf-graph style — re-embed and re-link target the same id; no delete-and-recreate churn), **except `facts.id`**, which is `INTEGER PRIMARY KEY AUTOINCREMENT` (ported verbatim from gbrain `0004_facts.sql`; its `superseded_by`/`consolidated_into` self-references and FTS `content_rowid='id'` depend on the integer rowid). gbrain's mined tables use `INTEGER AUTOINCREMENT`; in the platform port they become `TEXT` nanoid so ids are stable across shards and re-ingest (the reason §4/§6 pin nanoid).
- **Timestamps.** ISO-8601 `TEXT`, default `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` (gbrain convention) — except the append-only audit tables (`memory_audit`, `memory_recall_traces`), which use epoch-ms `INTEGER` `at` (openbrains convention, §7.6).
- **The tenancy spine (req 4).** Every **isolatable** row carries `tenant_id TEXT NOT NULL` (= the org id; **org is the tenant**, §7.1). Tables that additionally partition carry `team_id TEXT` (nullable), `user_id TEXT` (authorship), and `scope TEXT` (project/client sub-partition). Rows that participate in the intra-tenant access tier carry `visibility TEXT CHECK (visibility IN ('private','team','world'))` (§7.5). **Principled exceptions** (annotated at each table): `orgs` *is* the tenant (its `id` is the `tenant_id`); `tenant_shards` is keyed by `tenant_id`; the FTS5 virtual tables (`chunks_fts`/`facts_fts`/`entity_fts`) carry **no** `tenant_id` by design (external-content cannot filter inside `MATCH` — isolation is the JOIN-recheck of §7.4, the deliberate exception to req 4); the `memory_*` sidecars carry `tenant_id` + `target_id` only.
- **Names follow the source, not req 4's generic labels.** `tenant_id` (not `org_id`), `user_id` (not `owner_user_id`) — because org==tenant and the mined code already uses these names everywhere a `Scoped*` predicate is built.
- **Two orthogonal governance axes, never conflated** (§7.5): `trust_grade ∈ {instruction, evidence, draft}` is an *agent-behaviour* signal living in the **`memory_use_policy` sidecar** (NOT a column on `chunks`/`documents`/`facts`); `visibility ∈ {private, team, world}` is *access control*. A trust promotion never rewrites a chunk.
- **Body-offload (D1 capacity discipline).** D1 holds the **index + lean rows**; full bodies/transcripts live in **R2** addressed by an `r2_key`/`body_r2_key`/`r2_offset`. This is a correctness requirement for the single shared D1 under its 10 GB / 6 GB-alert budget (§10.7), not an optimization.
- **Isolation is structural.** No table is read or written with a hand-built `WHERE`; all access goes through `ScopedDB`/`ScopedVectorize`/`ScopedR2` (§7.3), which inject `tenant_id` (+ scope + visibility) on every call. The DDL below is the *shape*; the choke-point is what makes the predicate un-omittable.

---

### 3.1 D1 schema catalog

#### 3.1.1 Core content — `documents`, `chunks`, `chunks_fts` (authoritative: §4.9)

The single canonical definition lives in §4.9; reproduced here verbatim. `slug`/`title` are **on `documents`** (citation fields, reached by a `chunks → documents` JOIN), `trust_grade` is **not** a column (LEFT-JOINed from `memory_use_policy`), and `chunks` carry `scope`/`team_id`/`user_id`/`visibility` (iter-3) so the hybrid/`think` arm is gated by the same intra-tenant RLS as facts.

```sql
-- documents: index + provenance + dedup, NO full body.            (authoritative: §4.9)
CREATE TABLE documents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, team_id TEXT, scope TEXT, user_id TEXT NOT NULL,
  slug TEXT NOT NULL, title TEXT,                                      -- citation fields (JOIN target for §5.3)
  content_type TEXT, body_r2_key TEXT, markdown_preview TEXT,          -- preview only; body via body_r2_key
  status TEXT NOT NULL DEFAULT 'pending',                              -- pending|processing|indexed|failed|duplicate|skipped
  parent_document_id TEXT, part_index INTEGER, part_count INTEGER,     -- oversized-upload split (§4.3); NULL for un-split
  fingerprint TEXT NOT NULL, chunk_count INTEGER DEFAULT 0,
  source_id TEXT, source_kind TEXT, source_uri TEXT, ingested_via TEXT, ingested_at TEXT,
  tags TEXT DEFAULT '[]', metadata TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX ux_documents_tenant_fp   ON documents(tenant_id, scope, fingerprint);  -- dedup backstop
CREATE UNIQUE INDEX ux_documents_tenant_slug ON documents(tenant_id, slug);                -- slug unique within tenant
CREATE INDEX        ix_documents_tenant_source ON documents(tenant_id, source_id, status);

-- chunks: stable nanoid id (re-embed target), per-row embedding state.  (authoritative: §4.9)
CREATE TABLE chunks (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL,
  scope TEXT,                                                          -- mirrored from parent doc (allowedScopes gate)
  team_id TEXT,                                                        -- mirrored (visibility gate)
  user_id TEXT,                                                        -- author mirrored (visibility gate)
  visibility TEXT NOT NULL DEFAULT 'world'                             -- intra-tenant access tier on the hybrid arm
             CHECK (visibility IN ('private','team','world')),         --   ingested-doc chunks default 'world';
                                                                       --   session-transcript chunks inherit session tier
  chunk_index INTEGER NOT NULL, content TEXT NOT NULL, heading_path TEXT,
  token_count INTEGER, chunk_source TEXT,
  embedded_at TEXT, embed_error TEXT,                                  -- staleness (gbrain 0002_search.sql)
  embedding_model TEXT NOT NULL, embedding_dims INTEGER NOT NULL,      -- per-row model tracking (openbrains)
  updated_at TEXT NOT NULL,                                            -- drives computeStale (updated_at > embedded_at)
  deleted_at TEXT                                                      -- soft-delete; search filters deleted_at IS NULL
);
CREATE INDEX ix_chunks_tenant_doc ON chunks(tenant_id, document_id);

-- FTS5 external-content + triggers — NO tenant_id (isolation = JOIN re-check, §7.4).  (authoritative: §4.9)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  heading_path, content, content='chunks', content_rowid='rowid');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, heading_path, content) VALUES (new.rowid, new.heading_path, new.content); END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content) VALUES('delete', old.rowid, old.heading_path, old.content); END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content) VALUES('delete', old.rowid, old.heading_path, old.content);
  INSERT INTO chunks_fts(rowid, heading_path, content) VALUES (new.rowid, new.heading_path, new.content); END;
```

> The search path reads a **subset** of these columns plus three JOIN-supplied fields — `slug`/`title`/`source_id` from `documents`, and `trust_grade` from the `memory_use_policy` sidecar (default `'evidence'`) — via `ScopedDB.getChunksByIds` (§5.2/§5.3). No second `CREATE TABLE` exists for the search path.

#### 3.1.2 Document/page link graph — `pages`, `doc_links`, `tags`, `timeline_entries`, `page_versions`

The **DOC_GRAPH node space is `pages` only** (§6.0, pinned): `doc_links.from_id`/`to_id` are **always `pages.id`**; an ingested document *backs* a page (the ingest path creates/updates the page row), and `documents`/`chunks` are content hanging off the page, never link-graph nodes. `pages` is referenced throughout §6 as "ported from gbrain `0001_init.sql`" but its DDL is reproduced in no section, so it is **consolidated here** — gbrain's `pages` shape (`gbrain-cf:migrations/0001_init.sql:9`) with the platform conventions applied (nanoid `TEXT` id replacing gbrain's `INTEGER AUTOINCREMENT`, so `doc_links` TEXT fk's resolve; `+ tenant_id NOT NULL`; `compiled_truth` becomes a preview with the full body in R2; the `EdgeSpec` columns `title`/`type`/`deleted_at` of §6.1 are present, plus the `visibility` column §6.1 adds for the doc-graph node gate).

```sql
-- pages: the ONLY doc-graph node space.   (consolidated here; shape from gbrain-cf:migrations/0001_init.sql:9, re-scoped)
CREATE TABLE pages (
  id            TEXT PRIMARY KEY,                  -- nanoid (was INTEGER in gbrain; TEXT so doc_links fk's resolve)
  tenant_id     TEXT NOT NULL,
  team_id       TEXT, scope TEXT, user_id TEXT,    -- tenancy spine (gbrain is single-tenant; added here)
  slug          TEXT NOT NULL,                     -- unique WITHIN tenant (was globally UNIQUE in gbrain)
  type          TEXT NOT NULL DEFAULT 'note',      -- EdgeSpec.typeCol for DOC_GRAPH (§6.1)
  title         TEXT NOT NULL DEFAULT '',          -- EdgeSpec.labelCol for DOC_GRAPH (§6.1)
  visibility    TEXT NOT NULL DEFAULT 'world'      -- intra-tenant access tier on the doc-graph arm (§6.0/§6.1)
                CHECK (visibility IN ('private','team','world')),  -- populated from backing doc at ingest;
                                                   --   manual pages default 'world'. Gates traverse/links (§6.5)
  compiled_truth TEXT NOT NULL DEFAULT '',         -- markdown PREVIEW (full body in R2; body-offload rule)
  frontmatter   TEXT NOT NULL DEFAULT '{}',
  content_hash  TEXT,                              -- skip-unchanged gate (gbrain putPage)
  document_id   TEXT,                              -- the backing document, when a page was created by ingest
  source_id TEXT, source_kind TEXT, source_uri TEXT, ingested_via TEXT, ingested_at TEXT,
  effective_date TEXT, effective_date_source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT                                  -- soft-delete; BFS/getLinks filter deleted_at IS NULL (§6.5)
);
CREATE UNIQUE INDEX ux_pages_tenant_slug ON pages(tenant_id, slug);
CREATE INDEX ix_pages_tenant_type        ON pages(tenant_id, type);
CREATE INDEX ix_pages_tenant_updated     ON pages(tenant_id, updated_at);
CREATE INDEX ix_pages_source             ON pages(tenant_id, source_id, ingested_via, deleted_at);  -- gbrain 0009_sync.sql
```

The remaining link-graph tables are **(authoritative: §6.1)** — reproduced verbatim:

```sql
-- doc_links: typed page→page edges; from_id/to_id ALWAYS pages.id.   (authoritative: §6.1)
CREATE TABLE doc_links (
  id            TEXT PRIMARY KEY,                  -- nanoid
  tenant_id     TEXT NOT NULL,
  from_id       TEXT NOT NULL,                     -- ALWAYS a pages.id
  to_id         TEXT NOT NULL,                     -- ALWAYS a pages.id
  link_type     TEXT NOT NULL DEFAULT '',          -- 'references'|'supersedes'|'related'|...
  link_source   TEXT NOT NULL DEFAULT 'manual',    -- manual|markdown|frontmatter|mentions|wikilink-resolved
  origin_id     TEXT, origin_field TEXT,           -- which page/field emitted an auto-link
  context       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_doc_links_unique             -- edge-dedup key (gbrain COALESCE-on-nullable, + tenant_id)
  ON doc_links(tenant_id, from_id, to_id, link_type, link_source, COALESCE(origin_id, ''));
CREATE INDEX idx_doc_links_from ON doc_links(tenant_id, from_id);
CREATE INDEX idx_doc_links_to   ON doc_links(tenant_id, to_id);     -- backlinks arm

CREATE TABLE tags (                                                  -- (authoritative: §6.1)
  tenant_id TEXT NOT NULL, page_id TEXT NOT NULL, tag TEXT NOT NULL,
  UNIQUE (tenant_id, page_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tenant_id, tag);

CREATE TABLE timeline_entries (                                      -- (authoritative: §6.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, page_id TEXT NOT NULL,
  date TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, page_id, date, summary)                        -- INSERT OR IGNORE dedup key
);

CREATE TABLE page_versions (                                         -- (authoritative: §6.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, page_id TEXT NOT NULL,
  compiled_truth TEXT NOT NULL,                                      -- markdown preview body (full body in R2)
  frontmatter TEXT NOT NULL DEFAULT '{}',
  snapshot_at TEXT NOT NULL
);
CREATE INDEX idx_page_versions_page ON page_versions(tenant_id, page_id, snapshot_at DESC);
```

#### 3.1.3 Knowledge graph (extracted) — `entities`, `entity_relations`, `entity_mentions`, `entity_fts` (authoritative: §6.1)

Ported from openbrains' Convex `entities`/`entity_relations`/`entity_mentions` (`openbrains:packages/convex/convex/schema.ts:184-219`), re-expressed as D1 with `tenant_id` + nanoid ids, case-insensitive canonical-name uniqueness (cf-graph merge). `entity_mentions` is the **bridge** from the KG to documents/chunks/sessions/pages.

```sql
CREATE TABLE entities (                                              -- (authoritative: §6.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- person|org|project|concept|...
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',              -- JSON string[] (set-union, capped 50)
  description TEXT NOT NULL DEFAULT '',
  source_chunk_ids TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  mention_count INTEGER NOT NULL DEFAULT 0,
  scope TEXT,                                       -- data-partition axis (§6.0/§7.3): PARTITIONED, in the dedup
                                                    --   key, so "Acme" under client-A and client-B are TWO rows
  visibility TEXT NOT NULL DEFAULT 'world'          -- intra-tenant access tier; KG node space is {world,team}
             CHECK (visibility IN ('team','world')),--   only (NO 'private': merged MAX-permissive, world wins)
  team_id TEXT,                                     -- set only when visibility='team' (single-team origin)
  embedded_at TEXT, embed_error TEXT,              -- entity-vector staleness (same as chunks; §3.2/§6.6)
  embedding_model TEXT, embedding_dims INTEGER,    -- per-row model tracking for brain-entities (§3.2)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL  -- updated_at > embedded_at drives computeStale
);
-- scope is part of the key (PARTITION-by-scope, §6.0/§7.3): COALESCE(scope,'') so the unrestricted
-- ('*', scope=NULL) partition still dedups (SQLite treats NULL as distinct).
CREATE UNIQUE INDEX idx_entities_key  ON entities(tenant_id, COALESCE(scope,''), kind, lower(canonical_name));  -- case-insensitive dedup
CREATE INDEX        idx_entities_kind ON entities(tenant_id, kind, updated_at DESC);

CREATE TABLE entity_relations (                                      -- (authoritative: §6.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- relation type
  confidence REAL NOT NULL DEFAULT 0.5,            -- 0..1; on conflict -> max
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',   -- JSON string[]; on conflict -> union
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_entity_relations_key  ON entity_relations(tenant_id, from_entity_id, to_entity_id, kind);
CREATE INDEX        idx_entity_relations_from ON entity_relations(tenant_id, from_entity_id);
CREATE INDEX        idx_entity_relations_to   ON entity_relations(tenant_id, to_entity_id);

CREATE TABLE entity_mentions (                                       -- the BRIDGE.  (authoritative: §6.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,                       -- 'chunk'|'document'|'session'|'page'
  source_id TEXT NOT NULL,
  span_start INTEGER, span_end INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_entity_mentions_uniq      ON entity_mentions(tenant_id, entity_id, source_kind, source_id);
CREATE INDEX        idx_entity_mentions_by_source ON entity_mentions(tenant_id, source_kind, source_id);

-- entity FTS5 (no tenant_id; isolation = JOIN re-check, §7.4).      (authoritative: §6.1)
CREATE VIRTUAL TABLE entity_fts USING fts5(
  canonical_name, aliases, description, content='entities', content_rowid='rowid');
-- + insert/delete/update triggers, gbrain external-content pattern (identical form to chunks_fts).
```

> **In v1:** entity *vectors* (the `brain-entities` Vectorize index, §3.2) — embedded canonical-name + description, powering `search_entities` scoped vector search (§6.6/§6.7). **Still deferred to Phase 3.5:** cross-session **semantic** entity/fact dedup. v1 KG dedup stays the deterministic key `(tenant_id, kind, lower(canonical_name))` + alias set-union only (§6.6). `brain-entities` **is provisioned** in v1.

#### 3.1.4 Tenancy & auth — `orgs`, `teams`, `memberships`, `scopes`, `api_keys`, `cli_auth_sessions`, `cli_refresh_tokens`, `tenant_shards` (authoritative: §7.1)

`memberships` is **net-new** (no mined repo has org→team→user). `api_keys` fuses cf-graph's prefix+hash+`readOnly` with a single `tenant_id` (replacing cf-graph's `workspace_ids[]` JSON — a key is bound to exactly one tenant). Expressed here as DDL (§7.1 gives the Drizzle form).

```sql
-- orgs: org IS the tenant — its `id` is the tenant_id everywhere else.  (authoritative: §7.1)
-- PRINCIPLED EXCEPTION to req-4 tenancy columns: this table defines the tenant.
CREATE TABLE orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
  flags TEXT DEFAULT '{}',                          -- per-tenant capability/rollout allowlist (§10.7)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX orgs_slug_ux ON orgs(slug);

CREATE TABLE teams (                                                 -- (authoritative: §7.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL
);
CREATE UNIQUE INDEX teams_tenant_slug_ux ON teams(tenant_id, slug);

-- memberships: the local user↔tenant join (there is NO `users` table — user_id is the
-- Clerk subject; this row IS the per-tenant user record).             (authoritative: §7.1, NET-NEW)
CREATE TABLE memberships (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                            -- Clerk sub
  team_id TEXT,                                     -- NULL = tenant-wide membership
  role TEXT NOT NULL,                               -- 'owner'|'admin'|'member'|'readonly'
  allowed_scopes TEXT,                              -- DATA-partition grant: JSON string[] | NULL(='*' all scopes)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX memberships_user_ix   ON memberships(user_id);
CREATE INDEX memberships_tenant_ix ON memberships(tenant_id, user_id);

CREATE TABLE scopes (                              -- ports openbrains `projects` + tenant_id/team_id.  (authoritative: §7.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, team_id TEXT,
  slug TEXT NOT NULL, name TEXT NOT NULL
);
CREATE UNIQUE INDEX scopes_tenant_slug_ux ON scopes(tenant_id, slug);

-- api_keys: SHA-256 hash, bound to ONE tenant. capability axis = `scopes` JSON.  (authoritative: §7.1)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,    -- a key is bound to exactly one tenant
  user_id TEXT NOT NULL,                            -- minting actor
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, -- sha256(rawKey) + display prefix (cf-graph)
  scopes TEXT NOT NULL DEFAULT '[]',                -- CAPABILITY axis: JSON e.g. ["read","write"] (NOT data scopes)
  allowed_scopes TEXT,                              -- DATA-partition grant: JSON string[] | NULL(='*' iff minter was '*'); pinned at mint to intersect(request, minter.allowedScopes) (§7.1/§7.2)
  read_only INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT, last_used_at TEXT, revoked_at TEXT
);
CREATE UNIQUE INDEX api_keys_hash_ux ON api_keys(key_hash);

-- device-code flow, ported verbatim from cf-graph (cf-graph:apps/graph/src/api/db/schema.ts:61-90).
CREATE TABLE cli_auth_sessions  ( id TEXT PRIMARY KEY, tenant_id TEXT, device_code TEXT NOT NULL,
  user_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', user_id TEXT,
  access_token TEXT, refresh_token TEXT, token_expires_at TEXT, expires_at TEXT NOT NULL,
  poll_interval INTEGER NOT NULL DEFAULT 5, created_at TEXT NOT NULL );
CREATE TABLE cli_refresh_tokens ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT );

-- tenant_shards: the shard map ScopedDB/ScopedVectorize read per request.  (authoritative: §7.1, NET-NEW)
-- PRINCIPLED EXCEPTION: keyed by tenant_id (it IS the per-tenant routing row).
-- SINGLE-SHARD in v1: at 1-2 tenants every row resolves to ONE shared D1 (db_binding='DB')
--   and the base indexes; the columns are RETAINED for forward-compat but the horizontal
--   split (db_binding fan-out / brain-chunks-{shard}) is a DEFERRED Phase-N scale-out TRIGGER
--   (§10.7), NOT a v1 build. No shard-routing logic ships in v1 beyond the one-row lookup.
CREATE TABLE tenant_shards (
  tenant_id    TEXT PRIMARY KEY,
  db_binding   TEXT NOT NULL,                       -- always 'DB' in v1 (single shared D1; fan-out is Phase-N)
  chunk_index  TEXT NOT NULL,                       -- 'brain-chunks' in v1
  entity_index TEXT                                 -- 'brain-entities' in v1 (entity vector search, §3.2/§6.6)
);
```

#### 3.1.5 Trust & governance sidecars — `memory_use_policy`, `memory_provenance`, `memory_review`, `memory_audit`, `memory_recall_traces` (authoritative: §7.5/§7.6)

The `memory_*` sidecars carry `tenant_id` + `target_id` (the fact/chunk/document id) — the **principled req-4 exception** (they hang off a target, not a tenancy spine of their own). `memory_audit`/`memory_recall_traces` are **append-only** (no `UPDATE`/`DELETE` in app code; epoch-ms `at`).

```sql
-- trust_grade lives HERE, not on chunks/facts (LEFT-JOINed at read).   (authoritative: §7.5)
CREATE TABLE memory_use_policy (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  target_id TEXT NOT NULL,                          -- fact/chunk/document id
  trust_grade TEXT NOT NULL DEFAULT 'evidence'
              CHECK (trust_grade IN ('instruction','evidence','draft')),
  scopes TEXT NOT NULL DEFAULT '[]', expires_at TEXT
);
CREATE TABLE memory_provenance (                                     -- (authoritative: §7.5)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, target_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('human','agent_inferred','agent_generated','import')),
  agent TEXT, session_id TEXT, captured_at TEXT NOT NULL
);
CREATE TABLE memory_review (                                         -- (authoritative: §7.5)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unreviewed','confirmed','rejected','needs_revision')),
  reviewer TEXT NOT NULL, reviewed_at TEXT NOT NULL, note TEXT
);

-- append-only; epoch-ms `at`; written IN the same db.batch as the change.  (authoritative: §7.6)
CREATE TABLE memory_audit (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                            -- actor
  action TEXT NOT NULL,                             -- 'fact.create'|'usePolicy.promote'|'apiKey.mint'|...
  target_id TEXT, at INTEGER NOT NULL, diff TEXT    -- opaque JSON
);
CREATE INDEX memory_audit_tenant_at ON memory_audit(tenant_id, at DESC);

CREATE TABLE memory_recall_traces (                -- one row per KEPT hit.  (authoritative: §7.6)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                            -- author of the recall; read-restricted to this user / owner-admin
  query TEXT NOT NULL, target_id TEXT NOT NULL, score REAL NOT NULL,
  client_id TEXT NOT NULL,                          -- which AI client surfaced it
  at INTEGER NOT NULL
);
CREATE INDEX recall_traces_tenant_at ON memory_recall_traces(tenant_id, at DESC);
```

> **Read-auth (§7.6, second-order privacy):** `memory_recall_traces` is readable only by the authoring `user_id` (or an audited owner/admin compliance read); `memory_audit` reads are owner/admin only — both are §10.6 canaries.

#### 3.1.6 Sessions & hot memory — `sessions`, `session_turns`, `facts`, `facts_fts`, `brain_snapshots` (authoritative: §8.1)

`sessions`/`session_turns` are **net-new** (no mined project has a first-class session store). `facts` ports gbrain `0004_facts.sql` **verbatim** (integer-autoincrement id, the epistemic columns, validity window, supersession lineage, FTS triggers) and adds the tenancy spine + the 3-value `visibility` enum (gbrain's was 2-value `private|world`). **There is no `session_chunks` table:** session transcripts are chunked and written into the shared **`chunks`** table (§3.1.1) carrying the originating session's `visibility`/`user_id`/`team_id` (§8.3); `session_turns` is the lean per-turn index.

```sql
CREATE TABLE sessions (                                              -- (authoritative: §8.1, NET-NEW)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, team_id TEXT, user_id TEXT NOT NULL, scope TEXT,
  client TEXT NOT NULL CHECK (client IN ('claude-code','claude-desktop','chatgpt','cli','web','import')),
  source_session_id TEXT,                           -- the client's own id (idempotent upsert)
  title TEXT, started_at TEXT NOT NULL,
  ended_at TEXT,                                    -- set ONLY on explicit close (may be NULL on missed Stop-hook)
  last_activity_at TEXT NOT NULL                    -- refreshed on EVERY capture_turn — the idle-sweep key (§8.3)
                   DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalizing','promoted','failed')),
  turn_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,                                      -- full transcript: ${tenantId}/sessions/${id}.jsonl
  content_hash TEXT,                                -- sha256(normalizeForFingerprint(transcript)) dedup
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user   ON sessions(tenant_id, user_id, started_at DESC);
CREATE INDEX idx_sessions_client ON sessions(tenant_id, client, started_at DESC);
CREATE INDEX idx_sessions_open   ON sessions(tenant_id, status, last_activity_at);   -- idle-promotion sweep (§8.3)
CREATE UNIQUE INDEX idx_sessions_source ON sessions(tenant_id, client, source_session_id)
  WHERE source_session_id IS NOT NULL;             -- idempotent re-push

CREATE TABLE session_turns (                                         -- (authoritative: §8.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL,                             -- ordinal within session
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content TEXT,                                     -- short turns inline; NULL when offloaded
  r2_offset TEXT,                                   -- "${r2_key}#L<start>-L<end>" when content offloaded
  token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_session_turns_order ON session_turns(tenant_id, session_id, idx);

-- facts: gbrain 0004_facts.sql verbatim + tenancy + 3-value visibility.  (authoritative: §8.1)
-- NOTE: facts.id is INTEGER AUTOINCREMENT (the one non-nanoid PK) — superseded_by/
-- consolidated_into self-refs + facts_fts content_rowid='id' depend on it.
CREATE TABLE facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL,                  -- replaces gbrain source_id='default'
  scope TEXT, team_id TEXT, user_id TEXT,           -- partition + authorship
  entity_slug TEXT, fact TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact'  CHECK (kind IN ('event','preference','commitment','belief','fact')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team','world')),  -- 3-value (gbrain was 2)
  notability TEXT NOT NULL DEFAULT 'medium' CHECK (notability IN ('high','medium','low')),
  context TEXT,
  valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_until TEXT, expired_at TEXT,
  superseded_by INTEGER REFERENCES facts(id),
  consolidated_at TEXT, consolidated_into INTEGER,
  source TEXT NOT NULL,                             -- 'mcp:extract_facts'|'session:promote'|...
  source_session_id TEXT,                           -- renamed from gbrain source_session
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  is_dream_generated INTEGER NOT NULL DEFAULT 0,    -- anti-loop guard
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_facts_entity_active ON facts(tenant_id, entity_slug, valid_from DESC) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_session       ON facts(tenant_id, source_session_id, created_at DESC) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_since         ON facts(tenant_id, created_at DESC) WHERE expired_at IS NULL;

-- facts_fts external-content + triggers (gbrain 0004_facts.sql:62-84 verbatim); NO tenant_id (JOIN re-check).
CREATE VIRTUAL TABLE facts_fts USING fts5(fact, entity_slug, content='facts', content_rowid='id');
-- + facts_fts_insert/delete/update triggers, identical to gbrain.

CREATE TABLE brain_snapshots (                     -- frozen-snapshot storage (DEFERRED).  (authoritative: §8.1)
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope TEXT,
  label TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  manifest TEXT NOT NULL                            -- JSON: pinned immutable version ids
);
CREATE INDEX idx_snapshots_tenant ON brain_snapshots(tenant_id, created_at DESC);
```

#### 3.1.7 Jobs, ingest & ops — `backfill_runs`, `sources`, `ingest_log`, `token_spend`, `mcp_request_log`

`backfill_runs` (authoritative: §8.1) replaces gbrain's `jobs`; the **Queue** owns message-level dispatch, this row owns enumerator-run state (cursor/anchor/stats/claim). `sources` is the GitHub/source registry (gbrain `0005_platform.sql` + `0009_sync.sql` backoff columns), re-scoped. `ingest_log` and `token_spend` are **consolidated here** (called by §4/§5/§10 but defined in no section).

```sql
-- backfill_runs: fuses gbrain jobs + openbrains imports.   (authoritative: §8.1)
CREATE TABLE backfill_runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source_id TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- session|repo|doc|gmail|ob1|reembed
  direction TEXT NOT NULL DEFAULT 'backfill' CHECK (direction IN ('backfill','incremental')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','failure','cancelled')),
  cursor TEXT,                                      -- importer opaque resume cursor
  anchor TEXT,                                      -- durable anchor (advances only on clean pass)
  stats TEXT,                                       -- JSON {processed,created,skipped,errors,merged}
  attempts INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
  note TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_backfill_status ON backfill_runs(tenant_id, source_id, status);

-- sources: registered source registry + per-source backoff state.
--          (shape from gbrain-cf:migrations/0005_platform.sql:30 + 0009_sync.sql, re-scoped to tenant_id)
CREATE TABLE sources (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT, local_path TEXT,
  last_commit TEXT, last_sync_at TEXT,             -- durable anchor (advances only on clean pass, §4.7)
  config TEXT NOT NULL DEFAULT '{}',
  last_attempt_at TEXT,                            -- gates exponential backoff (0009_sync.sql)
  sync_fail_count INTEGER NOT NULL DEFAULT 0,      -- backoff = base * 2^this; reset on success
  archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX ux_sources_tenant ON sources(tenant_id, id);

-- ingest_log: ingest audit trail. CONSOLIDATED HERE — §4 calls ingest_log.write(tenantId,
--   sourceId, action, fingerprint) (§4.2/§4.8/§4.3) and §10.5 lists it as a Tier-3 audit
--   table, but no section gives DDL. Shape grounded in those call sites + gbrain 0005_platform.sql:17.
CREATE TABLE ingest_log (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  source_id TEXT, source_kind TEXT,
  action TEXT NOT NULL,                            -- 'received'|'skipped'|'indexed'|'duplicate'|'failed'
  fingerprint TEXT, chunks INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ingest_log_tenant_created ON ingest_log(tenant_id, created_at);

-- token_spend: per-tenant model-spend ledger. CONSOLIDATED HERE — §5.1's ENFORCING cost cap
--   ("pre-check the tenant's token_spend budget → 429 before env.AI.run") and §10.5's audit-table
--   list both depend on it, but no section gives DDL. One row per (tenant, window); the embed()/gen()/
--   rerank() chokepoints read the active window and reject with 429+Retry-After when over budget (§5.1).
CREATE TABLE token_spend (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  window TEXT NOT NULL,                            -- the budget window key, e.g. '2026-06' or 'YYYY-MM-DD'
  model TEXT NOT NULL,                             -- '@cf/baai/bge-m3' | '@cf/meta/llama-...' | ...
  surface TEXT,                                    -- 'think'|'ingest'|'migration' (matches AI Gateway metadata)
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  neurons REAL NOT NULL DEFAULT 0,                 -- @cf/ neuron accounting (the v1 billed unit, §10.5/§5f)
  budget_neurons REAL,                            -- per-window cap; NULL = unlimited
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX ux_token_spend_window ON token_spend(tenant_id, window, model);
CREATE INDEX        ix_token_spend_tenant ON token_spend(tenant_id, updated_at DESC);

-- mcp_request_log: per-tools/call ops log.  (authoritative: §10.5; gbrain 0005_platform.sql:96 + tenant_id)
CREATE TABLE mcp_request_log (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,    -- tenant_id is NET-NEW vs gbrain
  token_name TEXT, operation TEXT NOT NULL, latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',               -- 'ok'|'error'
  error_message TEXT,                              -- message only; never params/PII
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_mcp_log_tenant_created ON mcp_request_log(tenant_id, created_at);
CREATE INDEX idx_mcp_log_operation      ON mcp_request_log(operation);
```

#### 3.1.8 Tenancy-column coverage matrix

| Table | `tenant_id` | `team_id` | `user_id` | `scope` | `visibility` | Notes |
|---|---|---|---|---|---|---|
| `documents` | ✓ | ✓ | ✓ | ✓ | — | visibility carried on chunks, not the doc row |
| `chunks` | ✓ | ✓ | ✓ | ✓ | ✓ | default `'world'`; session chunks inherit |
| `chunks_fts`/`facts_fts`/`entity_fts` | — | — | — | — | — | **exception:** external-content; JOIN re-check (§7.4) |
| `pages` | ✓ | ✓ | ✓ | ✓ | ✓ | doc-graph node space; visibility default `'world'` (§6.1) |
| `doc_links`/`tags`/`timeline_entries`/`page_versions` | ✓ | — | — | — | — | hang off a tenant-scoped page |
| `entities` | ✓ | ✓ | — | ✓ | ✓ | KG; scope partitioned (in dedup key), visibility `{team,world}` only (§6.1) |
| `entity_relations`/`entity_mentions` | ✓ | — | — | — | — | KG, tenant-partitioned |
| `orgs` | *is the tenant* | — | — | — | — | **exception:** `id` = `tenant_id` |
| `teams`/`scopes` | ✓ | (self) | — | (self) | — | tenancy structure |
| `memberships` | ✓ | ✓ | ✓ | `allowed_scopes` | — | the user↔tenant join (no `users` table) |
| `api_keys` | ✓ | — | ✓ | — | — | one tenant per key |
| `tenant_shards` | *key* | — | — | — | — | **exception:** keyed by `tenant_id` |
| `memory_use_policy`/`_provenance`/`_review`/`_audit`/`_recall_traces` | ✓ | — | (audit/trace) | — | — | **exception:** `tenant_id` + `target_id` sidecars |
| `sessions` | ✓ | ✓ | ✓ | ✓ | (via tier) | session carries the tier its chunks inherit |
| `session_turns` | ✓ | — | — | — | — | hangs off a tenant-scoped session |
| `facts` | ✓ | ✓ | ✓ | ✓ | ✓ | the full intra-tenant RLS row |
| `backfill_runs`/`sources`/`ingest_log`/`token_spend`/`mcp_request_log` | ✓ | — | — | — | — | ops/jobs, tenant-scoped |

---

### 3.2 Vectorize index design

**v1 provisions TWO Vectorize indexes: `brain-chunks` AND `brain-entities`** (both 1024-dim, cosine, `namespace=tenantId`). `brain-entities` carries entity vectors (canonical name + description) for the v1 `search_entities` scoped vector search (§6.6/§6.7). **Cross-session semantic fact dedup remains deferred to Phase 3.5** — pulling entity vectors into v1 does *not* pull in semantic dedup; v1 entity dedup stays the deterministic key + alias set-union (§6.6).

- **Dimensions / metric.** `--dimensions=1024 --metric=cosine`. Locked to `@cf/baai/bge-m3` (1024-dim; chosen for multilingual coverage + its 60,000-token context window — not the obsolete "8192 vs qwen3's 4096" framing, §5.1). A model swap that changes dims is a P0 guarded by the `embed()` dimension assertion (§5.1).
- **Namespace = `tenantId`** (never `userId`). `ScopedVectorize` hard-wires `namespace: p.tenantId` on every upsert/query (lifted from `openbrains:packages/services/src/deps/vectorize.ts`, renaming `userId`→`tenantId`), so a forgotten namespace is impossible. The namespace is the **same class** of mechanism as a metadata filter (a query-time partition), **not** a documented security boundary — so the tenant guarantee rests on (a) the hard-wired namespace and (b) the mandatory D1 re-check below, not on the namespace being "physical." `tenantId` (not `userId`) is chosen on **team-recall** grounds: `namespace=userId` would physically block a teammate from recalling shared evidence.
- **Vector id ↔ D1 row mapping.** `vector.id == chunks.id` (the stable nanoid). This is load-bearing: a re-embed upserts the **same** id (converges, never duplicates); a delete is by id; the D1 row is the **existence authority** (Vectorize is eventually consistent — never read back to confirm). After every query the kept ids are re-JOINed to live `chunks` via `ScopedDB.getChunksByIds`/`hydrateChunks` and re-checked on `tenant_id`/`scope`/`visibility`/`deleted_at`; cross-tenant or out-of-grant ids are **silently dropped** (no existence leak).
- **Metadata indexed (created BEFORE the first filtered upsert — a Phase-0 ordering rule):** `scope`, `team_id`, `visibility`, `embedding_model` (string type). Reserved budget for `source` within the 10-index cap. **`trust_grade` is deliberately NOT a Vectorize metadata index and is NOT carried in the upsert blob** — it lives **only** in the `memory_use_policy` sidecar (§3.0, §3.1.1, §5.2) so a trust promotion never rewrites a vector. (A per-vector `trust_grade` would go stale on every promotion and consume a scarce metadata-index slot for no gain: it is never used as a Vectorize filter — `foldPartitionFilter` folds only `scope`/`visibility`, and the trust-grade boost runs **post-hydration** on the LEFT-JOINed sidecar value, §5.2/§5.3.)
- **Authoritative upsert-metadata shape.** The upsert metadata blob is exactly `{ documentId, teamId, scope, visibility, userId, embeddingModel, chunkIndex, path, tenant_id }` (`tenant_id` last is belt-and-suspenders over the hard-wired namespace). **This is the authoritative upsert-metadata shape; §4.3 and §4.9 match it verbatim** — the per-vector writes in those sections carry exactly this list (no `trustGrade`; `visibility`/`userId`/`tenant_id` present); this §3.2 form is canonical and carries the `visibility`/`userId` the intra-tenant gate needs. For a **restricted** principal, the granted `scope` (single-grant) or `visibility='world'` is folded **into** the metadata filter (`foldPartitionFilter`, §5.3) so the capped topK budget is spent *inside* the grant — the recall-cliff fix; the D1 re-check stays authoritative.
- **Hard ceilings (Vectorize V2) the design tracks — applied PER INDEX, `brain-chunks` and `brain-entities` independently — NON-BINDING at the v1 scale of 1-2 tenants** (the per-index limits are documented forward-compat headroom + the Phase-N split trigger, §10.7, not a v1 constraint): each index is bounded **independently** by **10 M vectors per index** (the binding §0 ceiling, shared across that index's tenant namespaces; headroom alert at 7 M, §10.7) and **50 000 namespaces per index** (→ one tenant per namespace, so 50k tenants/index before sharding `brain-chunks-{shard}`/`brain-entities-{shard}` via `tenant_shards.chunk_index`/`entity_index` — a deferred Phase-N scale-out, NOT a v1 build). `brain-entities` is far smaller than `brain-chunks` (one vector per canonical entity, not per chunk), so its vector ceiling is not the binding constraint; the namespace ceiling (one tenant/namespace) is shared in form but counted separately per index. Both indexes also each carry **10 metadata indexes per index**, **64 bytes per indexed-metadata value** and **64 bytes per namespace name** (a `scope`/`team_id` slug > 64 B is stored but not filterable → the D1 re-check, not the Vectorize filter, is the authority), **topK max 100** — it drops to 50 only when the query sets `returnValues:true` or `returnMetadata:'all'`; our query sets neither (it returns only `{id,score}`), so the full topK=100 is available **even with a metadata filter** (a metadata filter does not reduce topK).
- **Cost of the second index.** Adding `brain-entities` adds a second per-index storage + query footprint, but the entity index is bounded by *entity* count (one vector per canonical entity row) rather than chunk count, so it is a small fraction of `brain-chunks`. Its **metadata-index budget is independent**: `brain-entities` indexes `scope`, `team_id`, `visibility` (the entity-arm gate columns, §6.1; the KG node space is `{world,team}` only and scope-partitioned) plus `embedding_model` — well within its own 10-index cap, and *not* drawn from `brain-chunks`'s budget. The headroom/alert math of §10.7 now tracks both indexes' vector + namespace ceilings.

```bash
# Provisioning (deploy-order; §10.4). namespace=tenantId is enforced in CODE, not as a metadata index.
wrangler vectorize create brain-chunks --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index brain-chunks --property-name=scope           --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=team_id         --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=visibility      --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=embedding_model --type=string
# NOTE: trust_grade is intentionally NOT indexed here — it lives only in the memory_use_policy
#       sidecar (LEFT-JOINed at read) so a promotion never re-upserts a vector (§3.0/§3.1.1/§5.2).

# brain-entities (v1) — entity vectors for search_entities (§6.6/§6.7). namespace=tenantId in CODE.
wrangler vectorize create brain-entities --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index brain-entities --property-name=scope           --type=string
wrangler vectorize create-metadata-index brain-entities --property-name=team_id         --type=string
wrangler vectorize create-metadata-index brain-entities --property-name=visibility      --type=string
wrangler vectorize create-metadata-index brain-entities --property-name=embedding_model --type=string
```

---

### 3.3 R2 layout (key scheme)

One bucket (`FILES`, binding `FILES`). **Every key is prefixed `${tenantId}/`** — `ScopedR2` rejects any `put`/`get`/`delete` whose key does not start with the principal's tenant prefix (§7.3). The body-offload rule keeps all bulk bytes here, out of D1.

| Key pattern | Holds | Written by |
|---|---|---|
| `${tenantId}/inbox/${date}-${slug}-${hash6}` | raw webhook/upload body (off the hot path immediately) | `POST /ingest` (§4.8) |
| `${tenantId}/${documentId}/body.md` | full extracted markdown (D1 keeps only a ≤2000-char `markdown_preview`) | Batch-Ingest `persist-body` (§4.3) |
| `${tenantId}/sessions/${sessionId}.jsonl` | full session transcript (D1 keeps lean `session_turns`; long turns point back via `r2_offset`) | `capture_turn` / importers (§8.2) |
| `${tenantId}/audit/${yyyymm}.ndjson` | append-only `memory_audit` export (tamper-evidence backstop, SC7) | scheduled cron (§7.6) |

`documents.body_r2_key`, `sessions.r2_key`, and `session_turns.r2_offset` are the D1 pointers back into R2.

---

### 3.4 KV usage

One namespace, `OAUTH_KV` (binding `OAUTH_KV`):

- **OAuth provider state** — `@cloudflare/workers-oauth-provider`'s `/authorize`/`/token`/`/register` and consent state (§7.2).
- **Per-`(tenant,user)` default scope** — pinned under `session-scope:${tenantId}:${userId}` and spliced into tool input by `withSessionDefaultScope` only when the caller omits `scope` (tool-supplied scope always wins, §7.2).

KV is a cache/soft-state layer only; it is never the system of record.

---

### 3.5 Durable Objects usage

One DO class, **`BrainMCP`** (binding `MCP_OBJECT`; SQLite-backed, `migrations[].new_sqlite_classes=["BrainMCP"]`, §10.1):

- It is the **per-tenant MCP server instance** (cf-graph's `MyMCP` pattern). The `/mcp/<slug>` rewrite resolves the slug → `{tenant_id, scope}` against `memberships`/`scopes`; `init()` builds the `Principal`, constructs `ScopedDB`, registers read tools always and write tools only when `!principal.readOnly` (read-only honored at tool-registration time, §7.7).
- It coordinates the live MCP session (connection/`read_only` state) — **not** the system of record. D1 + Vectorize + R2 remain the substrate; the DO holds no canonical brain data.

(Internal Worker↔Workflow, Worker↔Queue, and Worker↔Worker hops use native Workflow/Queue/Service bindings — there is **no** shared internal HTTP secret, §7.8.)

---

### 3.6 Entity-relationship overview

```
                         ┌──────────────────── TENANCY SPINE ────────────────────┐
                         │  orgs(id = tenant_id)                                  │
                         │    ├─< teams ─┐                                        │
                         │    ├─< scopes │   memberships(user_id, team_id, role,  │
                         │    │          │                allowed_scopes) ── Clerk user
                         │    └─< tenant_shards(db_binding, chunk_index)          │
                         └────────────┬───────────────────────────────────────────┘
                                      │  tenant_id stamped on EVERY row below
                                      ▼
  CONTENT / LONG-TERM MEMORY                          DOC-GRAPH (pages = node space)
  documents ──1:N──> chunks ──1:1──> vector(brain-chunks)   pages ──N:M──> pages
     │  (slug,title)   │  id == vector.id   namespace=tenant   (via doc_links: from_id/to_id = pages.id)
     │                 │  └─trigger─> chunks_fts (no tenant_id)  pages ──1:N──> tags
     │                 │                                          pages ──1:N──> timeline_entries
     │ backs           │  trust_grade ◄─LEFT JOIN─ memory_use_policy(target_id)   pages ──1:N──> page_versions
     ▼                 │  visibility/user_id/team_id (intra-tenant RLS)
  pages ◄──────────────┘  (a document backs exactly one page)

  KNOWLEDGE GRAPH (extracted)                          SESSIONS / HOT MEMORY
  entities ──N:M──> entities                           sessions ──1:N──> session_turns (lean; R2 transcript)
     (via entity_relations: from/to_entity_id)            │  finalize → SessionPromoteWorkflow
  entities ──1:N──> entity_mentions ──> (source_kind,        ├─ promote ─> facts ──FTS─> facts_fts (no tenant_id)
        source_id) = BRIDGE to chunk|document|session|page   │                 trust/visibility via memory_use_policy
     entities ─trigger─> entity_fts (no tenant_id)            └─ embed ───> chunks (visibility inherited) ─> brain-chunks

  GOVERNANCE (sidecars, keyed by target_id)            JOBS / OPS (tenant-scoped)
  memory_use_policy / memory_provenance / memory_review   backfill_runs · sources(last_commit/backoff)
  memory_audit (append-only) · memory_recall_traces       ingest_log · token_spend(→429 gate) · mcp_request_log
```

Read it as: the **tenancy spine** (top) stamps `tenant_id` on everything; **documents→chunks→vectors** is the long-term retrieval path (vector id == chunk id, D1 authoritative); **a document backs a page**, and `pages` is the sole node space for `doc_links`; the **KG** (`entities`↔`entity_relations`) bridges to content via `entity_mentions`; **sessions→facts** is hot memory and **sessions→chunks** is the long-term arm; `memory_*` sidecars and the jobs/ops tables hang off targets and the tenant respectively.

---

#### Code references
- gbrain-cf:migrations/0001_init.sql — `pages`/`links`/`tags`/`timeline_entries`/`page_versions`/`content_chunks` shapes + the FTS5 external-content trigger pattern reused for `chunks_fts`/`entity_fts`/`facts_fts`; basis for the §3.1.2 `pages` consolidation.
- gbrain-cf:migrations/0002_search.sql — `embedded_at`/`embed_error` per-chunk staleness columns carried onto `chunks` (§3.1.1).
- gbrain-cf:migrations/0004_facts.sql — `facts` DDL (INTEGER-autoincrement id, kind/visibility/notability/confidence, validity window, `superseded_by`/`consolidated_into` lineage, `facts_fts` + triggers) ported verbatim into §3.1.6.
- gbrain-cf:migrations/0005_platform.sql — `ingest_log`, `sources`, `mcp_request_log` base shapes (re-scoped to `tenant_id`) for §3.1.7; `jobs` is the prior-art `backfill_runs` replaces.
- gbrain-cf:migrations/0009_sync.sql — `sources.last_attempt_at`/`sync_fail_count` backoff columns + `idx_pages_source` for the source-sync registry (§3.1.7).
- cf-graph:apps/graph/src/api/db/schema.ts — Drizzle `documents`/`chunks` baseline (re-scoped `workspace_id`→`tenant_id`, + nanoid stable ids, per-row embedding state) and the `api_keys`/`cli_auth_sessions`/`cli_refresh_tokens` shapes (§3.1.1/§3.1.4); `kg_entities`/`kg_relationships` are the flatter prior art the openbrains-shaped `entities`/`entity_relations` supersede.
- openbrains:packages/convex/convex/schema.ts — `entities`/`entity_relations`/`entity_mentions` (canonical-name + aliases + confidence + evidence), the `memory_*` governed-memory sidecars (`memory_use_policy`/`memory_provenance`/`memory_review`/`memory_audit`/`memory_recall_traces`), `projects`→`scopes`, and `imports`→`backfill_runs` — re-expressed as D1 with `tenant_id` + nanoid ids (§3.1.3/§3.1.4/§3.1.5/§3.1.7).
- openbrains:packages/services/src/deps/vectorize.ts — `createVectorizeClient` hard-wiring `namespace` per call; basis for `ScopedVectorize` (§3.2, `userId`→`tenantId`).

---

## 4. Ingestion & Document Loading

This section specifies the **durable, multi-tenant ingestion pipeline** for the Brain Platform: how bytes from any source (uploaded files, pre-chunked payloads, webhook pushes, and resumable backfill from Gmail/OB1/GitHub/session exports) become tenant-scoped, deduplicated, embedded, KG-extracted, and dual-indexed rows in D1 + Vectorize + FTS5, with R2 holding the bodies.

It is the realization of plan §4.1 and the Stage-3 **Batch-Ingest Workflow** of plan §6, and it leads with the chosen mechanism and the rejected alternative at every fork. The backbone is a near-verbatim port of cf-graph's durable Workflow (`cf-graph:apps/graph/src/api/workflows/ingestion.ts`), re-scoped from `workspace_id` to `tenant_id` and stamped with per-row embedding-model state that cf-graph lacks.

> **Scope boundary.** This section owns the *write path* up to and including "row is searchable in both arms." The **read/retrieval path** (RRF fusion, rerank, `think`) is §4.3. The **Queue/Enumerator backfill spine** that *feeds* this Workflow is §6; here we specify only the contract this Workflow exposes to that spine. Isolation mechanics (`ScopedDB`/`ScopedVectorize`/`ScopedR2`) are defined in §5 and consumed here.

---

### 4.0 Design decisions (chosen vs rejected)

| Concern | Chosen | Rejected | Why |
|---|---|---|---|
| Binary→markdown | `ai.toMarkdown([{name, blob}])` via `CloudflareDocumentConverter` (`cf-graph:apps/graph/src/api/services/cloudflare.ts`) | client-side parsers, AutoRAG-managed parse | Only correct CF-native PDF/DOCX/HTML/CSV path; AutoRAG can't express our schema/tenancy |
| Orchestration | Cloudflare **Workflow** per document, step-resumable (`cf-graph:.../workflows/ingestion.ts`) | cron-DB-jobs poller (`gbrain-cf:src/jobs.ts`), inline request handler | Per-phase retries/backoff; survives Worker eviction; stays within the 10,000-step default (raisable to 25,000 via `workflows[].limits.steps` on Workers Paid) |
| Dedup key | `fingerprint = sha256(normalizeForFingerprint(markdown))` (`openbrains:packages/ingest/src/fingerprint.ts` + `normalize.ts`) | raw `sha256(bytes)` (`gbrain-cf:src/util.ts` `sha256Hex` of raw) | Formatting-insensitive: whitespace/case drift on re-capture still dedups |
| Chunking | route by source: paragraph-packing for md/text (`gbrain-cf:src/util.ts` `chunkText`, TARGET≈1200) / sliding-window 512·64 sentence-aware for long PDFs (`cf-graph:.../ingestion.ts` `chunkText`) | one fixed strategy | md gets semantically clean, trigger-friendly chunks; PDF prose gets overlap |
| Embed contract | single never-throw chokepoint returning `null` (`gbrain-cf:src/ai.ts` `embed`) + pre-call token-budget + dim assertion (`openbrains:packages/ingest/src/embeddings/workers-ai.ts`) | per-call-site `env.AI.run` | degradation-to-keyword-only is uniform; dim/budget guard is unavoidable |
| Chunk ids | stable `nanoid` (`cf-graph:.../ingestion.ts`) | delete+recreate autoincrement (`gbrain-cf:src/engine.ts` `putPage`) | re-embed targets the same vector id; no orphan churn |
| FTS sync | external-content + triggers (`gbrain-cf:migrations/0001_init.sql`) | manually-populated table (`cf-graph:apps/graph/migrations/0009_add_fts_indexes.sql`) | triggers keep `chunks_fts` correct without explicit inserts |
| Importer SDK | `Importer{begin/nextBatch/finalize}` (`openbrains:packages/ingest/src/sources/types.ts`) lifted verbatim, Convex orchestrator dropped | rebuild per source | platform-neutral already; `runImporterContract` proves each source |

---

### 4.1 The ingestion contract (trigger surface)

Every ingress (upload, pre-chunked, webhook, backfill-Queue consumer) converges on **one Workflow** with one params shape. This is the cf-graph `IngestionParams` (`cf-graph:apps/graph/src/api/workflows/ingestion.ts:17`) re-scoped to the Brain Platform tenancy model.

```ts
// packages/shared/src/ingest.ts
export interface IngestionParams {
  // --- tenancy (threads through every row, every vector namespace, every R2 key) ---
  tenantId: string;            // hard boundary; Vectorize namespace; D1 predicate
  teamId?: string;             // metadata filter
  scope?: string;              // project/client sub-partition
  userId: string;              // authorship

  // --- identity / provenance (fuses cf-graph + gbrain provenance columns) ---
  documentId: string;          // pre-allocated nanoid; deterministic instance id below
  filename: string;
  path?: string;
  contentType: string;         // must pass ALLOWED_CONTENT_TYPES
  r2Key: string;               // body lives here, NOT in D1
  sourceKind?: string;         // 'upload' | 'webhook' | 'gmail' | 'ob1' | 'github' | 'chatgpt' | 'claude-code'
  sourceId?: string;
  sourceUri?: string;
  ingestedVia: string;         // 'rest' | 'mcp' | 'backfill-queue'

  // --- dedup / re-embed ---
  fingerprint: string;         // sha256(normalizeForFingerprint(markdown)) — computed pre-extract for pre-chunked, post-extract for binary
  embeddingModel: string;      // '@cf/baai/bge-m3' for fresh; 'pending' for imported foreign-embedding rows

  // --- chunking ---
  strategy?: 'paragraph' | 'sliding';  // default chosen by contentType (§4.4)
  maxTokens?: number;          // sliding window size (default 512)
  overlap?: number;            // sliding overlap (default 64)

  // --- pre-chunked fast path (§4.6) ---
  preChunked?: Array<{ content: string; headingPath?: string; metadata?: Record<string, unknown> }>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
```

**Idempotent trigger (locked).** Callers create the Workflow with a **deterministic instance id** keyed on tenant + fingerprint, so re-delivery of the same Queue message or a double-clicked upload is a no-op (CF rejects a duplicate instance id). This replaces cf-graph's `ingest-${docId}` (`cf-graph:apps/graph/src/api/services/documents.ts:759`) with a content-addressed id:

```ts
const instanceId = `ingest-${tenantId}-${fingerprint}`;          // idempotent under at-least-once delivery
await env.INGESTION_WORKFLOW.create({ id: instanceId, params });  // throws DuplicateInstance → swallow as "already in flight"
```

For deliberate reprocess (content changed, model changed) the caller first deletes the old document's vectors/chunks, then creates `ingest-${tenantId}-${fingerprint}-${Date.now()}` — the same "deliberate non-idempotent" escape hatch cf-graph uses for reprocess (`cf-graph:apps/graph/src/api/services/documents.ts` reprocess path at line 288).

---

### 4.2 Document-level dedup (skip-unchanged)

Dedup is a **gate before Workflow creation**, not inside it — so an unchanged re-upload never burns a single embedding call. It combines gbrain's skip-unchanged mechanism (`gbrain-cf:src/engine.ts` `putPage` content_hash compare) with openbrains' formatting-insensitive normalization (`openbrains:packages/ingest/src/normalize.ts`).

```
function fingerprintFor(extractedMarkdown):
  return sha256(normalizeForFingerprint(extractedMarkdown))   // openbrains: trim → collapse ws → lowercase → sha256

on ingress(tenantId, candidateBody, sourceId):
  fp = fingerprintFor(candidateBody)
  existing = ScopedDB(p).documents.findByFingerprint(fp)      // WHERE tenant_id=? AND fingerprint=?
  if existing and existing.status == 'indexed':
     ingest_log.write(tenantId, sourceId, action='skipped', fingerprint=fp)
     return { documentId: existing.id, status: 'skipped' }    // gbrain putPage 'skipped' shape
  ... allocate documentId, R2 put, create Workflow ...
```

**Edge case — fingerprint of a binary.** For PDFs/DOCX the fingerprint can only be computed *after* `toMarkdown` (the bytes differ but the extracted text may be identical). So binaries take the two-phase route: (1) cheap pre-check on `sha256(raw bytes)` to skip byte-identical re-uploads; (2) the canonical markdown fingerprint is computed in the Workflow's `extract-text` step and the document row is updated; if a *different* document with the same markdown fingerprint already exists, the Workflow marks this one `status='duplicate'` and aborts before embedding. Pre-chunked and text payloads compute the markdown fingerprint at ingress (no extraction needed).

**Item-grained dedup (backfill).** The importer's per-item `fingerprint` (`openbrains:packages/ingest/src/sources/types.ts` `BrainBundleThought.fingerprint`, produced by `openbrains:packages/ingest/src/fingerprint.ts`) handles thought-grained dedup inside a multi-item source, independent of the document-level gate. The `(tenant_id, scope, fingerprint)` unique index on `documents`/`chunks` is the backstop against a racing duplicate Queue message that slips past the soft check.

---

### 4.3 The Batch-Ingest Workflow (step-by-step)

This is `cf-graph:apps/graph/src/api/workflows/ingestion.ts` ported near-verbatim. The step structure, retry/backoff configs, and the **batching constants tied to hard limits** are preserved exactly (they encode CF caps); the diff is: `workspace_id`→`tenant_id` everywhere, `Scoped*` wrappers instead of raw bindings, per-row `embedded_at`/`embedding_model` stamping, body-to-R2 + preview-to-D1, and strategy-routed chunking.

```
class BatchIngestWorkflow extends WorkflowEntrypoint<Bindings, IngestionParams>:
  run(event, step):
    p = principalFromParams(event.payload)   // §5d: build Principal from explicit tenant_id, go through Scoped*
    db  = ScopedDB(p)                         // injects AND tenant_id=? ; resolves shard binding
    vec = ScopedVectorize(p)                  // hard-wires namespace=tenantId ; resolves shard index
    r2  = ScopedR2(p)                         // prefixes keys with tenantId

    step.do('status-processing'): db.documents.setStatus(documentId, 'processing')

    # ── Step 1: extract → markdown, persisted to R2 (retries:3, backoff exp, timeout 2m) ──
    # CRITICAL (iter-3): a non-stream step.do() output is hard-capped at 1 MiB. Returning the
    # full extracted markdown would fail this step for any document whose text exceeds ~1 MiB.
    # So extract-text PERSISTS the body to a staging R2 key inside the step and returns only the
    # key + byte size; every downstream step reads the body back from R2 rather than threading it
    # through a step return value. (cf-graph returned full markdown in-memory; we cannot.)
    extract = step.do('extract-text', {retries:{limit:3,delay:'5s',backoff:'exponential'}, timeout:'2m'}):
        if preChunked: return { stagingKey: null, byteLength: 0 }    # fast path skips extraction (§4.6)
        obj = r2.get(r2Key)                                     # ScopedR2 → key is ${tenantId}/...
        markdown = (contentType in (text/plain, text/markdown))
                     ? obj.text()
                     : ai.documentConverter.toMarkdown(filename, obj.blob())  # cf-graph CloudflareDocumentConverter
        if empty(markdown): return { stagingKey: null, byteLength: 0 }
        stagingKey = `${tenantId}/${documentId}/body.md`
        r2.put(stagingKey, markdown)                            # body → R2 here; persist-body reads it back (no double-write)
        return { stagingKey, byteLength: byteLengthUtf8(markdown) }   # ≪ 1 MiB return: just the key + size

    if not preChunked and extract.stagingKey == null:
        step.do('mark-failed-empty'): db.documents.fail(documentId, 'empty-extraction'); return {status:'failed'}

    # canonical fingerprint + body-offload (NEW vs cf-graph: cf-graph wrote full markdown into D1.markdown).
    # Reads the body back from the staging R2 key (NOT from a step return) so this step's I/O stays bounded.
    step.do('persist-body'):
        if not preChunked:
            markdown = r2.get(extract.stagingKey).text()        # read-back, not a cross-step variable
            fp = sha256(normalizeForFingerprint(markdown))
            dup = db.documents.findByFingerprint(fp)
            if dup and dup.id != documentId: db.documents.setStatus(documentId,'duplicate'); return STOP
            db.documents.update(documentId, { fingerprint: fp,
                                              markdownPreview: markdown.slice(0, 2000),  # preview only in D1
                                              bodyR2Key: extract.stagingKey })           # body already at this key

    # ── Step 2: chunk (strategy-routed, §4.4) — content staged to R2, only metadata returned ──
    # Returning every chunk's `content` would re-emit ~the whole document and blow the same 1 MiB
    # step-output cap (often for documents far smaller than 1 MiB, since the array repeats the body).
    # So chunk-text STAGES chunk content to R2 (one JSON object of {id→content}) and returns only the
    # lean per-chunk metadata (ids, indices, heading paths, token counts) the later steps need.
    chunkMeta = step.do('chunk-text'):
        markdown = preChunked ? null : r2.get(extract.stagingKey).text()   # read-back, not a cross-step variable
        texts = preChunked ? preChunked
              : (strategy=='paragraph') ? paragraphChunk(markdown)               # gbrain chunkText, TARGET=1200
                                        : slidingChunk(markdown, maxTokens=512, overlap=64)  # cf-graph chunkText
        records = texts.map((c,i) => ({ id: nanoid(), chunkIndex: i,
                                        headingPath: c.headingPath ?? null,
                                        tokenCount: ceil(c.content.length/4),
                                        embeddingModel: '@cf/baai/bge-m3', embeddingDims: 1024 }))
        r2.put(`${tenantId}/${documentId}/chunks.json`,        # stage content keyed by chunk id
               JSON({ for c,i in texts: records[i].id → c.content }))
        return { records, contentStagingKey: `${tenantId}/${documentId}/chunks.json` }  # lean: no `content` blobs

    chunkRecords = chunkMeta.records                            # ids + per-chunk metadata only (no content)

    # ── Step 3: store chunks + FTS (batch 10 — D1 100-param limit) ──
    # Reads chunk content back from the staging R2 object (NOT from the step return) and writes the
    # canonical chunk rows; after this step the durable content authority is D1.chunks.content.
    CHUNK_DB_BATCH_SIZE = 10                                # cf-graph constant; 8 params/row → ≤12, use 10
    for batch in chunks_of(chunkRecords, 10):
       step.do(`store-chunks-batch-${i}`):
          staged = r2.get(chunkMeta.contentStagingKey).json()   # { chunkId → content }
          db.chunks.insertMany(batch.map(c => ({...c, content: staged[c.id], tenantId, documentId,
              teamId, scope, userId,
              visibility: 'world'})))                     # iter-3: ingested-doc chunks default 'world'; session-import path uses session.visibility (§3.1.6/§8.3)
          # FTS5 is auto-synced by triggers (gbrain external-content) — NO manual chunks_fts insert (cf-graph did manual)

    # ── Steps 4..N: embed (batch 50) + upsert via ScopedVectorize ──
    # Reads content back from D1 by id (store-chunks already ran, so rows exist) rather than from any
    # step return — keeps embed-batch's input bounded and avoids re-emitting content through Workflow state.
    EMBED_BATCH_SIZE = 50                                   # Workers AI bge-m3 per-call cap
    for batch in chunks_of(chunkRecords, 50):
       step.do(`embed-batch-${i}`, {retries:{limit:5,delay:'10s',backoff:'exponential'}, timeout:'60s'}):
          rows = db.chunks.getContentByIds(batch.map(c=>c.id))  # { id, content } from D1 (existence authority)
          vecs = embed(env, rows.map(r=>r.content))         # gbrain ai.ts chokepoint; returns null on failure
          if vecs == null: throw Error('embed unavailable')  # let Workflow retry (don't silently skip on write path)
          assert all(v.length == 1024 for v in vecs)         # openbrains dim assertion
          vec.upsert(batch.map((c,j) => ({ id: c.id, values: vecs[j],
              metadata: { documentId, teamId, scope, visibility: 'world', userId,
                          embeddingModel:'@cf/baai/bge-m3', chunkIndex: c.chunkIndex, path, tenant_id } })))
              # canonical upsert-metadata shape (§3.2): NO trustGrade — trust lives only in the
              # memory_use_policy sidecar (LEFT-JOINed at read), so a promotion never re-upserts a vector.
          db.chunks.stampEmbedded(batch.map(c=>c.id), embeddedAt: now)   # per-row staleness (NEW vs cf-graph)

    # ── Steps N+1..M: KG extract (batch 5 chunks/LLM call) ──  → handed to §4.5

    # ── finalize ──
    step.do('finalize'):
       db.documents.update(documentId, { status:'indexed', chunkCount: chunkRecords.length, ingestedAt: now })
       ingest_log.write(tenantId, sourceId, action:'indexed', chunks: chunkRecords.length)
```

**Why the constants are load-bearing (do not "tune away"):**
- **1 MiB non-stream step-output cap** — a `step.do()` that returns a plain value is hard-capped at **1 MiB** of serialized output (Workflows limits). This is why `extract-text` returns only a staging `r2_key` + byte size and `chunk-text` returns only per-chunk metadata (ids/indices/heading paths/token counts) with content staged to R2 — never the extracted markdown or chunk `content` blobs. The documented escape hatch for genuinely large step output is returning a `ReadableStream<Uint8Array>`; we use the R2-staging form so the same body is reused by `persist-body` without a second write. (cf-graph returned full markdown/chunk arrays in-memory; on the Brain Platform that path fails the cap for large docs and is the exact SC5 case below.)
- `CHUNK_DB_BATCH_SIZE=10` — D1 caps a statement at **100 bound parameters**; the lean chunk row is ~8 params, so 10 rows is the safe batch (`cf-graph:.../ingestion.ts:135`).
- `EMBED_BATCH_SIZE=50` — Workers AI bge-m3 accepts up to ~100 texts/call; 50 keeps payload + latency bounded (`cf-graph:.../ingestion.ts:163`).
- `KG_BATCH_SIZE=5` — one LLM call per 5 chunks bounds extraction cost (`cf-graph:.../ingestion.ts:204`).
- Each `step.do(\`...-${i}\`)` is a **named, resumable step**: a Worker eviction mid-embed re-runs only the failed batch, not the whole document. Total steps per document = `1 + 1 + 1 + ceil(n/10) + ceil(n/50) + ceil(n/5) + 1` where `n` = chunk count.

**Chunks-per-document ceiling + deterministic split rule (iter-3 completeness fix — keeps "at scale"/SC5 defensible for the giant-upload case).** Two distinct limits bound a single oversized upload, and the split rule keys on **both**:
- **Step budget.** The step total grows with `n`, so a single oversized upload could approach the **10,000-step default** (raisable to 25,000 via `workflows[].limits.steps` on Workers Paid); this design stays within the 10k default and does not assume the 25k ceiling is configured. The Enumerator's items-per-run bound (§8.6) bounds a *source*, not a *single document*. So the Workflow enforces a hard ceiling **`MAX_CHUNKS_PER_DOC = 4000`** (at `ceil(4000/5)=800` KG steps the dominant term, total stays well under 10k).
- **Extracted-text byte size.** Because `extract-text` returns only an `r2_key` and `chunk-text` stages content to R2, the per-step 1 MiB cap no longer bounds document size on its own — but a giant body still inflates store/embed/KG work. So the split *also* keys on the extracted-text byte size measured at extract time (`extract.byteLength` of the R2 body), enforcing **`MAX_BODY_BYTES = 8 MiB`** per part; a body exceeding it is split on chunk boundaries even when the chunk count is under `MAX_CHUNKS_PER_DOC`. (Keying the split only on chunk count, as the prior draft did, would not prevent an 8-MiB body of few-but-huge chunks from over-loading a single part.)

A document that would exceed *either* ceiling is **split deterministically at chunk time** into multiple `documents` rows sharing a `parent_document_id` (and a `part_index`), each its **own** Batch-Ingest Workflow with its own `ingest-${tenantId}-${fingerprint}#part${k}` instance id (so the split is idempotent under re-delivery). Splits happen on chunk boundaries (never mid-chunk), the parent row records `chunk_count`/`part_count` for reassembly, and citations resolve to `(parent_document_id, part_index)`. This makes the step budget *and* the per-part byte footprint a function of fixed per-part ceilings, not of upload size, so SC5 "durable at scale" holds for an arbitrarily large single upload, not only for bounded multi-item sources.

**Failure FSM** (preserved from cf-graph): `pending → processing → indexed | failed | duplicate`. On any permanently-failed step the catch block writes `status='failed'` + `errorMessage` and re-throws so the instance is marked errored (`cf-graph:.../ingestion.ts:398-420`).

**Eventual-consistency rule (plan §4.2 / §5c).** Vectorize upserts are eventually consistent. The Workflow never reads back a vector to confirm it; **D1 is the existence authority**. The vector `id == chunk.id` (deterministic), so a retried upsert converges rather than duplicating. Deletes (reprocess/re-embed) are idempotent and never assumed immediately visible — the read path's D1 re-check drops any stale-but-not-yet-deleted vector.

---

### 4.4 Chunking — route by source type

The `strategy` param (default derived from `contentType`) selects between two ported chunkers. Both are verified-existing code.

- **`paragraph`** (default for `text/markdown`, `text/plain`, sessions, freeform): greedy paragraph-packing toward `CHUNK_TARGET≈1200` chars, never splitting a paragraph unless it exceeds 2× target, **no overlap** — `gbrain-cf:src/util.ts` `chunkText`. Chosen for markdown because paragraph-aligned chunks are semantically cleaner and play well with FTS triggers.
- **`sliding`** (default for `application/pdf`, `application/vnd...docx`, long `text/html`): sliding window `maxTokens=512` / `overlap=64`, **sentence-aware** (breaks at `. ` past the halfway mark) — `cf-graph:apps/graph/src/api/workflows/ingestion.ts:433` `chunkText`. Chosen for `toMarkdown` output of long prose where overlap recovers cross-boundary context.

`headingPath` is carried per chunk where the chunker can derive it (markdown headings) and stored on the lean `chunks` row for the search-result UI; it is **not** the body.

---

### 4.5 KG extraction (durable, JSON-salvaging) — bridge to §4.5/Graph

Within the same Workflow, chunks are batched 5-per-LLM-call and extracted, then deduped and written into the **openbrains-shaped** entity tables (the algorithms themselves are detailed in the Graph section; here is the ingestion-side wiring). Like `embed-batch`, each KG step reads its chunk **content back from D1 by id** (`db.chunks.getContentByIds`) rather than from a step return — the 1 MiB step-output cap (§4.3) means content never rides through Workflow state.

- Extractor: `@cf/meta/llama-3.1-8b-instruct` with the canonical-name/typed-kind/confidence prompt + **truncation-salvage** `extractJsonFromText` (3 strategies: direct parse → outer-brace slice → backtrack to last complete `}` and auto-close brackets) — `cf-graph:apps/graph/src/api/workflows/kg-extraction.ts` `extractEntitiesFromChunk` / `extractJsonFromText`. Add openbrains' `response_format:{type:'json_object'}` as belt-and-suspenders.
- Dedup-by-`LOWER(name)` within the run, then `ON CONFLICT DO UPDATE` against `entities` unique `(tenant_id, kind, canonical_name)`, union of `source_chunk_ids`, `mention_count += n` — the cf-graph store-kg step (`cf-graph:.../ingestion.ts:245-375`) re-scoped to `tenant_id`.
- **v1 scope (plan §4.4):** in v1 the Workflow **does** embed entities (`canonical_name` + `description` via `@cf/baai/bge-m3`) and **upserts to `brain-entities`** — the `embed-entities` step (§6.2) — alongside the deterministic entity/relation/mention rows + `entity_fts`. The `brain-entities` index is provisioned in v1 (§10.1/§10.4). **Only cross-session *semantic* dedup** over those entity vectors is **deferred to Phase 3.5**; v1 dedup stays deterministic (`LOWER(name)` + `ON CONFLICT`, above).
- Failure isolation: a chunk whose LLM output won't parse is logged and **skipped** (returns empty entities) — never aborts the document (`cf-graph:kg-extraction.ts:100-104`).

---

### 4.6 Pre-chunked fast path

For callers that already hold chunks (session transcripts split upstream, OB1 thought rows, "store sessions from multiple sources"), `IngestionParams.preChunked` is set and the Workflow **skips extract + chunk** entirely, going straight to store→embed→KG. This is `cf-graph:apps/graph/src/api/services/documents.ts:523` `ingestChunked` lifted into the Workflow so the pre-chunked path gets the same durability, batching, and tenant-stamping as the binary path (cf-graph ran `ingestChunked` inline outside the Workflow; we route it through the Workflow for resumability and uniform re-embed staleness). The document row still gets a `bodyR2Key` (concatenated chunks → R2) and a preview; `r2Key` may be `''` only if no original artifact exists.

---

### 4.7 Multi-source connectors (Importer SDK) — contract this section depends on

The backfill **Enumerator** (full mechanics in §6) drives sources through the openbrains `Importer` contract, lifted verbatim minus the Convex orchestrator:

```ts
interface Importer {                         // openbrains:packages/ingest/src/sources/types.ts
  readonly source: string;
  begin(opts:{resumeCursor?:string}): Promise<{cursor: string|null}>;
  nextBatch(cursor: string|null): Promise<{items: readonly BrainBundleThought[]; nextCursor: string|null}>;
  finalize(): Promise<void>;
}
```

Each importer is proven against `runImporterContract` (`openbrains:packages/ingest/src/sources/contract.ts`), which enforces the two invariants that make resumable enumeration safe: **(1)** a terminal cursor is `null`; **(2)** an empty batch with a non-null cursor is a contract violation (would loop forever). Lifted verbatim: Gmail (`openbrains:packages/ingest/src/sources/gmail.ts`), OB1 (`openbrains:packages/ingest/src/sources/ob1.ts`), GitHub-sync (`gbrain-cf:src/sync.ts` + `github.ts`). Net-new on the same contract: ChatGPT and Claude-Code session importers, modeled on OB1.

**Foreign-embedding rule (locked).** OB1 stores 1536-d OpenAI vectors. The importer **drops them entirely** — no copy, no projection — and emits `embeddingModel:'pending'`, `embeddingDims:0` (`openbrains:packages/ingest/src/sources/ob1.ts:26-27,153`). The Batch-Ingest Workflow (or the §6 re-embed sweep) re-embeds at bge-m3 1024d. Same-dimension is **not** interchangeability; cross-model cosine is meaningless, so foreign vectors are never reused. New importers (ChatGPT/Claude-Code) follow the identical pattern: parse untrusted export defensively (per-field narrowing, like `ob1.ts` `asRecord`/`asStringArray`), drop any embeddings, emit `'pending'`.

**Resumable cursor/anchor discipline (GitHub & long sources).** From `gbrain-cf:src/sync.ts`: the *cursor* (in-flight progress) lives in the run row; the durable *anchor* (`sources.last_commit`/`last_sync_at`) advances **only on a clean full pass**. A per-file fetch failure pushes the path to `cursor.failed` (retried next tick) and **never advances the anchor** — no silent page loss. A truncated GitHub tree refuses to record a new full anchor. `MAX_FILES_PER_TICK=150` bounds work per step. This discipline is preserved unchanged, re-scoped to `tenant_id`.

#### 4.7.1 Importer INPUT schemas (the parse contract — iter-3 completeness fix)

`ob1.ts` is only the importer **output** contract (`BrainBundleThought`). The flagship G6 / Persona A promise — "capture every Claude Code / ChatGPT session" — also needs the **input** export shapes the net-new importers must parse. Both exports are **untrusted JSON/JSONL**: every field is narrowed from `unknown` with the same `asRecord`/`asString`/`asStringArray`/`asNumber` guards `ob1.ts` uses, a missing/mistyped field skips that record (never throws), and the importer emits `embeddingModel:'pending'`/`embeddingDims:0` (no foreign embeddings).

**ChatGPT — `conversations.json` (mapping-tree shape).** A top-level **array of conversations**; each conversation is an object with `title`, `create_time`, `update_time`, and a **`mapping`** object keyed by node-id. Each mapping node is `{ id, parent, children:[ids], message? }`; a `message` is `{ id, author:{role:'user'|'assistant'|'system'|'tool'}, create_time, content:{ content_type:'text'|..., parts:[string|...] } }`. Parse rule: pick the **active leaf** (`current_node` when present, else the deepest reachable leaf) and **walk `parent` pointers to the root** to recover the linear turn order (the tree encodes edits/regenerations as branches; the parent-walk takes the chosen path). Each visited node with a non-empty text `message` becomes one `session_turns` row: `role ← author.role`, `content ← parts.filter(isString).join('\n')`, `idx ← position in the reconstructed linear order`, `created_at ← message.create_time`. Conversation → one `sessions` row: `client='chatgpt'`, `source_session_id ← conversation.id`, `title`, `started_at ← create_time`. Non-text parts (images/tool blobs) are dropped from the inline turn but retained in the R2 transcript.

**Claude Code — session transcript (JSONL message records).** **One JSON object per line** (a `.jsonl` transcript), append-ordered. Each line is a record `{ type:'user'|'assistant'|'system'|'summary'|..., uuid, parentUuid, timestamp, sessionId, cwd?, message? }` where `message` mirrors the Anthropic Messages shape `{ role, content: string | Array<{type:'text'|'tool_use'|'tool_result', text?, ...}> }`. Parse rule: read line-by-line (records already arrive in causal order; `parentUuid` is a backstop for reordering), keep records whose `type ∈ {user, assistant}` and whose `message.content` yields non-empty text (`content` is either a string or the concatenation of its `type:'text'` blocks; `tool_use`/`tool_result` blocks are summarized to a short marker inline and kept verbatim in the R2 transcript). Each kept record → one `session_turns` row: `role ← message.role`, `content ← extracted text`, `idx ← line ordinal`, `created_at ← timestamp`. The file → one `sessions` row: `client='claude-code'`, `source_session_id ← sessionId` (constant across the file), `started_at ← first timestamp`, `title ← first user line (truncated)`.

Both importers stream their records through `nextBatch(cursor)` where the **cursor is a byte/line offset into the export** (resumable mid-file), satisfy `runImporterContract` (terminal cursor `null`; no empty-batch-with-non-null-cursor), and the resulting turns flow into the §8.2 path-2 batch-importer ingress, then promote+embed via §8.3. (Export formats are vendor-controlled and may drift; the per-field guards degrade a drifted field to "skip this record," never a hard failure — the same robustness posture as `ob1.ts`.)

---

### 4.8 Webhook ingress (`POST /ingest`)

Ported from `gbrain-cf:src/routes-platform.ts` `handlePlatformRoutes`, generalized to multi-tenant and to enqueue onto a real Queue instead of a dead D1 job:

```
POST /ingest:
  auth = resolvePrincipal(request)                 # §5: OAuth/JWT | machine token | API key → Principal (tenantId baked in)
  require auth.capabilities ∋ 'write' and not auth.readOnly   # capability axis, not allowedScopes
  contentType = normalizeContentType(header)        # md | plain | json ; reject otherwise → 415
  body = await request.text()
  if len(body) == 0 → 400 ; if len(body) > 256*1024 → 413     # gbrain 256KB cap
  fp = sha256(normalizeForFingerprint(body))
  r2Key = `${tenantId}/inbox/${date}-${slug}-${fp.slice(0,6)}`
  ScopedR2(auth).put(r2Key, body)                   # body off the hot path immediately
  ingest_log.write(tenantId, sourceId, action='received', fingerprint=fp)   # audit row
  BACKFILL_QUEUE.send({ tenantId, sourceId, runId, kind:'doc', payloadRef:r2Key, fingerprint:fp })
  return 202 { fingerprint, sourceId, message:'queued' }
```

Differences from gbrain: tenant comes from the resolved `Principal` (not a global bearer); the body goes to **R2 not the job row** (no 256KB-in-D1 storage); dispatch is a **Queue message** (gbrain faked async with a `queued` D1 `jobs` row because it had no Queues). The 256KB cap, content-type normalization (`normalizeContentType`), and `inbox/<date>-<slug>-<hash6>` key convention are preserved.

---

### 4.9 Data written (lean rows; bodies in R2)

The ingest path writes only the **index columns**; full markdown/transcript stays in R2 (plan §3 body-offload rule, a correctness requirement for the 10 GB single-D1 budget). DDL is owned by `packages/db`; the ingest-relevant shape:

> **Authoritative `documents`/`chunks` DDL.** This is the single canonical definition of the `documents` and `chunks` tables and the `chunks_fts` virtual table for the whole document; §5.2 reproduces a *read-subset* of the columns the search path touches and does **not** redefine the tables, and §5.3's `getChunksByIds` JOINs the columns the retrieval result needs (`slug`/`title`/`source_id` from `documents`; `trust_grade` from the `memory_use_policy` sidecar of §7.5) rather than re-declaring them on `chunks`. (iter-2 schema-consolidation fix — the earlier §4.9/§5.2 divergence is removed.)

```sql
-- documents: index + provenance + dedup, NO full body.
-- slug/title are carried HERE (the search result's citation fields come from a
-- chunks→documents JOIN, not from chunks columns).
CREATE TABLE documents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, team_id TEXT, scope TEXT, user_id TEXT NOT NULL,
  slug TEXT NOT NULL, title TEXT,                                      -- citation fields (JOIN target for §5.3)
  -- slug is derived by EVERY ingest path before insert (the upload/binary path uses
  -- the same slug as its r2Key `${tenantId}/inbox/${date}-${slug}-...`; the pre-chunked
  -- / session-import paths derive a deterministic slug from source_id+title, uniquified
  -- within (tenant_id, slug) by a numeric suffix on collision). A NOT NULL slug is thus
  -- always satisfied; see residual note on uniquification for purely-derived imports.
  content_type TEXT, body_r2_key TEXT, markdown_preview TEXT,          -- preview only; body via body_r2_key
  status TEXT NOT NULL DEFAULT 'pending',                              -- pending|processing|indexed|failed|duplicate|skipped
  parent_document_id TEXT, part_index INTEGER, part_count INTEGER,     -- iter-3: oversized-upload split (§4.3); NULL for un-split docs
  fingerprint TEXT NOT NULL, chunk_count INTEGER DEFAULT 0,
  source_id TEXT, source_kind TEXT, source_uri TEXT, ingested_via TEXT, ingested_at TEXT,
  tags TEXT DEFAULT '[]', metadata TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX ux_documents_tenant_fp   ON documents(tenant_id, scope, fingerprint);
CREATE UNIQUE INDEX ux_documents_tenant_slug ON documents(tenant_id, slug);  -- slug unique within tenant
CREATE INDEX ix_documents_tenant_source ON documents(tenant_id, source_id, status);

-- chunks: stable nanoid id (re-embed target), per-row embedding state (NEW vs cf-graph).
-- Carries tenant_id + scope (scope mirrored from the parent document for the §7.3
-- allowedScopes gate in hydrateChunks), plus updated_at/deleted_at that the search
-- path (computeStale / deleted_at IS NULL) requires. trust_grade is NOT a column —
-- it lives in the memory_use_policy sidecar (§7.5) and is LEFT-JOINed at read time
-- so a promotion does not require a chunk rewrite.
CREATE TABLE chunks (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, document_id TEXT NOT NULL,
  scope TEXT,                                                          -- mirrored from parent doc (allowedScopes gate)
  team_id TEXT,                                                        -- mirrored from parent doc/session (visibility gate)
  user_id TEXT,                                                        -- author (mirrored from session/doc) — visibility gate
  visibility TEXT NOT NULL DEFAULT 'world'                             -- iter-3: intra-tenant access tier on the hybrid arm
             CHECK (visibility IN ('private','team','world')),         --   ingested-doc chunks default 'world' (org/team knowledge);
                                                                       --   session-transcript chunks inherit the session's visibility
  chunk_index INTEGER NOT NULL, content TEXT NOT NULL, heading_path TEXT,
  token_count INTEGER, chunk_source TEXT,
  embedded_at TEXT, embed_error TEXT,                                  -- gbrain 0002_search.sql staleness
  embedding_model TEXT NOT NULL, embedding_dims INTEGER NOT NULL,      -- openbrains per-row model tracking
  updated_at TEXT NOT NULL,                                            -- drives computeStale (updated_at > embedded_at)
  deleted_at TEXT                                                      -- soft-delete; search filters deleted_at IS NULL
);
CREATE INDEX ix_chunks_tenant_doc ON chunks(tenant_id, document_id);

-- FTS5 external-content + triggers (gbrain 0001_init.sql pattern). isolation via JOIN re-check (§5g), NOT MATCH.
-- Indexes heading_path + content (the search path reads heading_path; §5.2 matches this shape).
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  heading_path, content, content='chunks', content_rowid='rowid');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, heading_path, content) VALUES (new.rowid, new.heading_path, new.content); END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content) VALUES('delete', old.rowid, old.heading_path, old.content); END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, content) VALUES('delete', old.rowid, old.heading_path, old.content);
  INSERT INTO chunks_fts(rowid, heading_path, content) VALUES (new.rowid, new.heading_path, new.content); END;
```

> **FTS isolation note (§5g).** `chunks_fts` carries no `tenant_id` (external-content can't be filtered inside `MATCH`). Every `MATCH` result is JOINed back to `chunks` via `ScopedDB` and re-checked on `tenant_id`/`scope` before any row leaves the keyword arm. A `MATCH`-then-unscoped-read is a leak path and is forbidden; a dedicated CI test exercises the FTS arm.

Vectorize upsert metadata is the canonical §3.2 shape: `{ documentId, teamId, scope, visibility, userId, embeddingModel, chunkIndex, path, tenant_id }` (`tenant_id` last is belt-and-suspenders over the hard-wired namespace; **no `trustGrade`** — trust lives only in the `memory_use_policy` sidecar, LEFT-JOINed at read, so a promotion never re-upserts a vector, §3.2/§5.2). Namespace is `tenantId`, hard-wired by `ScopedVectorize` (`openbrains:packages/services/src/deps/vectorize.ts` enforces `namespace=userId` on every call; we rename `userId`→`tenantId`). Metadata indexes (`scope`, `team_id`, `visibility`, `embedding_model`) **must be created before any filtered upsert** (plan Phase 0) — `trust_grade` is deliberately NOT a metadata index (§3.2). **Vectorize caps at 10 metadata indexes per index and 64 bytes per indexed-metadata value (and a 64-byte namespace name)** — the four filtered fields above plus reserved room for `source` stay within the 10-index budget, and `scope`/`team_id` slug values must stay ≤64 B to be filterable; longer values are stored but not indexable, so the D1 re-check (not the Vectorize filter) remains the authority.

---

### 4.10 Idempotency & dedup summary (the three layers)

| Layer | Key | Mechanism | Source |
|---|---|---|---|
| Workflow instance | `ingest-${tenantId}-${fingerprint}` | CF rejects duplicate instance id (**fast-path only**, see retention caveat) | adapted from `cf-graph:.../documents.ts:759` |
| Document row | `(tenant_id, scope, fingerprint)` UNIQUE | skip-unchanged gate + **durable** dedup backstop | `gbrain-cf:src/engine.ts` putPage + `openbrains:.../normalize.ts` |
| Item (backfill) | `BrainBundleThought.fingerprint` | per-item content fingerprint | `openbrains:packages/ingest/src/fingerprint.ts` |
| Vector | `id == chunk.id` (deterministic nanoid) | retried upsert converges, never duplicates | `cf-graph:.../ingestion.ts` (stable ids) |

> **Workflow-id retention caveat (iter-2).** `create()` rejecting a duplicate instance id holds only while the prior instance is within its retention window (3 days Free / 30 days Paid). After retention expiry the `ingest-${tenantId}-${fingerprint}` id becomes reusable, so a *late* re-delivery of an old backfill Queue message past that window could re-create the Workflow. The Workflow-id check is therefore a **fast-path optimization, not the correctness guarantee** — the durable backstop is the `(tenant_id, scope, fingerprint)` UNIQUE index plus the skip-unchanged gate, which dedup regardless of how old the prior ingest was.

---

### 4.11 Edge cases & failure modes

- **Empty extraction** → `status='failed'`, reason `empty-extraction`, no chunks, no embeddings (`cf-graph:.../ingestion.ts:103-115`).
- **AI binding absent (local dev)** → `embed()` returns `null` (`gbrain-cf:src/ai.ts`); on the *write* path this throws inside the embed step so the Workflow retries (we do not silently index un-embedded chunks). The *read* path degrades to keyword-only — that asymmetry is intentional.
- **Unsupported content type** → rejected at ingress against `ALLOWED_CONTENT_TYPES` (`cf-graph:.../documents.ts:711`); webhook returns 415, upload throws "Unsupported file type."
- **Oversized webhook body** (>256KB) → 413 (`gbrain-cf:src/routes-platform.ts:71`).
- **Duplicate Queue delivery** → deterministic instance id + UNIQUE index make it a no-op (verify: §6 Phase-2 test "duplicate Queue delivery → no double-ingest").
- **Worker eviction mid-ingest** → named steps resume from the last completed batch.
- **Truncated KG JSON** → salvaged or chunk skipped, document still indexes (`cf-graph:kg-extraction.ts`).
- **Foreign embeddings in import** → dropped, `'pending'`, re-embedded (`openbrains:.../ob1.ts`).
- **Re-embed / model migration** → per-row `embedding_model != '@cf/baai/bge-m3'` OR `embedded_at IS NULL` OR `updated_at > embedded_at` flags the row for the `brain-reembed` sweep (§6), which re-embeds against the **same** vector id and re-stamps. Cost/throughput is bounded before kickoff (§6 re-embed cost model).

---

### 4.12 Verification (maps to plan Phase 1)

1. Upload PDF → document `indexed`; body in R2 (`body_r2_key` set, `markdown_preview` ≤2000 chars in D1, no full markdown in D1); chunk + FTS + vector all present.
2. Re-upload unchanged file → `skipped` (zero embedding calls).
3. Pre-chunked payload → same durable path, `bodyR2Key` populated, vectors stamped `bge-m3`.
4. Tenant A cannot retrieve tenant B's chunk via the vector arm (namespace) **or** the FTS arm (JOIN re-check) — both tested, blocking in CI (§5i).
5. Kill the Worker mid-embed → re-run resumes from the failed batch only.
6. OB1 import → rows land with `embedding_model='pending'`, then re-embed sweep upgrades them to `bge-m3` in place.

#### Code references

- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/ingestion.ts — Port near-verbatim as BatchIngestWorkflow: step structure (extract→chunk→store-batch-10→embed-batch-50→KG-batch-5→finalize), retry/backoff/timeout configs, CHUNK_DB_BATCH_SIZE=10 / EMBED_BATCH_SIZE=50 / KG_BATCH_SIZE=5 constants (tied to D1 100-param + Workers AI caps), status FSM and catch-and-fail handler, sliding-window chunkText (512/64 sentence-aware). Re-scope workspace_id→tenant_id, add per-row embedded_at/embedding_model stamping and body-to-R2.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/kg-extraction.ts — extractEntitiesFromChunk LLM prompt (canonical-name/typed-kind/confidence) and extractJsonFromText 3-strategy truncation salvage (direct parse → outer-brace slice → backtrack-and-autoclose). Chunk that fails to parse is skipped, never aborts the document.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/documents.ts — uploadDocument (ALLOWED_CONTENT_TYPES allowlist line 711, R2 put with customMetadata, Workflow create with deterministic instance id line 758), ingestChunked (pre-chunked fast path line 523) lifted into the Workflow, reuploadDocument delete-vectors-then-chunks reprocess pattern, tenant-prefixed R2 key ${workspaceId}/${docId}/${name}.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/cloudflare.ts — CloudflareDocumentConverter.toMarkdown(filename, blob) wrapping ai.toMarkdown — the CF-native PDF/DOCX/HTML/CSV extraction path; CloudflareEmbeddingService bge-m3 1024d embed/embedMany.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/util.ts — chunkText paragraph-packing chunker (CHUNK_TARGET=1200, never split a paragraph unless >2x target, no overlap) for markdown/text/sessions; sha256Hex content hash; parseFrontmatter.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ai.ts — The never-throw embed() chokepoint contract (returns null on missing binding / length mismatch) and model constants EMBEDDING_MODEL=@cf/baai/bge-m3, EMBEDDING_DIMS=1024, GENERATION_MODEL=llama-3.3-70b-fp8-fast. Single point all ingest embedding flows through.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/routes-platform.ts — POST /ingest webhook: write-scope check, normalizeContentType (md/plain/json → 415 otherwise), empty→400, 256KB cap→413, content-hash, ingest_log audit row, inbox/<date>-<slug>-<hash6> convention, 202 response. Re-scope to Principal tenant + enqueue to Queue + body-to-R2.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/engine.ts — putPage content_hash skip-unchanged dedup returning 'skipped' (adopt at document level); chunk_source tagging.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0001_init.sql — chunks_fts FTS5 external-content table + synchronous insert/delete/update triggers — the auto-synced FTS pattern (prefer over cf-graph's manual chunks_fts inserts).
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0002_search.sql — Per-chunk embedded_at / embed_error staleness columns; delete+recreate rationale (we keep stable ids instead but reuse the staleness signal).
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/sync.ts — Resumable GitHub source-sync cursor/anchor discipline: cursor in run row, anchor (last_commit) advances only on clean full pass, per-file failure → cursor.failed (no anchor advance), truncated-tree refusal, MAX_FILES_PER_TICK=150. Port for the Enumerator, re-scope to tenant_id.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/types.ts — Importer contract (begin/nextBatch/finalize, {items,nextCursor}, null-terminates) and BrainBundleThought shape (content, fingerprint, embeddingModel, embeddingDims, provenance[], sourceRefs[]). Lifted verbatim; Convex orchestrator dropped.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/contract.ts — runImporterContract harness enforcing terminal-cursor-null and no-empty-batch-with-non-null-cursor invariants. Reuse to prove every connector (incl. net-new ChatGPT/Claude-Code importers).
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/ob1.ts — Foreign-embedding drop pattern: discard 1536d OpenAI vectors entirely, emit embeddingModel:'pending'/0 to force 1024d re-embed; offset cursor with parseOb1Cursor type guard; defensive per-field narrowing of untrusted rows (asRecord/asStringArray/toEpochMs). Template for ChatGPT/Claude-Code importers.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/fingerprint.ts — contentFingerprint = sha256 hex of normalized content via Web Crypto (Workers-portable). The dedup key for documents and per-item backfill dedup.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/normalize.ts — normalizeForFingerprint (trim → collapse interior whitespace → lowercase) so re-captured content with whitespace/case drift still dedups.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/embeddings/workers-ai.ts — Pre-call token-budget rejection and returned-dimension assertion to wrap the embed chokepoint; narrow AI binding type pattern.
- openbrains:/home/roboto/devel/openbrains/packages/services/src/deps/vectorize.ts — createVectorizeClient that hard-wires namespace on every upsert/query (rename userId→tenantId for ScopedVectorize); scope/team_id/visibility as metadata filters (trust_grade is sidecar-only, never a Vectorize field); D1-row-is-correctness-gate rule. The single strongest ingest-side isolation gate.

---

## 5. Embedding, Hybrid Search, Rerank & Cited Synthesis

This section specifies the retrieval pipeline of the Brain Platform: how content becomes a vector, how a query fans out across the FTS5 (bm25) and Vectorize (cosine) arms, how the two are fused with RRF, reranked by a real cross-encoder stage, and finally synthesized into a cited, evidence-only answer with gap reporting. Every stage is **tenant-scoped by construction** and **degrades, never throws** — the gbrain degradation contract (`gbrain-cf:src/search.ts` header comment, lines 7-9) is the law for the whole pipeline.

The skeleton is taken almost wholesale from gbrain's `search.ts` / `ops/search.ts` / `ai.ts`; the FTS hardening from cf-graph `fts.ts`; the isolation discipline from openbrains. The two NET-NEW pieces are the **rerank stage** (§5.4) and the **synthesis token-budget guard** (§5.5).

---

### 5.1 Embedding chokepoint (`packages/ingest` `embed()`)

**Decision: one never-throwing chokepoint module, `@cf/baai/bge-m3` @ 1024d, cosine.** Lift gbrain's `ai.ts` verbatim (`gbrain-cf:src/ai.ts`) — its model constants and `null`-returning contract are exactly right for a platform — and wrap it with openbrains' pre-call token-budget guard and post-call dimension assertion (`openbrains:packages/ingest/src/embeddings/workers-ai.ts`).

```ts
// packages/shared/src/models.ts — locked model constants (gbrain ai.ts)
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMS  = 1024;
export const GENERATION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // ~24k ctx
export const RERANK_MODEL     = '@cf/baai/bge-reranker-base';
export const EXTRACT_MODEL    = '@cf/meta/llama-3.1-8b-instruct';

// bge-m3 context window is 60,000 tokens per the current Workers AI model page.
// It is chosen for multilingual coverage + that 60k window (not the old "8192 vs
// qwen3's 4096" framing, which was wrong). Do NOT copy openbrains' hardcoded 4096.
// Set the guard from the model's documented window, not a stale literal.
const MAX_EMBED_INPUT_TOKENS = 60_000;
const CHARS_PER_TOKEN = 4; // rough BPE heuristic (openbrains workers-ai.ts:8)
```

```ts
// packages/ingest/src/embed.ts
import { EMBEDDING_MODEL, EMBEDDING_DIMS } from '@brain/shared/models';

/** Embed one or more texts. Returns null when the binding is missing or the call
 *  fails — every caller MUST tolerate null and degrade to keyword-only.
 *  (gbrain ai.ts embed() contract, lines 17-29.) */
export async function embed(env: Env, texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  if (!env.AI) return null;
  // Pre-call budget guard (openbrains assertWithinTokenBudget, adapted to bge-m3's 60k window).
  // Reject before burning a Workers AI call so the caller can chunk/fall back.
  for (const t of texts) {
    if (Math.ceil(t.length / CHARS_PER_TOKEN) > MAX_EMBED_INPUT_TOKENS) return null;
  }
  try {
    // bge-m3 takes { text: string[] }, returns { data: number[][] } (gbrain ai.ts:21-24)
    const res = (await env.AI.run(EMBEDDING_MODEL, { text: texts })) as { data?: number[][] };
    if (!res.data || res.data.length !== texts.length) return null;
    // Post-call dimension assertion (openbrains workers-ai.ts:46-50). A model swap
    // that silently changes dims is a P0 — refuse rather than poison the index.
    if (res.data[0].length !== EMBEDDING_DIMS) return null;
    return res.data;
  } catch {
    return null;
  }
}
```

**Why three guards.** The `null` contract covers the missing-binding / local-dev path (gbrain). The token-budget guard covers oversized input cheaply (openbrains). The dimension assertion covers an accidental model/index mismatch (openbrains). None throws; all let the pipeline fall back to keyword-only.

**Model-cost interaction (enforcement boundary).** All `env.AI.run` calls in this section route through AI Gateway with `tenant_id` custom metadata for attribution/observability (Plan §5f). The platform runs on the Workers **Paid** plan ($5/mo); Workers AI is billed by **Neurons** (Paid includes ~10,000 Neurons/day, then ~$0.011 / 1k Neurons). The **enforcing** per-tenant cost cap is app-level: `embed()`/`gen()`/`rerank()` **pre-check the tenant's `token_spend` budget against `MONTHLY_COST_CEILING_USD` (default 400, configurable per-tenant via env var) and return `429` (with `Retry-After`) BEFORE issuing `env.AI.run`** when projected monthly spend would exceed it — because, as of the 2026-06 AI Gateway spend-limits docs, native `@cf/` neuron-billed calls are covered by neither the Unified Billing nor the BYOK rails the spend-limit feature prices (the v1 model set is all `@cf/`). At 1-2 tenants this ceiling is effectively the whole-platform budget. That accounting is plumbed at the chokepoint, not at call sites. **BYO / upgrade path:** the AI Gateway already in front of every call is the seam for caching/retry/fallback and for bringing your own / OpenAI-compatible models later via the AI provider abstraction (`AI_PROVIDER=openai-compatible`, as in cf-graph `apps/graph/src/api/services/factory.ts`) — a config swap behind the same chokepoint, not a v1 build. See §10 for the full Neuron/rate-limit detail.

**Workers AI request-RATE limits (a separate axis from cost).** Neuron cost is bounded by `token_spend`; per-model **requests-per-minute** limits are a distinct constraint. The per-model ceilings used below are **explicitly-labeled conservative ASSUMPTIONS** — unverified-until-staging and **NON-BINDING at the v1 scale of 1-2 internal-dogfood tenants** (where projected fleet req/min is far under any plausible ceiling): assume ~100 req/min for text-generation (`gen` via llama-3.3-70b; `expandQuery` and `summarizeForFit` share this budget), ~300 req/min for the reranker, and ~300 req/min for embeddings (`embed` via bge-m3). Confirming the exact current per-model limits and filing a Workers AI limit-increase request is a **documented Phase-N scale-out TRIGGER** (fires only if a fleet projection approaches these assumed values), **not a v1 launch dependency**. See §10 for the per-model detail; the design responds at two points regardless of the exact numbers:
1. **At the chokepoints** (`embed`/`gen`/`rerank`): a bounded in-flight concurrency cap per model, and on a Workers-AI rate-limit response (HTTP 429 / `Capacity`-class error from `env.AI.run`) the chokepoint **degrades-or-queues — it does NOT 429 the end user**. A read-path `embed`/`rerank` rate-limit degrades exactly like a missing binding (keyword-only / RRF order, per the `null`/degrade contract); a write-path `embed` re-queues the step (Workflow retry) rather than failing the request.
2. **In the backfill / re-embed pacing** (§5f, §10.7): the `brain-reembed` and `brain-backfill` Queue consumers are paced (messages/tick) against the per-model req/min ceiling so a sweep over millions of vectors through `bge-m3` cannot starve concurrent `think` traffic. The re-embed dry-run (§10.7 M2) reports projected req/min against the ceiling, and the consumer self-throttles on rate-limit responses with exponential backoff.

**Staleness signal carried per row.** Unlike gbrain (page-level, delete+recreate, unstable ids — `gbrain-cf:migrations/0002_search.sql`), the platform uses **stable nanoid chunk ids** and stamps `embedded_at` + `embedding_model` per chunk (openbrains per-row model tracking). `computeStale` (gbrain `search.ts:140-143`) becomes: stale iff `embedded_at IS NULL OR embedding_model != bge-m3 OR updated_at > embedded_at`. The re-embed sweep (Plan §6) consumes this; search only reads it to flag `stale` on a hit.

---

### 5.2 Search-relevant schema (read-subset of the §4.9 authoritative DDL)

> **Not a second definition.** The `documents`, `chunks`, and `chunks_fts` tables are defined once, authoritatively, in **§4.9**. This subsection only **lists the columns the search path reads** and pins the field-origin map; it intentionally does not re-`CREATE TABLE` them (the earlier divergent copy here — which omitted `scope` and disagreed with §4.9 on the FTS column list — is removed). The critical isolation decision is the **FTS5 table shape**, owned by §4.9.

**Columns the search path reads, and where each comes from:**

| Result field | Source (per §4.9 / §7.5) |
|---|---|
| `chunk_id`, `content`, `heading_path`, `chunk_source`, `chunk_index` | `chunks` (own columns) |
| `tenant_id`, `scope` | `chunks` (own columns — the `scope` mirror powers the `allowedScopes` gate, §7.3) |
| `visibility`, `team_id`, `user_id` | `chunks` (own columns, iter-3 — power the intra-tenant `visibilityPredicate` gate on the hybrid/`think` arm, §7.3/§7.5; ingested-doc default `'world'`, session chunks inherit the session's tier) |
| `embedded_at`, `embedding_model`, `updated_at`, `deleted_at` | `chunks` (own columns — drive `computeStale` and the `deleted_at IS NULL` filter) |
| `document_id`, `source_id` | `documents` via `chunks.document_id` JOIN |
| `slug`, `title` | `documents` via JOIN (**citation fields — not on `chunks`**) |
| `trust_grade` | `memory_use_policy` sidecar via LEFT JOIN, default `'evidence'` (§7.5) — **not denormalized onto `chunks`** so a trust promotion never requires a chunk rewrite |

The `chunks_fts` virtual table is the external-content `fts5(heading_path, content, content='chunks', content_rowid='rowid')` defined in §4.9. An external-content FTS5 table **cannot carry `tenant_id` inside `MATCH`** — isolation is enforced by the JOIN back to `chunks.tenant_id` (§5.3, Plan §5g), never inside the `MATCH` predicate.

`entity_fts` follows the identical external-content + JOIN-recheck pattern (Plan §3) and reuses the same fusion code (the generic fusion proves multi-arm reuse — `cf-graph:apps/graph/src/api/services/knowledge-graph.ts`). v1 provisions two Vectorize indexes: `brain-chunks` (chunk search, used by the hybrid pipeline above) and `brain-entities` (entity search, used by `search_entities` — §6.6/§6.7). Phase 3.5 adds cross-session semantic fact dedup (nearest-vector merge across `brain-entities` to collapse equivalent facts from different sessions) on top of this v1 substrate.

---

### 5.3 Hybrid search pipeline

```
embed(query) [+ optional expandQuery]
   → for each phrasing, in parallel:
        FTS arm  (bm25, tenant-filtered via JOIN re-check)   ∥
        Vector arm (Vectorize namespace=tenantId + metadata filter,
                    raw-cosine threshold, then D1 re-JOIN + tenant re-check)
   → rrfFusion (K=60, normalize-by-max)
   → trust-grade boost map  +  applyTitleBoost
   → take top-N candidates (default 40)
   → rerank (bge-reranker-base, degradable)          ← §5.4 NET-NEW
   → top-k (8-12)
   → think: token-budget-guarded cited synthesis      ← §5.5 NET-NEW
   → write one memory_recall_traces row per kept hit
```

Three ops expose slices of this (gbrain `ops/search.ts:181`): `search` (cheap hybrid, expansion OFF, rerank OFF), `query` (expansion ON, rerank ON), `think` (expansion + rerank + synthesis).

#### 5.3.1 FTS (bm25) arm — isolation via JOIN, not via MATCH

**Trap (verified):** do NOT copy cf-graph's `... WHERE chunks_fts MATCH ? AND workspace_id = ?` (`cf-graph:apps/graph/src/api/search/fts.ts:28`). That works only because cf-graph's FTS table is *contentless with a manually-populated UNINDEXED `workspace_id` column*. Our chosen external-content table (§5.2) has no tenant column. The correct, leak-free form is gbrain's `ftsQuery` (`gbrain-cf:src/engine.ts:316-350`): MATCH stays pure text, the tenant predicate sits on the base table after the JOIN.

```ts
// packages/db/src/search/fts.ts  (scoped: callable only via ScopedDB)
import { sanitizeFtsQuery } from './sanitize'; // cf-graph fts.ts:4-15, verbatim

/** bm25 keyword arm. tenant_id is enforced on the BASE TABLE via JOIN, never
 *  inside MATCH (Plan §5g). AND-then-OR fallback = websearch parity (gbrain
 *  engine.ts:301-314). FTS5 syntax errors from hostile input → [] (engine.ts:331). */
export async function searchChunksFts(
  // allowedScopes is the principal's data-partition grant (§7.3): '*' = all tenant
  // scopes (the default), else a finite list. searchChunksFts is callable ONLY via
  // ScopedDB, which supplies both tenantId and allowedScopes from the Principal.
  db: D1Database, tenantId: string, allowedScopes: readonly string[] | '*',
  query: string, topK: number, offset = 0,
): Promise<Array<{ chunkId: string; rank: number }>> {
  const terms = sanitizeFtsQuery(query).split(/\s+/).filter(Boolean); // already quoted by sanitize
  if (terms.length === 0) return [];
  // Inline scope predicate, mirroring the inline tenant_id predicate. '*' adds none.
  const scopeSql = allowedScopes === '*' ? ''
    : ` AND c.scope IN (${allowedScopes.map(() => '?').join(',')})`;
  const scopeBinds = allowedScopes === '*' ? [] : [...allowedScopes];
  for (const joiner of [' AND ', ' OR '] as const) {
    const match = terms.join(joiner);
    let rows;
    try {
      rows = await db.prepare(
        `SELECT c.id AS chunk_id, bm25(chunks_fts) AS rank
           FROM chunks_fts f
           JOIN chunks c ON c.rowid = f.rowid
          WHERE chunks_fts MATCH ?
            AND c.tenant_id = ?          -- ISOLATION: base-table tenant predicate
            AND c.deleted_at IS NULL${scopeSql}  -- ISOLATION: base-table scope gate (§7.3)
          ORDER BY rank LIMIT ? OFFSET ?`
      ).bind(match, tenantId, ...scopeBinds, topK, offset).all<{ chunk_id: string; rank: number }>();
    } catch { return []; }            // hostile MATCH → no matches
    if (rows.results.length > 0 || joiner === ' OR ') {
      return rows.results.map(r => ({ chunkId: r.chunk_id, rank: r.rank }));
    }
  }
  return [];
}
```

`sanitizeFtsQuery` is taken verbatim from `cf-graph:apps/graph/src/api/search/fts.ts:1-15` (strips FTS5 specials `["*()\-]` + operators `AND|OR|NOT|NEAR`, quotes each term) as a belt-and-suspenders guard alongside gbrain's try/catch.

**Scope isolation on the FTS arm (iter-2).** The FTS arm enforces `allowedScopes` two ways, defense-in-depth: (1) the inline `c.scope IN (...)` predicate above (mirroring the inline `tenant_id` predicate — visible at the arm), and (2) because the FTS arm returns only `{chunkId, rank}` and the pipeline must hydrate those ids through the scope-gated `ScopedDB.getChunksByIds` (§5.3.2) to obtain `slug`/`title`/`trust_grade` for boosting and synthesis, any out-of-grant id that somehow survived would be **dropped at hydration** by the same drop-don't-error gate the vector arm uses. So both arms close the cross-scope path; neither relies on the other. A dedicated CI test (Plan §5i, §10.6 canary #7) exercises this arm specifically: tenant A's term must never surface tenant B's chunk, and a restricted-`allowedScopes` principal's term must never surface another client's scope.

#### 5.3.2 Vector arm — namespace isolation + raw-cosine threshold + D1 re-check

`ScopedVectorize` hard-wires `namespace: tenantId` on every query (lift `openbrains:packages/services/src/deps/vectorize.ts` `createVectorizeClient`, rename `userId`→`tenantId`) — physically impossible to omit. `team_id`/`scope`/`embedding_model` are metadata filters *within* the namespace.

```ts
// packages/db/src/search/vector.ts
import { embed } from '@brain/ingest/embed';
import { computeStale } from './stale'; // gbrain search.ts:140-143, +embedding_model term

const COSINE_FLOOR = 0.5; // openbrains searchThoughts/recall default (shared/tools, default(0.5))

/** Vector arm: embed query → Vectorize topK (namespace=tenant + filter) →
 *  raw-cosine threshold (PRE-FUSION) → D1 re-JOIN dropping cross-tenant /
 *  deleted ids silently. [] when AI/Vectorize unavailable (gbrain vectorSearch:233). */
export async function vectorSearch(
  env: Env, sv: ScopedVectorize, sdb: ScopedDB, query: string, topK: number,
  filter?: { team_id?: string; scope?: string },
  threshold = COSINE_FLOOR,
): Promise<SearchResult[]> {
  if (!query) return [];
  const vec = await embed(env, [query]);
  if (!vec) return [];                                  // degrade: vector arm empty

  // PRIMARY PATH for restricted principals (iter-3 recall-cliff fix): push the
  // stable, cheap scope partition predicate INTO the Vectorize metadata filter so
  // the topK=100 budget is spent INSIDE the granted scope, not on tenant-wide top
  // results the D1 gate will then discard. A restricted allowedScopes is folded
  // into the filter as {scope:{$in:[...granted]}} — a single query covers any
  // number of granted scopes. Visibility is NOT pushed (it would drop the
  // principal's own private chunks, which the D1 re-check cannot recover); it
  // stays authoritative at D1. ScopedVectorize authorizes any explicit scope
  // filter (§7.3).
  const effFilter = sv.foldPartitionFilter(filter); // adds {scope:{$in:[...]}} from Principal
  let matches: { id: string; score: number }[];
  try {
    matches = await sv.query({ values: vec[0], topK, filter: effFilter }); // namespace=tenant baked in
  } catch { return []; }

  // Threshold on RAW cosine, BEFORE fusion. Never on normalized RRF scores —
  // RRF discards cosine for rank position (openbrains search-thoughts.ts:50).
  const kept = matches.filter(m => m.score >= threshold);
  if (kept.length === 0) return [];
  const scoreById = new Map(kept.map(m => [m.id, m.score]));

  // D1 is the correctness gate: re-JOIN to live rows, re-check tenant/scope/
  // deleted_at. Cross-tenant ids are silently dropped — no existence leak
  // (openbrains recall.ts:36; gbrain vectorSearch JOIN, search.ts:260-264).
  const rows = await sdb.getChunksByIds([...scoreById.keys()]); // see getChunksByIds JOIN below
  return rows.map(r => ({
    chunk_id: r.id, document_id: r.document_id, slug: r.slug, title: r.title,
    chunk_text: r.content, chunk_source: r.chunk_source, trust_grade: r.trust_grade,
    score: scoreById.get(r.id) ?? 0,
    stale: computeStale(r.updated_at, r.embedded_at, r.embedding_model),
    source_id: r.source_id,
  })).sort((a, b) => b.score - a.score);
}
```

**`getChunksByIds` — the JOIN that supplies the citation/trust fields (iter-2 schema fix; iter-3 visibility gate).** `slug`/`title`/`source_id` are not `chunks` columns; they come from `documents`. `trust_grade` is not a `chunks` column either; it comes from the `memory_use_policy` sidecar (§7.5), LEFT-JOINed with a default so an un-promoted chunk ranks as `evidence`. The method is a `ScopedDB` member, so `tenant_id`, the `allowedScopes` gate (§7.3), **and the intra-tenant `visibilityPredicate` (§7.3/§7.5)** are all injected; `deleted_at IS NULL` is applied here. The visibility gate closes the hybrid/`think` arm against the intra-tenant leak the security review named (a user must not semantically retrieve a chunk from another user's **private** session): session-transcript chunks carry the session's `visibility`/`user_id`/`team_id` (§8.3), while ingested-document chunks default `visibility='world'` (org/team knowledge), so the predicate is a no-op for ordinary docs and load-bearing for private session chunks. The `visibility` gate is enforced **here at D1**, not pushed into the Vectorize filter — pushing it would drop the principal's own private chunks from the vector arm (ids the D1 re-check could never recover), so visibility stays authoritative on this read path:

```sql
-- ScopedDB.getChunksByIds(ids) — tenant_id (+ allowedScopes when restricted) injected by ScopedDB
SELECT c.id, c.document_id, c.content, c.heading_path, c.chunk_source,
       c.embedded_at, c.embedding_model, c.updated_at,
       d.slug, d.title, d.source_id,
       COALESCE(mup.trust_grade, 'evidence') AS trust_grade
  FROM chunks c
  JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
  LEFT JOIN memory_use_policy mup
         ON mup.target_id = c.id AND mup.tenant_id = c.tenant_id
 WHERE c.tenant_id = ?            -- ISOLATION (ScopedDB-injected)
   AND c.id IN (/* ids */)
   AND c.deleted_at IS NULL
   /* AND c.scope IN (...)  -- added by ScopedDB when allowedScopes is restricted (§7.3) */
   /* AND (c.visibility='world'                                           -- iter-3 intra-tenant RLS:
           OR (c.visibility='team' AND c.team_id IN (:p.teamIds))         -- the SAME visibilityPredicate
           OR (c.visibility='private' AND c.user_id = :p.userId))         -- as facts (§7.3/§7.5), now on the
       -- injected by ScopedDB on EVERY chunk read (getChunksByIds/hydrateChunks). hybrid/think arm too. */
```

**Scope as a Vectorize metadata pre-filter is the PRIMARY path for restricted principals — not over-fetch (iter-3 recall-cliff fix, cf-correctness HIGH).** Vectorize's `topK` max is **100**; it drops to 50 only when the query sets `returnValues:true` or `returnMetadata:'all'`. Our `vectorSearch` requests **neither** (it returns only `{id,score}` and re-checks every field via D1), so the full **topK=100** budget is available *even with a metadata filter* — a metadata FILTER does not reduce topK. The recall cliff is nonetheless real: if we returned the tenant-wide top-100 and only THEN dropped out-of-scope ids at the D1 gate, a restricted-`allowedScopes` principal (Persona C, the multi-client agency) whose granted-scope content ranks **below** the tenant-wide top-100 would silently recall **nothing** — and the drop-don't-error rule would make that look like "no results," not "truncated." The fix is **not** over-fetch (raising topK is impossible — 100 is the ceiling, and the unfiltered tenant-wide top-100 is exactly what buries the grant). Instead, for any restricted principal the granted `scope` predicate is pushed **into the Vectorize metadata filter** (`sv.foldPartitionFilter` → `{scope:{$in:[...granted]}}`), so the topK=100 budget is **spent inside the permitted partition** and the granted content competes only against itself. This is **required-before-GA for any agency (Persona C) tenant**. The `scope` metadata index must therefore be live before such a tenant onboards (§7.4/§10.4 provisioning). The D1 re-check (`getChunksByIds` + `readFacts`) remains the authoritative gate on top of the pre-filter — the pre-filter is best-effort (a value >64 B is stored but not indexable), never the security boundary, and it is also where the **visibility** tier is enforced (the visibility predicate is intentionally *not* pushed into Vectorize; see below).

**Multi-scope grants collapse to one query via `$in`.** Vectorize metadata filtering supports the `$in` / `$nin` operators, so a principal granted several scopes is **one** query — `{scope:{$in:[...granted scopes]}}` — not a per-scope fan-out. This removes the multi-query union path and its eviction bookkeeping entirely (an agency staffer covering a handful of clients hits a single Vectorize call). The per-value 64-byte metadata-indexability caveat still applies to each scope value; the D1 re-check remains authoritative. The `'*'` (default, unrestricted) principal needs no pre-filter and uses the plain tenant-namespace query.

**Why visibility is NOT pushed into the filter (declined on purpose).** The `world`/`team`/`private` visibility tiers *could* be expressed as `{visibility:{$in:['world','team']}}` plus a private-author branch, but pushing this into Vectorize would **exclude the principal's own private chunks from the vector arm entirely** — and the D1 re-check can only filter ids the vector arm already returned, never recover ids it never saw. That is a recall regression for a restricted principal's own private sessions. Because the `scope` `$in` pre-filter already confines the topK=100 budget to the granted partition, no visibility pushdown is needed for the recall-cliff fix. Visibility therefore stays **authoritative at D1 only** (the `visibilityPredicate` injected by `ScopedDB.getChunksByIds`, §7.3/§7.5) — correct for own-private recall, and the security boundary regardless.

#### 5.3.3 Fusion + boosts (gbrain `rrfFusion`, generalized boost)

Use gbrain's `rrfFusion` (`gbrain-cf:src/search.ts:45-82`) as canonical: sum `1/(K+rank)` across lists, **normalize-by-max**, THEN apply boosts. Do **not** blend with cf-graph's raw `1/(k+rank+1)` (`cf-graph:apps/graph/src/api/search/rrf.ts`) or you double-normalize; cf-graph's generic `reciprocalRankFusion<T>` is the type-parametric variant cited for entity-arm reuse in §4.4, not the chunk path.

The single `compiled_truth` boost (gbrain `COMPILED_TRUTH_BOOST = 2.0`) is **generalized to a trust-grade boost map** so `instruction` > `evidence` > `draft` ranks higher — wiring openbrains' trust vocabulary into ranking:

```ts
const TRUST_BOOST: Record<string, number> = { instruction: 2.0, evidence: 1.0, draft: 0.6 };

function boostFactor(r: SearchResult): number {
  return TRUST_BOOST[r.trust_grade ?? 'evidence'] ?? 1.0;
}
// In rrfFusion's post-normalize loop, replace the compiled_truth check:
//   e.score = (e.score / maxScore) * boostFactor(e.result);
```

`applyTitleBoost` (1.25×, `isTitlePhraseMatch` contiguous-token-run with a ≥2 content-token floor) is taken verbatim from `gbrain-cf:src/search.ts:84-133`. The `rrfKey` (`${source_id}:${slug}:${chunk_id}`, gbrain `search.ts:34-38`) keeps same-slug chunks from different sources distinct, and ORs the `stale` flag when a chunk appears in both arms (gbrain `search.ts:56-60`).

`hybridSearch` / `expandedHybridSearch` (gbrain `search.ts:317-414`) are ported with `tenantId` threaded into both arm calls. `expandQuery` (gbrain `search.ts:350-374`) — LLM produces 2-3 alternate phrasings, de-duped, original always kept; no-op when the LLM is unavailable — is **opt-in per op** (`search`=off, `query`/`think`=on), matching gbrain `ops/search.ts:31-71`.

---

### 5.4 Rerank stage (NET-NEW — the key gap none of the three exercised)

Insert a cross-encoder rerank between RRF fusion and top-k:

```
expand → [FTS ∥ vector] → RRF + boosts → top-40 candidates → rerank → top-12 → think
```

**Expected signature (Cloudflare docs, 2026 — defensively parsed):** `env.AI.run('@cf/baai/bge-reranker-base', { query, contexts: [{ text }], top_k })`. The docs confirm `contexts[]` are index-significant, the `top_k` param, and a [0,1] sigmoid score; the exact output field names (`response[]` of `{ id, score }`, where `id` indexes into `contexts`) are the *expected* shape but are **not pinned by the rendered doc**, so the rerank code parses defensively (filters on `Number.isInteger(r.id)` and degrades to RRF order on any malformed output) rather than trusting the shape. **A staging integration test against the real model locks the actual output shape before the index→chunk remap is relied on — and it is a HARD, named, BLOCKING CI/deploy gate (§10.6), not just a unit assertion** (iter-3): a silently-wrong remap would attribute the **wrong chunk to a citation** — a correctness bug, not merely degraded ranking — so until the gate is green for a given Workers AI version the rerank stage degrades to RRF order in production. Once the gate locks the shape, the confirmed shape is captured back into this section. Pricing ~$0.0031 / M input tokens (Neuron-billed under the Paid plan; the rerank call flows through the same `token_spend`/`MONTHLY_COST_CEILING_USD` chokepoint and the assumed ~300 req/min rerank rate-limit — non-binding at 1-2 tenants — per §5.1, detail in §10).

```ts
// packages/db/src/search/rerank.ts
import { RERANK_MODEL } from '@brain/shared/models';

/** Cross-encoder rerank. Builds contexts in candidate order; reads response back
 *  BY INDEX and remaps to the original candidate. Degradable: missing AI / error /
 *  malformed output → keep RRF order, never throw (gbrain degradation contract). */
export async function rerank(
  env: Env, query: string, candidates: SearchResult[], topK: number,
): Promise<SearchResult[]> {
  if (!env.AI || candidates.length === 0) return candidates.slice(0, topK);
  const contexts = candidates.map(c => ({ text: c.chunk_text })); // index i ↔ candidates[i]
  try {
    const res = (await env.AI.run(RERANK_MODEL, { query, contexts, top_k: topK })) as {
      response?: Array<{ id: number; score: number }>;
    };
    if (!res.response || res.response.length === 0) return candidates.slice(0, topK);
    return res.response
      .filter(r => Number.isInteger(r.id) && r.id >= 0 && r.id < candidates.length)
      .map(r => ({ ...candidates[r.id], score: r.score, rerank_score: r.score })) // remap by index
      .slice(0, topK);
  } catch {
    return candidates.slice(0, topK); // degrade to RRF order
  }
}
```

**Edge cases.** (a) `top_k` larger than candidates — model returns all; slice is a no-op. (b) **Reranker total-context budget.** `bge-reranker-base` has a per-call cap on `query` + the sum of all `contexts` tokens; 40 full chunks can exceed it. The candidate set entering rerank is therefore bounded by a **cumulative token estimate**, not a fixed count: candidates are admitted highest-RRF-first until the estimated reranker context budget is reached (default ceiling 40, but fewer when chunks are large), and any chunk longer than a per-candidate cap is truncated for the rerank call only (the full `chunk_text` is preserved for synthesis). This keeps the call within the model's context limit; the per-call token spend still flows through the chokepoint under the tenant's budget and rate-limit pacing (§5.1). (c) An out-of-range `id` in `response` is filtered (defensive — never index past the array). (d) If reranking is disabled for the op (`search`), the top-k slice of the RRF result is returned directly. (e) A Workers-AI rate-limit response degrades to RRF order (§5.1), identical to a binding error.

---

### 5.5 Cited synthesis — the `think` op with token-budget guard (NET-NEW guard)

`think` takes the reranked top-k, builds a numbered-evidence prompt, and asks the LLM to answer **using ONLY the provided evidence**, citing page slugs, and to report gaps. The output shape and strict system prompt are taken **verbatim** from gbrain (`gbrain-cf:src/ops/search.ts:74-157`):

```ts
const SYNTH_SYSTEM =                                  // gbrain ops/search.ts:74-76, verbatim
  'You answer questions using ONLY the provided evidence chunks. Cite the slug of each ' +
  'page you draw from. If the evidence is insufficient, say so plainly and list what is missing.';

interface ThinkResult {
  question: string; answer: string;
  pages_gathered: number;
  evidence: Array<{ slug: string; title: string; chunk_text: string; chunk_source: string; score: number; stale: boolean }>;
  citations: Array<{ page_slug: string; row_num: number | null }>;
  gaps: string[];
  warnings: string[];                                 // 'no_evidence' | 'llm_unavailable' | 'evidence_evicted:<n>'
  rounds: number;
}
```

**Synthesis token-budget guard (NET-NEW, addresses the ~24k llama-3.3-70b-fp8-fast ceiling, Plan §4.3).** Build the prompt behind a chokepoint parallel to `embed()`. The `gen` call is Neuron-billed under the Paid plan and routes through the same `token_spend`/`MONTHLY_COST_CEILING_USD` chokepoint plus the assumed ~100 req/min text-generation rate-limit (shared with `expandQuery`/`summarizeForFit`; non-binding at 1-2 tenants — §5.1, detail in §10); the BYO/OpenAI-compatible swap (`AI_PROVIDER=openai-compatible`, §5.1) would substitute a longer-context model behind this same guard:

```ts
// packages/db/src/search/synthesis-budget.ts
import { GENERATION_MODEL } from '@brain/shared/models';

// 24,000 is the VERIFIED context window of @cf/meta/llama-3.3-70b-instruct-fp8-fast
// per the 2026 Workers AI model docs (cf-correctness-verified). Configurable so a
// longer-context model swaps behind this chokepoint without touching call sites.
const MODEL_CTX_TOKENS   = 24_000;
const ANSWER_HEADROOM    = 1_500;    // reserved for the generated answer
const SYSTEM_QUESTION_RES = 800;     // reserved for system prompt + question
// CHARS_PER_TOKEN=4 is a rough BPE heuristic that can UNDER-count for dense/code
// text, so the est() below biases optimistic; ANSWER_HEADROOM + SYSTEM_QUESTION_RES
// are deliberately generous to absorb that error and keep the packed prompt clear
// of the hard ceiling. If real traffic shows truncation, lower the effective budget
// (raise the reserves) rather than the model ceiling.
const CHARS_PER_TOKEN    = 4;
const est = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Pack evidence highest-reranker-score-first until the budget is hit. Dropped
 *  hits are SURFACED in warnings/gaps — never silently truncated mid-document.
 *  A single oversized top hit is summarized-then-synthesized (map step). */
export async function buildSynthesisPrompt(
  env: Env, question: string, ranked: SearchResult[],
): Promise<{ prompt: string; used: SearchResult[]; warnings: string[]; gaps: string[] }> {
  const budget = MODEL_CTX_TOKENS - ANSWER_HEADROOM - SYSTEM_QUESTION_RES - est(question);
  const used: SearchResult[] = []; const warnings: string[] = []; const gaps: string[] = [];
  let spent = 0;

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];                                  // already in rerank-score order
    const blockCost = est(`[${i + 1}] (${r.slug} — ${r.title})\n${r.chunk_text}\n\n`);
    if (used.length === 0 && blockCost > budget) {
      // (3) single oversized top hit → map/summarize step, then synthesize
      const summary = await summarizeForFit(env, r.chunk_text, budget);
      used.push({ ...r, chunk_text: summary ?? r.chunk_text.slice(0, budget * CHARS_PER_TOKEN) });
      spent += est(summary ?? '');
      continue;
    }
    if (spent + blockCost > budget) {                      // (2) budget hit → evict the rest
      const evicted = ranked.length - used.length;
      warnings.push(`evidence_evicted:${evicted}`);
      gaps.push(`${evicted} lower-ranked evidence chunk(s) omitted to fit the model context window.`);
      break;
    }
    used.push(r); spent += blockCost;
  }

  const blocks = used.map((r, i) => `[${i + 1}] (${r.slug} — ${r.title})\n${r.chunk_text}`).join('\n\n');
  return {
    prompt: `Question: ${question}\n\nEvidence:\n${blocks}\n\nAnswer the question, citing the page slugs you used.`,
    used, warnings, gaps,
  };
}
```

The guard satisfies all three required behaviors: (1) highest-score-first packing; (2) overflow surfaced in `warnings`/`gaps`, not silent truncation; (3) single-oversized-hit map step. `MODEL_CTX_TOKENS`/`GENERATION_MODEL` are configurable so a longer-context model can be swapped behind the same chokepoint without touching call sites.

**`think` handler** (structure from gbrain `ops/search.ts:97-157`, with rerank + budget guard slotted in and a recall-trace write added):

```ts
const think: Operation = {
  name: 'think', scope: 'read',                          // platform blocks remote persistence
  handler: async (ctx, p) => {
    const question = requireString(p.question, 'think requires a question');
    const anchor = typeof p.anchor === 'string' ? p.anchor : undefined;
    const retrievalQuery = anchor ? `${question} ${anchor}` : question; // gbrain ops/search.ts:103

    // 1. expand → hybrid (both arms tenant-scoped) → RRF + boosts → top-40
    const fused = await expandedHybridSearch(ctx.env, ctx.sdb, ctx.sv, retrievalQuery, { limit: 40 });
    // 2. rerank → top-12
    const evidence = await rerank(ctx.env, retrievalQuery, fused, 12);

    // 3. audit: one recall-trace row per kept hit (openbrains recall.ts:52-58), tenant-scoped
    await ctx.sdb.writeRecallTraces({
      userId: ctx.principal.userId, query: question, clientId: ctx.principal.clientId,
      hits: evidence.map(e => ({ targetId: e.chunk_id, score: e.score })),
    });

    const citations = dedupeSlugs(evidence.map(r => r.slug)); // gbrain ops/search.ts:159-169
    const base = { question, pages_gathered: citations.length, rounds: 1,
      evidence: evidence.map(r => ({ slug: r.slug, title: r.title, chunk_text: r.chunk_text,
        chunk_source: r.chunk_source, score: r.score, stale: r.stale })),
      citations: citations.map(slug => ({ page_slug: slug, row_num: null })) };

    if (evidence.length === 0)                              // gbrain ops/search.ts:125-133
      return { ...base, answer: '', gaps: ['No matching evidence found for this question.'], warnings: ['no_evidence'] };

    // 4. token-budget-guarded synthesis
    const { prompt, warnings, gaps } = await buildSynthesisPrompt(ctx.env, question, evidence);
    const answer = await gen(ctx.env, prompt, { system: SYNTH_SYSTEM, maxTokens: 1024 });
    if (answer === null)                                   // LLM unavailable → evidence + note (gbrain :138-147)
      return { ...base, answer: '', gaps, warnings: [...warnings, 'llm_unavailable: returning retrieved evidence without synthesis'] };

    return { ...base, answer: answer.trim(), gaps, warnings };
  },
};
```

---

### 5.6 Request flows

**`query` (hybrid + expansion + rerank), tenant T:**
1. `resolvePrincipal()` → `Principal{tenantId:T,...}`; construct `ScopedDB(p)` + `ScopedVectorize(p)`.
2. `expandQuery` → `[q, alt1, alt2]` (LLM; degrades to `[q]`).
3. Per phrasing, in parallel: `searchChunksFts(T, …)` (JOIN re-check) ∥ `vectorSearch(…, namespace=T, threshold 0.5, D1 re-check)`.
4. `rrfFusion(K=60, normalize-by-max)` per phrasing → `rrfFusion` across phrasings → trust boost + title boost → top-40.
5. `rerank` → top-k → recall traces → return.

**`think`:** as above with `limit:40`, rerank to 12, then budget-guarded synthesis (§5.5).

**Degradation matrix (gbrain contract):**
| Missing | Behavior |
|---|---|
| `AI` binding | no embed/expand/rerank/synthesis → keyword-only RRF; `think` returns evidence + `llm_unavailable` |
| `VECTORIZE` | vector arm empty → keyword-only RRF |
| LLM only (embed OK) | full hybrid + rerank; `think` returns evidence + `llm_unavailable` |
| reranker errors | keep RRF order, slice top-k |

---

### 5.7 Edge cases & invariants

- **FTS isolation (P0):** the tenant predicate (and, for a restricted principal, the `c.scope IN (...)` scope gate) is on the `chunks` base table after the JOIN; MATCH is pure text. Copying cf-graph's `MATCH … AND workspace_id=?` against an external-content table is a leak (no such column) — forbidden, CI-tested (Plan §5g/§5i). The FTS arm's candidate ids are additionally hydrated through the scope-gated `ScopedDB.getChunksByIds`, so cross-scope is closed at both the arm and at hydration (§5.3.1).
- **Vectorize eventual consistency:** D1 is the existence authority. The vector-arm D1 re-JOIN drops a stale-but-not-yet-deleted vector and any cross-tenant id silently (no existence leak). Re-ingest uses deterministic ids so a racing upsert converges (Plan §5c/§5h).
- **Threshold placement:** raw cosine `>= 0.5` (recall) / `0.85` (related) applied on the vector arm **before** fusion. Applying a threshold to normalized RRF scores is meaningless (RRF discards cosine).
- **Token budget for embedding:** 60,000 (bge-m3's documented context window) — bge-m3 is chosen for multilingual coverage + that 60k window, not the obsolete "8192 vs qwen3's 4096" framing. Over-budget input returns `null` → caller chunks or skips.
- **Hostile FTS input:** `sanitizeFtsQuery` + try/catch → empty arm, never a 500.
- **Empty evidence:** `think` returns `warnings:['no_evidence']` with an explicit gap, not a hallucinated answer (evidence-only requirement).
- **Synthesis overflow:** evidence evicted highest-score-last; `warnings:['evidence_evicted:N']` + a gap line. Oversized single hit → map/summarize, never raw-truncate mid-document.
- **Audit:** every kept `think`/`query` hit writes a tenant-scoped `memory_recall_traces` row; zero hits write zero traces (openbrains rule).
- **Stale hits:** surfaced via the `stale` flag (never embedded / model drift / content drift), not filtered out — the caller decides; the re-embed sweep repairs them out-of-band.

#### Code references

- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ai.ts — Embedding/generation chokepoint: EMBEDDING_MODEL=@cf/baai/bge-m3 1024d, GENERATION_MODEL=llama-3.3-70b-fp8-fast, and the null-returning never-throw embed()/generate() degradation contract. Lift verbatim; add the 60,000-token guard + dimension assert around it.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/search.ts — The hybrid engine skeleton: rrfFusion (K=60, normalize-by-max, boost-after-normalize), rrfKey, applyTitleBoost/isTitlePhraseMatch (1.25x, contiguous-run + 2-content-token floor), computeStale, vectorSearch (query→D1 re-JOIN dropping orphans), hybridSearch, expandQuery + expandedHybridSearch. Port wholesale; generalize compiled_truth boost → trust-grade map; thread tenant_id.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/search.ts — search/query/think op definitions and the cited-synthesis pipeline: SYNTH_SYSTEM evidence-only prompt (verbatim), numbered-evidence prompt builder, ThinkResult shape {answer,evidence,citations,gaps,warnings,pages_gathered,rounds}, no_evidence/llm_unavailable warnings, expansion opt-in per op. Slot rerank + budget guard + recall-trace write into this skeleton.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/engine.ts — searchKeyword (AND-then-OR websearch fallback) and ftsQuery (lines 316-350): bm25(chunks_fts) AS rank ORDER BY rank with the JOIN chunks_fts.rowid→base table and the tenant/deleted predicate on the BASE table, FTS5-syntax-error try/catch→[]. This is the leak-free FTS isolation form for an external-content table.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0001_init.sql — FTS5 external-content virtual table (content='content_chunks', content_rowid='id') + synchronous insert/delete/update triggers (lines 91-109). Adopt this trigger-synced pattern; external-content table carries NO tenant column (isolation via JOIN).
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0002_search.sql — Per-chunk embedding-state columns embedded_at/embed_error and the page-level staleness rationale. Platform extends with stable ids + per-row embedding_model for model-drift detection.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/search/fts.ts — sanitizeFtsQuery (lines 1-15): strips FTS5 specials ["*()\-] + operators AND|OR|NOT|NEAR and quotes each term — reuse as the hostile-input guard. Do NOT reuse its MATCH ... AND workspace_id=? form (works only for a contentless table with a manual UNINDEXED column; a leak against an external-content table).
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/search/rrf.ts — Generic type-parametric reciprocalRankFusion<T>(lists,k=60) using 1/(k+rank+1). Cite as the variant reused for the entity arm (§4.4), NOT the chunk path — the chunk path uses gbrain's normalize-by-max rrfFusion to avoid double-normalization.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/documents.ts — Hybrid wiring reference (lines 383-434): clean vector|keyword|hybrid mode switch, fetchK over-fetch, bm25→score conversion 1/(1+abs(rank)), reciprocalRankFusion([vec,kw]). Pattern for assembling the two arms before fusion.
- openbrains:/home/roboto/devel/openbrains/packages/services/src/deps/vectorize.ts — createVectorizeClient that hard-wires namespace on every upsert/query (the primary isolation gate) with scope/type/source as metadata filters and the 'D1 row is correctness gate, metadata can lag' rule. Lift verbatim, rename userId→tenantId, add team_id/visibility/embedding_model metadata (trust_grade is sidecar-only, never a Vectorize field).
- openbrains:/home/roboto/devel/openbrains/packages/services/src/search-thoughts.ts — Vector recall: raw-cosine threshold filter (m.score>=threshold) applied BEFORE hydration, scope over-fetch topK=min(100,limit*4) when the metadata index isn't ready, and the re-check-the-row-after-hydration rule for metadata lag. Platform caps over-fetch at the 50 metadata-topK ceiling.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/embeddings/workers-ai.ts — assertWithinTokenBudget (pre-call rejection, ~4 chars/token) and the post-call dimension-mismatch assertion. Reuse both around the embed chokepoint; adapt the 4096 cap → 60,000 for bge-m3.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/recall.ts — Cross-tenant id drop (thought.userId !== args.userId → skip, no existence leak) and the one-memory_recall_traces-row-per-kept-hit audit write (query/score/clientId/at). Reimplement against D1 inside the think/query flow; zero hits → zero traces.

---

## 6. Graph Extraction & Traversal

This section specifies the **graph layer** of the Brain Platform: the unified entity/relationship model, the durable LLM extraction pipeline, typed links + backlinks, the generalized BFS traversal that serves *both* edge tables, tags, timeline, versions, edge/entity dedup, and orphan cleanup — all multi-tenant by construction.

### 6.0 Design decision (locked): TWO graphs, one bridge, never one polymorphic node table

The single most important decision here is structural. We keep **two distinct node types in two distinct edge tables**, joined only through a bridge:

| Graph | Node table | Edge table | Source |
|---|---|---|---|
| **Document/page link graph** | `pages` (the ONLY node space; `documents`/`chunks` are content hanging off a page, NOT nodes — see node-space note) | `doc_links` (typed, provenance, manual + auto; `from_id`/`to_id` are always `pages.id`) | gbrain `links` (`gbrain-cf:migrations/0001_init.sql:52`) + gbrain BFS (`gbrain-cf:src/engine.ts:446`) |
| **Knowledge graph (extracted)** | `entities` (canonical_name + kind + aliases) | `entity_relations` (kind + confidence + evidence) | openbrains `entities`/`entity_relations` (`openbrains:packages/convex/convex/entities.ts`) + cf-graph extraction workflow (`cf-graph:apps/graph/src/api/workflows/entity-extraction.ts`) |
| **Bridge** | — | `entity_mentions(entity_id → source_kind, source_id)` | openbrains `entity_mentions` (`openbrains:packages/convex/convex/entities.ts:253`) |

**Rejected: a single polymorphic `nodes` + `edges` table.** It collapses the per-graph richness (a `doc_link` carries `origin_field`/`context`/`link_source`; an `entity_relation` carries `confidence`/`evidence_chunk_ids`) into a lossy `metadata JSON` blob, makes the unique-dedup constraints impossible to express, and turns every traversal into a polymorphic type-switch. The two-table model is the explicit recommendation from the graph component analysis and is what cf-graph and openbrains already ship.

**The single generalization we DO make:** the BFS implementation is **edge-table-agnostic**, parameterized by `(node_table, edge_table, from_col, to_col)`, so one traversal engine serves `doc_links` AND `entity_relations` (§6.4). gbrain's BFS (`gbrain-cf:src/engine.ts:446`) is hard-wired to `links`/`pages`; we lift its algorithm and parameterize the table names.

**DOC_GRAPH node space — PINNED (iter-3 completeness fix, removes the BFS ambiguity).** The `doc_links` node space is **`pages` only**: `from_id`/`to_id` are **always `pages.id`**, never `documents.id`, and the generalized BFS for the document graph runs with `nodeTable='pages'`. `documents`/`chunks` are **content** that hangs off a page, **not** independent link-graph nodes — exactly gbrain's model, where an ingested document **is** a page (the ingestion path creates/updates the backing `pages` row and links reference that page). A document therefore participates in the link graph **only via its backing page**, so the BFS JOIN target is unambiguous and `from_id`/`to_id` never range over two id namespaces. (If a future phase wants documents as first-class graph nodes, it adds a `documents`-keyed edge table and a third BFS config; v1 does not.)

**Intra-tenant visibility on the graph arms — DECIDED (iter-4 security fix; the §7.5 `{private,team,world}` access tier is structural, not optional).** The traversal/links surface (`traverse_graph`/`get_links`/`get_backlinks`) reads `pages`/`entities` node rows, so the **same** intra-tenant access-tier gate that §7.3/§7.5 enforce on `facts` and `chunks` must hold here, or any private/team content that reaches a node row becomes tenant-wide visible the moment it is graphed. The two arms are **not symmetric**, so they are handled differently:

- **DOC_GRAPH (`pages`) — full visibility gate.** A page is 1:1 with its backing document, so it carries the same tenancy spine. `pages` already has `scope`/`team_id`/`user_id` (§3.1.2); §6.1 adds the missing **`visibility`** column (default `'world'`, populated from the backing document at ingest; manual pages default `'world'`). Every doc-graph read (BFS frontier JOIN, `get_links`, `get_backlinks`) ANDs the same `ScopedDB.scopePredicate()` **and** `ScopedDB.visibilityPredicate({visibility, team_id, user_id})` (§7.3) it applies to chunks — drop-don't-error, no new predicate invented.

- **ENTITY_GRAPH (`entities`) — partitioned by scope, gated to `{world,team}`, NO per-entity private tier (two conscious decisions).** An entity is a canonical **merge** of mentions from many sources. The two governance axes (§7.5) need opposite treatments because the merge behaves differently for each:
  - **Visibility (`{private,team,world}`) → EXCLUDE private.** The dedup key carries **no `user_id`**, so a per-entity `visibility='private'` tier is structurally incoherent (whose `user_id`, when two users privately mention the same name?). Rather than add `user_id` to the key (faithful but messy, and it fragments the canonical-merge the whole KG is built on), **v1 keeps the KG node space non-private**: §6.2 `load-chunks` filters out `visibility='private'` chunks, and entities carry `visibility ∈ {world,team}` (+ `team_id`) merged **max-permissive** (`world` wins; a name seen across multiple teams promotes to `world`). Private knowledge lives **only** in the `facts` store, which §7.5 already gates per-user.
  - **Scope (data partition) → PARTITION, don't merge.** Scope is the agency multi-client boundary (Persona C), and s05 makes scope isolation **required-before-GA** for such tenants — so it cannot be silently merged away the way private is excluded. Instead, `scope` is **part of the entity dedup key** `(tenant_id, COALESCE(scope,''), kind, lower(canonical_name))`: "Acme" under client-A and client-B become **two** entity rows, never one cross-scope node. `entities` therefore carries a `scope` column, and the entity-arm traversal applies the same `scopePredicate()` as the doc arm — a restricted (`allowedScopes`) principal can only walk entities in its granted scopes.

  This is a genuine behavior change from the un-gated baseline (private session chunks currently flow into extraction unfiltered, and entities currently merge across scopes), and it is the deliberate v1 choice: prove the deterministic graph on shared, scope-partitioned (world/team) knowledge first; a private-entity tier with a user-keyed dedup is deferred with semantic dedup (Phase 3.5, §6.6). The entity-arm traversal thus applies `scopePredicate()` + the `{world,team}` visibility predicate (`team_id IN p.teamIds`), never a private branch.

---

### 6.1 Schema (D1 / Drizzle)

Every row carries `tenant_id NOT NULL`. The `pages`/`doc_links`/`tags`/`timeline_entries`/`page_versions` tables are ported from gbrain's `0001_init.sql` with `tenant_id` added; `entities`/`entity_relations`/`entity_mentions` from openbrains' Convex schema, re-expressed as D1 DDL with `tenant_id` and stable nanoid ids (instead of Convex `_id`).

```sql
-- ============ DOCUMENT/PAGE LINK GRAPH ============
-- ported from gbrain-cf:migrations/0001_init.sql:52 (links), + tenant_id, nanoid ids
CREATE TABLE doc_links (
  id            TEXT PRIMARY KEY,                  -- nanoid (cf-graph style; not autoincrement)
  tenant_id     TEXT NOT NULL,
  from_id       TEXT NOT NULL,                     -- ALWAYS a pages.id (the DOC_GRAPH node space; see node-space note below)
  to_id         TEXT NOT NULL,                      -- ALWAYS a pages.id
  link_type     TEXT NOT NULL DEFAULT '',          -- e.g. 'references','supersedes','related'
  link_source   TEXT NOT NULL DEFAULT 'manual',    -- provenance: manual|markdown|frontmatter|mentions|wikilink-resolved
  origin_id     TEXT,                              -- the page/field that emitted an auto-link
  origin_field  TEXT,
  context       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- gbrain's COALESCE-on-nullable unique index, with tenant_id prepended
-- (gbrain-cf:migrations/0001_init.sql:65 — SQLite treats NULL as distinct, so COALESCE)
CREATE UNIQUE INDEX idx_doc_links_unique
  ON doc_links(tenant_id, from_id, to_id, link_type, link_source, COALESCE(origin_id, ''));
CREATE INDEX idx_doc_links_from ON doc_links(tenant_id, from_id);
CREATE INDEX idx_doc_links_to   ON doc_links(tenant_id, to_id);  -- backlinks arm

CREATE TABLE tags (                                -- gbrain-cf:migrations/0001_init.sql:44
  tenant_id TEXT NOT NULL,
  page_id   TEXT NOT NULL,
  tag       TEXT NOT NULL,
  UNIQUE (tenant_id, page_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tenant_id, tag);

CREATE TABLE timeline_entries (                    -- gbrain-cf:migrations/0001_init.sql:69
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  page_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, page_id, date, summary)       -- INSERT OR IGNORE dedup key
);

CREATE TABLE page_versions (                       -- gbrain-cf:migrations/0001_init.sql:34
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  compiled_truth TEXT NOT NULL,                    -- the markdown preview body (full body in R2)
  frontmatter    TEXT NOT NULL DEFAULT '{}',
  snapshot_at    TEXT NOT NULL
);
CREATE INDEX idx_page_versions_page ON page_versions(tenant_id, page_id, snapshot_at DESC);

-- ============ KNOWLEDGE GRAPH (extracted) ============
-- ported from openbrains:packages/convex/convex/entities.ts (upsert/relate/mention/clear)
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,                 -- nanoid
  tenant_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,                    -- person|org|project|concept|...
  canonical_name  TEXT NOT NULL,
  aliases         TEXT NOT NULL DEFAULT '[]',       -- JSON string[] (set-union, capped 50)
  description     TEXT NOT NULL DEFAULT '',
  source_chunk_ids TEXT NOT NULL DEFAULT '[]',      -- JSON string[] (cf-graph mergedChunks)
  mention_count   INTEGER NOT NULL DEFAULT 0,
  -- intra-tenant access tier (§6.0, §7.5). NO 'private' on the KG arm: a canonical
  -- entity is a cross-source MERGE with no single author, so the dedup key carries no
  -- user_id and a per-entity 'private' tier is incoherent. The §6.2 load-chunks step
  -- drops visibility='private' chunks, so only {world,team} ever reach an entity row.
  scope           TEXT,                             -- data-partition axis (§7.3). PARTITIONED, not merged:
                                                    --   in the dedup key, so "Acme" under client-A and
                                                    --   client-B are TWO entity rows, never one cross-scope
                                                    --   node. Lets scopePredicate gate the entity arm for
                                                    --   restricted (Persona C / agency) principals.
  visibility      TEXT NOT NULL DEFAULT 'world'
                  CHECK (visibility IN ('team','world')),  -- merged MAX-permissive (world wins)
  team_id         TEXT,                             -- set only when visibility='team' (single-team origin)
  embedded_at     TEXT, embed_error TEXT,           -- entity-vector staleness (same as chunks, §3.1.1/§6.6)
  embedding_model TEXT, embedding_dims INTEGER,     -- per-row model tracking for brain-entities (§3.2)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL                     -- drives computeStale (updated_at > embedded_at)
);
-- openbrains key (by_user_kind_name) + cf-graph case-insensitivity:
-- store canonical_name as-displayed, but enforce uniqueness on the lowercased form.
-- scope is part of the key (PARTITION-by-scope, §6.0/§7.3): COALESCE(scope,'') so the
-- unrestricted ('*', scope=NULL) partition still dedups (SQLite treats NULL as distinct).
CREATE UNIQUE INDEX idx_entities_key
  ON entities(tenant_id, COALESCE(scope,''), kind, lower(canonical_name));
CREATE INDEX idx_entities_kind ON entities(tenant_id, kind, updated_at DESC);

CREATE TABLE entity_relations (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  from_entity_id     TEXT NOT NULL,
  to_entity_id       TEXT NOT NULL,
  kind               TEXT NOT NULL,                 -- relation type
  confidence         REAL NOT NULL DEFAULT 0.5,     -- 0..1; on conflict -> max
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',    -- JSON string[]; on conflict -> union
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
-- one logical edge per (tenant, from, to, kind); upsert unions evidence + max(confidence)
CREATE UNIQUE INDEX idx_entity_relations_key
  ON entity_relations(tenant_id, from_entity_id, to_entity_id, kind);
CREATE INDEX idx_entity_relations_from ON entity_relations(tenant_id, from_entity_id);
CREATE INDEX idx_entity_relations_to   ON entity_relations(tenant_id, to_entity_id);

-- the BRIDGE: entity KG <-> documents/chunks/sessions/pages
CREATE TABLE entity_mentions (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  source_kind  TEXT NOT NULL,                       -- 'chunk'|'document'|'session'|'page'
  source_id    TEXT NOT NULL,
  span_start   INTEGER,
  span_end     INTEGER,
  created_at   TEXT NOT NULL
);
-- idempotent mention (openbrains: no-op if (entity_id, source) already present)
CREATE UNIQUE INDEX idx_entity_mentions_uniq
  ON entity_mentions(tenant_id, entity_id, source_kind, source_id);
CREATE INDEX idx_entity_mentions_by_source ON entity_mentions(tenant_id, source_kind, source_id);

-- entity FTS5 (tenant isolation enforced by JOIN re-check, per §5g; NOT inside MATCH)
CREATE VIRTUAL TABLE entity_fts USING fts5(
  canonical_name, aliases, description,
  content='entities', content_rowid='rowid'
);
-- + insert/delete/update triggers, gbrain-style (gbrain-cf:migrations/0001_init.sql chunks_fts pattern)
```

**TypeScript node/edge contracts** (in `packages/shared`):

```ts
// shared graph node abstraction — what BFS yields, regardless of which graph
export interface GraphNode {
  id: string;
  label: string;           // pages.title | entities.canonical_name
  type: string;            // pages.type | entities.kind
  depth: number;
  links: { to_id: string; link_type: string }[];
}
export interface GraphPath {
  from_id: string; to_id: string; link_type: string;
  context: string; confidence?: number; depth: number;
}

// the parameterization that makes one BFS serve both graphs
export interface EdgeSpec {
  nodeTable: 'pages' | 'entities';
  edgeTable: 'doc_links' | 'entity_relations';
  fromCol: string;         // 'from_id' | 'from_entity_id'
  toCol: string;           // 'to_id'   | 'to_entity_id'
  labelCol: string;        // 'title'   | 'canonical_name'
  typeCol: string;         // 'type'    | 'kind'
  softDeleteCol?: string;  // 'deleted_at' (pages only)
  // intra-tenant gate columns on the NODE rows (§6.0/§7.5). When present, traverse()
  // ANDs scopePredicate + visibilityPredicate onto the nf/nt JOINs, generically — the
  // same parameterization that lets one engine walk two edge tables. Both node tables
  // carry these; pages has user_id (private tier reachable), entities does not (KG node
  // space is {world,team} only, §6.0), so userCol is doc-graph-only.
  scopeCol?: string;       // 'scope'   (both)
  visibilityCol?: string;  // 'visibility' (both)
  teamCol?: string;        // 'team_id' (both)
  userCol?: string;        // 'user_id' (pages only — private tier)
}
export const DOC_GRAPH: EdgeSpec = {
  nodeTable: 'pages', edgeTable: 'doc_links',
  fromCol: 'from_id', toCol: 'to_id',
  labelCol: 'title', typeCol: 'type', softDeleteCol: 'deleted_at',
  scopeCol: 'scope', visibilityCol: 'visibility', teamCol: 'team_id', userCol: 'user_id',
};
export const ENTITY_GRAPH: EdgeSpec = {
  nodeTable: 'entities', edgeTable: 'entity_relations',
  fromCol: 'from_entity_id', toCol: 'to_entity_id',
  labelCol: 'canonical_name', typeCol: 'kind',
  scopeCol: 'scope', visibilityCol: 'visibility', teamCol: 'team_id',
  // scopeCol IS set: entities are PARTITIONED by scope (in the dedup key, §6.1), so
  // scopePredicate gates the entity arm for restricted principals exactly as on docs.
  // No userCol: the KG node space carries no 'private' tier ({world,team} only, §6.0).
};
```

---

### 6.2 Extraction pipeline (durable Workflow)

**Engine = cf-graph's durable `EntityExtractionWorkflow`** (`cf-graph:apps/graph/src/api/workflows/entity-extraction.ts`), which we adopt near-verbatim but (a) carry `tenantId` through `EntityExtractionParams` and every write, (b) write into the **openbrains-shaped** `entities`/`entity_relations`/`entity_mentions` tables (cf-graph's `kg_entities`/`kg_relationships` are flatter and lack `confidence`/`aliases`), and (c) run `clearForThought`-equivalent cleanup first.

**Triggered by:** the Batch-Ingest Workflow's KG phase (§4.1/§6 of the plan) per document, and by the `SessionPromoteWorkflow` per finalized session. Instance id is deterministic: `kg-${tenantId}-${documentId}` (idempotent under at-least-once; re-trigger = re-extract).

**Step structure** (cf-graph's, parameterized):

```
EntityExtractionParams { tenantId, documentId, sourceKind, sourceId }

step.do('update-status-extracting')          -> documents.status = 'extracting'
step.do('clear-prior-extraction')            -> §6.6 re-extract cleanup (mentions + relation evidence prune)
step.do('load-chunks')                        -> chunks WHERE tenant_id=? AND document_id=?
                                                 AND visibility <> 'private'   -- §6.0 KG node space is
                                                 -- {world,team} only; private-session chunks never
                                                 -- become tenant-wide entities (they stay in `facts`).
                                                 (if empty -> status='indexed', return)
loop batchIndex over chunks in groups of KG_BATCH_SIZE(5):
  step.do(`extract-kg-batch-${batchIndex}`,    -- retries {limit:3, delay:'15s', backoff:'exponential'}
          extractEntitiesFromChunk(batch))     -- cf-graph:apps/graph/src/api/workflows/kg-extraction.ts
step.do('store-kg', {retries:{limit:3, delay:'10s', backoff:'exponential'}})
                                              -> §6.3 upsert entities / relate / mention (D1 batch)
step.do('embed-entities', {retries:{limit:3, delay:'10s', backoff:'exponential'}})
                                              -> §6.6 embed canonical_name+description (bge-m3) and
                                                 upsert into brain-entities (vector.id == entities.id,
                                                 namespace=tenantId; stamp embedded_at/embedding_model
                                                 on the entity row). Idempotent: re-embed upserts same id.
step.do('finalize')                           -> documents.status = 'indexed'
catch -> step.do('mark-failed')               -> status='indexed' w/ kg_error stamped (non-fatal:
                                                 a doc is still searchable even if KG extraction fails)
```

**LLM call (extraction)** — `@cf/meta/llama-3.1-8b-instruct` with **belt-and-suspenders JSON robustness**: openbrains' `response_format: { type: 'json_object' }` (`openbrains:packages/ingest/src/entities/workers-ai.ts`) **plus** cf-graph's `extractJsonFromText` 3-strategy truncation salvage (`cf-graph:apps/graph/src/api/workflows/kg-extraction.ts:13`: parse-as-is → slice first-brace…last-brace → trim back to last complete object). Extraction output shape:

```ts
interface KgExtractionResult {
  entities: { name: string; kind: string; aliases: string[]; description: string; chunkIds: string[] }[];
  relationships: { source: string; target: string; relKind: string;
                   description: string; confidence: number; chunkIds: string[] }[];
}
```

The LLM emits no access tier — it is **derived deterministically from the source chunks**, never model-supplied: each extracted entity/relation carries the `scope` and the **max-permissive** `visibility`/`team_id` of the chunks it was extracted from (`load-chunks` already loaded `chunks.scope`/`chunks.visibility`/`chunks.team_id` alongside content, and dropped `private`, §6.2), so `store-kg` passes `e.scope`/`e.visibility`/`e.teamId` into `upsertEntity` (§6.3). `scope` is part of the dedup key (partition), while `visibility`/`team_id` are merged max-permissive. This keeps the governance axes out of the untrusted LLM output and on the trusted chunk rows.

Each `step.do` returns **counts only** (`{entitiesCreated, entitiesUpdated, relationsCreated}`), never the entity payloads — staying under the 1 MiB step-output cap (§0).

---

### 6.3 Entity upsert / relate / mention (ported openbrains algorithms → D1)

openbrains' algorithms (`openbrains:packages/convex/convex/entities.ts`) ported from Convex mutations to D1 `INSERT ... ON CONFLICT DO UPDATE` + `db.batch`. All writes go through `ScopedDB` so `tenant_id` is injected; the explicit `tenant_id` here is illustrative.

**Upsert entity** (key `(tenant_id, kind, lower(canonical_name))`; aliases = set-union capped 50 — openbrains `dedupeCapped`, `entities.ts:196,233`; cf-graph case-insensitive merge, `entity-extraction.ts:137`). The extracted `e` carries the access tier derived from its source chunks (`e.visibility ∈ {world,team}`, `e.teamId` — `load-chunks` already dropped `private`, §6.2); on merge the tier is **max-permissive** (`world` wins, and a name seen under two different teams promotes to `world` with `team_id=NULL`), so an entity can only ever become *more* visible as evidence accrues, never silently leak in the wrong direction:

```ts
// max-permissive visibility merge for the KG node space ({world,team} only, §6.0)
function mergeVisibility(a: {visibility:string; teamId:string|null},
                         b: {visibility:string; teamId:string|null}) {
  if (a.visibility === 'world' || b.visibility === 'world') return {visibility:'world', teamId:null};
  // both 'team': same team keeps it; cross-team promotes to world (no single owning team)
  return a.teamId === b.teamId ? {visibility:'team', teamId:a.teamId} : {visibility:'world', teamId:null};
}

async function upsertEntity(db: ScopedDB, e: ExtractedEntity): Promise<string> {
  const id = nanoid();
  // ON CONFLICT unions aliases + chunkIds in JS isn't possible inline; do read-modify-write
  // in the same batch is not transactional across awaits in D1, so:
  // scope is part of the key (PARTITION-by-scope, §6.1): COALESCE so the unrestricted
  // ('*', scope NULL) partition matches itself. e.scope is the source chunks' scope.
  const existing = await db.first<{id:string; aliases:string; source_chunk_ids:string; mention_count:number; visibility:string; team_id:string|null}>(
    `SELECT id, aliases, source_chunk_ids, mention_count, visibility, team_id FROM entities
     WHERE tenant_id = ? AND COALESCE(scope,'') = COALESCE(?,'') AND kind = ? AND lower(canonical_name) = lower(?)`,
    [e.scope, e.kind, e.name]);
  if (!existing) {
    await db.run(
      `INSERT INTO entities (id,tenant_id,scope,kind,canonical_name,aliases,description,source_chunk_ids,mention_count,visibility,team_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, e.scope, e.kind, e.name, JSON.stringify(dedupeCapped(e.aliases,50)), e.description,
       JSON.stringify(uniq(e.chunkIds)), e.chunkIds.length, e.visibility, e.teamId, now(), now()]);
    return id;
  }
  const aliases = dedupeCapped([...JSON.parse(existing.aliases), ...e.aliases], 50);  // openbrains union cap 50
  const chunks  = uniq([...JSON.parse(existing.source_chunk_ids), ...e.chunkIds]);    // cf-graph mergedChunks
  const vis     = mergeVisibility(existing, {visibility:e.visibility, teamId:e.teamId}); // max-permissive
  await db.run(
    `UPDATE entities SET aliases=?, source_chunk_ids=?, mention_count=mention_count+?, visibility=?, team_id=?, updated_at=? WHERE id=?`,
    [JSON.stringify(aliases), JSON.stringify(chunks), e.chunkIds.length, vis.visibility, vis.teamId, now(), existing.id]);
  return existing.id;
}
```

**Relate** (on conflict: evidence union + `confidence = max` — openbrains `relateInternal`, `entities.ts:308,337-343`). With the `idx_entity_relations_key` unique index this can be a single statement plus an evidence-merge read-modify-write, but since SQLite can't `array_union` in SQL we mirror openbrains' pattern:

```ts
async function relate(db: ScopedDB, r: ExtractedRelation, fromId: string, toId: string) {
  const m = await db.first(`SELECT id, confidence, evidence_chunk_ids FROM entity_relations
     WHERE tenant_id=? AND from_entity_id=? AND to_entity_id=? AND kind=?`, [fromId, toId, r.relKind]);
  if (!m) {
    await db.run(`INSERT INTO entity_relations (id,tenant_id,from_entity_id,to_entity_id,kind,confidence,evidence_chunk_ids,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`,
      [nanoid(), fromId, toId, r.relKind, r.confidence, JSON.stringify(uniq(r.chunkIds)), now(), now()]);
    return;
  }
  const evidence = uniq([...JSON.parse(m.evidence_chunk_ids), ...r.chunkIds]);   // union
  await db.run(`UPDATE entity_relations SET confidence=?, evidence_chunk_ids=?, updated_at=? WHERE id=?`,
    [Math.max(m.confidence, r.confidence), JSON.stringify(evidence), now(), m.id]);  // max
}
```

**Mention** (idempotent via `idx_entity_mentions_uniq` — openbrains `mentionInternal` no-op on dup, `entities.ts:253`):

```ts
await db.run(`INSERT OR IGNORE INTO entity_mentions (id,tenant_id,entity_id,source_kind,source_id,span_start,span_end,created_at)
              VALUES (?,?,?,?,?,?,?,?)`, [nanoid(), entityId, sourceKind, sourceId, span?.start, span?.end, now()]);
```

The `store-kg` step batches all upserts/relations/mentions with `db.batch([...])`; relation resolution maps extracted source/target names → entity ids via the same lowercased key cf-graph uses (`entity-extraction.ts:231`), now including `scope` (so both endpoints resolve **within the same scope partition** — a batch carries one scope, §6.1), skipping a relation if either endpoint failed to resolve. Because both endpoints are scope-partitioned entities, a relation never bridges two scopes; the traversal-time `scopePredicate` on the node JOINs is the enforcing gate regardless.

---

### 6.4 Generalized BFS traversal (one engine, both graphs)

Lifted from gbrain's `traverseGraph`/`traversePaths` (`gbrain-cf:src/engine.ts:446,479`) — JS BFS with a `visited` Map, `IN (...)` frontier expansion per layer, `direction: in|out|both`, depth clamp `1..10` (gbrain `ops/core.ts:300`: `Math.max(1, Math.min(depth ?? 5, 10))`). The changes beyond `tenant_id` are (a) parameterizing the table/column names via `EdgeSpec` so the same code walks `doc_links` and `entity_relations`, and (b) the **intra-tenant access gate (iter-4 security fix, §6.0)**: the `startId` is resolved through a **scoped node lookup before** the BFS begins (an out-of-grant start yields an empty traversal — drop-don't-error, no existence leak), and the per-layer frontier query ANDs `scopePredicate` + `visibilityPredicate` onto the `nf`/`nt` node JOINs so a walk can neither start from nor cross into a node the principal cannot see.

```ts
async function traverse(db: ScopedDB, spec: EdgeSpec, startId: string,
                        depth: number, direction: 'in'|'out'|'both'): Promise<GraphPath[]> {
  const d0 = Math.max(1, Math.min(depth, 10));                  // gbrain clamp
  const paths: GraphPath[] = [];

  // *** gate the SEED (iter-4): resolve startId through a scoped node lookup. An
  // out-of-grant / out-of-visibility start returns nothing here, so the BFS never
  // begins — an empty traversal, NOT a 403 (drop-don't-error: no existence leak that
  // would tell a caller "this id exists but isn't yours"). ScopedDB.nodeVisible()
  // applies tenant_id + scopePredicate + visibilityPredicate against spec.nodeTable. ***
  if (!(await db.nodeVisible(spec, startId))) return paths;

  const visited = new Set<string>([startId]);
  let frontier = [startId];
  const soft = spec.softDeleteCol ? `AND nf.${spec.softDeleteCol} IS NULL AND nt.${spec.softDeleteCol} IS NULL` : '';
  // node-row access gate, built generically from EdgeSpec (§6.1). Applied to BOTH
  // endpoints of every edge, so the walk cannot cross into an unreadable node. The
  // SQL fragments + binds come from ScopedDB so the principal's scope/visibility are
  // never caller-supplied. `nodeGate('nf')` => e.g.
  //   AND nf.scope IN (...) AND (nf.visibility='world'
  //                              OR (nf.visibility='team' AND nf.team_id IN (...))
  //                              OR (nf.visibility='private' AND nf.user_id = ?))   -- pages only
  const gateF = db.nodeGate(spec, 'nf');   // {sql, binds}
  const gateT = db.nodeGate(spec, 'nt');   // {sql, binds}

  for (let d = 1; d <= d0 && frontier.length; d++) {
    const ph = frontier.map(() => '?').join(',');
    const clauses: string[] = [];
    if (direction === 'out' || direction === 'both') clauses.push(`e.${spec.fromCol} IN (${ph})`);
    if (direction === 'in'  || direction === 'both') clauses.push(`e.${spec.toCol}   IN (${ph})`);
    const binds: unknown[] = [];
    for (const _ of clauses) binds.push(...frontier);
    // *** tenant_id on EVERY hop — the easiest predicate to forget (plan §5) — AND the
    // intra-tenant node gate on both JOINed endpoints (iter-4 §6.0). ***
    const sql = `
      SELECT e.${spec.fromCol} AS fid, e.${spec.toCol} AS tid, e.${spec.typeCol ?? 'link_type'} AS link_type,
             COALESCE(e.context,'') AS context, e.confidence AS confidence
      FROM ${spec.edgeTable} e
      JOIN ${spec.nodeTable} nf ON nf.id = e.${spec.fromCol}
      JOIN ${spec.nodeTable} nt ON nt.id = e.${spec.toCol}
      WHERE e.tenant_id = ? AND (${clauses.join(' OR ')}) ${soft}
        ${gateF.sql} ${gateT.sql}`;
    const rows = await db.all<{fid:string;tid:string;link_type:string;context:string;confidence?:number}>(
      sql, [/* tenant injected by ScopedDB */, ...binds, ...gateF.binds, ...gateT.binds]);

    const next: string[] = [];
    for (const r of rows) {
      // gbrain CTE parity: only emit an edge that reaches an unvisited node,
      // so a bidirectional walk doesn't re-emit the edge it arrived on (engine.ts:519)
      if (visited.has(r.fid) && visited.has(r.tid)) continue;
      paths.push({ from_id: r.fid, to_id: r.tid, link_type: r.link_type,
                   context: r.context, confidence: r.confidence, depth: d });
      for (const c of [r.fid, r.tid]) if (!visited.has(c)) { visited.add(c); next.push(c); }
    }
    frontier = next;
  }
  return paths;
}
```

`traverse_graph(slug_or_id, depth, direction, graph='doc'|'entity')` selects `DOC_GRAPH` or `ENTITY_GRAPH`, resolves `slug_or_id` to a node id **through the same scoped lookup** (`db.nodeVisible`/`resolveScopedNode`, so a slug the principal can't see resolves to nothing → empty traversal, not an existence leak), and calls `traverse`. The node-centric variant (`traverseGraph`, `engine.ts:446`) that returns `GraphNode[]` with adjacency lists is parameterized — and gated — identically.

**Cross-tenant hop is impossible** because (a) `ScopedDB` injects `tenant_id = ?` into the frontier query, and (b) the `JOIN`ed node rows are themselves tenant-scoped — even if two tenants share a slug, the `IN (...)` frontier holds tenant-A node *ids*, and edges are keyed by id within the tenant. **Intra-tenant over-reach is impossible** because (c) the seed is resolved through a scoped node lookup before the walk, and (d) the `nf`/`nt` node JOINs carry `scopePredicate` + `visibilityPredicate`, so a frontier id that *names* an unreadable node yields no rows and the walk dead-ends there. A dedicated **blocking CI BFS-isolation test** (plan §5i) seeds an edge in tenant B from a colliding slug and asserts a tenant-A depth-3 traverse never returns it; a companion **intra-tenant test** (§6.8) seeds a private/other-team node mid-path and asserts the walk stops at the gate.

---

### 6.5 Typed links, backlinks, tags, timeline, versions

Ported wholesale from gbrain (`gbrain-cf:src/engine.ts`), `tenant_id`-scoped via `ScopedDB`:

- **add_link / remove_link** — `engine.ts:383,402`. `addLink` is `INSERT ... ON CONFLICT DO UPDATE SET context = excluded.context` against `idx_doc_links_unique`; this is the **edge dedup** mechanism (§6.6). `link_source` records provenance (`manual` for user-created; `markdown|frontmatter|mentions|wikilink-resolved` for auto-derived — the reserved `MANAGED_LINK_SOURCES` set, `gbrain-cf:src/ops/core.ts:8`). The MCP `add_link` op refuses to manually write a managed source (`ops/core.ts:239`) so re-ingestion can safely delete-and-recreate auto links without clobbering hand-authored ones.
- **get_links / get_backlinks** — `engine.ts:426,435`. Backlinks use `idx_doc_links_to`; both filter out soft-deleted endpoints (`pt.deleted_at IS NULL`) **and apply the same intra-tenant node gate as BFS** (iter-4 §6.0): the JOINed page endpoints carry `scopePredicate` + `visibilityPredicate({visibility, team_id, user_id})`, and the anchor id is resolved through the scoped node lookup, so neither op returns a link touching a page the principal cannot see (drop-don't-error — an out-of-grant anchor yields an empty list, not a 403). These two ops are read surfaces over the node space exactly like `traverse_graph`, so they were named in the same finding and share the gate.
- **add_tag / remove_tag / get_tags** — `engine.ts:362-372`, unique `(tenant_id, page_id, tag)`.
- **add_timeline_entry / get_timeline** — `engine.ts:541,555`. `INSERT OR IGNORE` on `(tenant_id, page_id, date, summary)` for idempotent re-ingest; ordered `date DESC, id DESC`.
- **get_versions / revert_version** — `engine.ts:566,581`. `revertToVersion` snapshots current state into `page_versions` *before* restoring (a `db.batch` of insert-snapshot + update-page, `engine.ts:593`) so revert is itself reversible. This is the storage substrate the deferred frozen-snapshot feature (plan §6) pins immutable version ids against.
- **list_link_sources** — `gbrain-cf:src/platform.ts:122`, provenance counts grouped by `link_source`.

**MCP tool surface (graph)** = union of gbrain + cf-graph + openbrains:
`traverse_graph`, `get_links`, `get_backlinks`, `add_link`, `remove_link`, `find_orphans`, `add_tag`, `remove_tag`, `get_tags`, `add_timeline_entry`, `get_timeline`, `get_versions`, `revert_version`, `list_entities`, `get_entity`, `entity_relations`, `search_entities`, `list_link_sources`. (`search_entities` — entity *vector search* over `brain-entities`, optionally fused with `entity_fts` — is **in v1**; see §6.7. Only cross-session **semantic** fact dedup stays deferred to Phase 3.5, §6.6.)

---

### 6.6 Dedup & orphan cleanup

**Edge dedup (two graphs, two mechanisms):**
- `doc_links`: the `idx_doc_links_unique` index + `ON CONFLICT DO UPDATE` (gbrain `addLink`, `engine.ts:392`). Re-adding the same typed edge updates context, never duplicates.
- `entity_relations`: the `idx_entity_relations_key` index + the relate read-modify-write (§6.3) that **unions evidence and takes max confidence** (openbrains, `entities.ts:337`).

**Entity dedup:** v1 uses the **deterministic key** `(tenant_id, kind, lower(canonical_name))` + alias set-union only (openbrains `upsertInternal` + cf-graph lowercased merge). **Cross-session semantic dedup (nearest-vector merge before insert) remains explicitly DEFERRED to Phase 3.5** behind a flag — v1 entity dedup stays deterministic key + alias union. This is the over-engineering guard: prove the deterministic graph in production before adding vector *dedup*.

**Entity vectors + `search_entities` (IN v1):** the `brain-entities` Vectorize index (1024-dim cosine, `namespace=tenantId`, §3.2) **is provisioned in v1**. On entity upsert (§6.3), the entity is embedded from its **canonical name + description** (`@cf/baai/bge-m3`, the same `embed()` chokepoint as chunks) and upserted into `brain-entities` keyed by `vector.id == entities.id`, carrying the same per-row staleness/embedding-model tracking as chunks (`embedded_at`/`embed_error`/`embedding_model`/`embedding_dims`; re-embed on `updated_at > embedded_at`). The metadata blob carries the entity-arm gate columns `{ scope, team_id, visibility, embedding_model, tenant_id }` (the KG node space is `{world,team}` only and scope-partitioned, §6.0/§6.1). **`search_entities`** does a **scoped vector search** over `brain-entities` (`ScopedVectorize`, `namespace=tenantId`, with the tenant + node scope/visibility gate folded into the metadata filter exactly as on chunks, then the authoritative D1 re-check on `entities` via `scopePredicate` + the `{world,team}` `visibilityPredicate`), **optionally fused with `entity_fts`** (the keyword arm, §6.1) via the same RRF the chunk search uses. Provisioning entity vectors does **not** pull in semantic dedup; that stays deferred (above). The re-extract cleanup (`clear-prior-extraction`) already deletes orphaned entity vectors by id (§6.6 cleanup), now against a live v1 index.

**Re-extract cleanup (the `clear-prior-extraction` step):** ported from openbrains `clearForThoughtInternal` (`openbrains:packages/convex/convex/entities.ts:358`). Before re-extracting a source (edited doc / re-finalized session), it:
1. Deletes that source's `entity_mentions` rows (`WHERE tenant_id=? AND source_kind=? AND source_id=?` — uses `idx_entity_mentions_by_source`).
2. Prunes the source's chunk ids out of every `entity_relations.evidence_chunk_ids`; **a relation whose evidence becomes empty is deleted outright** (no longer supported by any source).
3. Deletes orphaned **entity vectors** in `brain-entities` by id (v1 index, §6.6; idempotent/retry-safe per plan §5h — a stale-but-not-deleted vector cannot leak because the D1 row is the existence gate).
This runs first on *every* extract, so stale mentions/relations never accumulate. Idempotent under Workflow retry.

**Orphan reporting (`find_orphans`):** ported from gbrain `findOrphans` (`gbrain-cf:src/platform.ts:141`). For the doc graph: pages with zero in- AND out-links (`NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.from_id=p.id OR l.to_id=p.id)`), excluding pseudo-pages (`slug` starting `_` or containing `/_`) unless `includePseudo`. Returns `{orphans, total_orphans, total_linkable, total_pages, excluded}`. **Generalized to the entity graph:** "entity with no `entity_relations`" using the same `NOT EXISTS` shape against `entity_relations` (the analysis's generalization). `find_orphans` is a **report**, not a deleter — it surfaces disconnected nodes for human review; actual deletion is the soft-delete path on `pages`, not an automatic graph sweep. **It is still a node read surface**, so it carries the same `ScopedDB` scope/visibility node gate as traversal (§6.8): a report that listed another user's private page or an out-of-scope entity would itself be an intra-tenant leak, so the `NOT EXISTS` query runs under the principal's `scopePredicate` + `visibilityPredicate`.

---

### 6.7 Request flows

**A. Extract on ingest** (Batch-Ingest Workflow → KG phase):
`document indexed → trigger kg-${tenantId}-${docId} → clear prior extraction → load chunks → extract batches of 5 (llama-3.1-8b, json_object + salvage) → store-kg (upsert entities, relate, mention; embed canonical_name+description → upsert brain-entities; all db.batch) → finalize`. Entity vectors are embedded and upserted into `brain-entities` in v1 (§6.6).

**A′. Search entities** (MCP `search_entities`):
`resolvePrincipal → ScopedVectorize(namespace=tenantId) → embed(query) → vector search over brain-entities with scope/visibility folded into the metadata filter → [optional] fuse with entity_fts via RRF → D1 re-check on entities (scopePredicate + {world,team} visibilityPredicate, drop-don't-error) → return entity hits`.

**B. Traverse** (MCP `traverse_graph`):
`resolvePrincipal → ScopedDB(principal) → select EdgeSpec by graph param → resolve slug_or_id through scoped node lookup (out-of-grant/out-of-visibility → empty result, no existence leak) → clamp depth 1..10 → BFS (every frontier query carries tenant_id + the scope/visibility node gate on both endpoints) → return GraphPath[] | GraphNode[]`.

**C. Backlinks for a doc:** `ScopedDB → resolve anchor through scoped node lookup → get_backlinks(id) via idx_doc_links_to → filter soft-deleted + apply scope/visibility node gate on JOINed endpoints → return Link[]`.

**D. Re-extract after edit:** identical to (A); the `clear-prior-extraction` step guarantees the second run is a clean replace, not an append.

---

### 6.8 Edge cases & invariants

- **Slug collision across tenants:** two tenants may both have page `meeting-notes`; BFS holds tenant-scoped *ids*, never slugs, and the frontier query is `tenant_id`-filtered — no cross-tenant walk. (Blocking CI test.)
- **Intra-tenant access tier (scope + visibility) — INVARIANT (iter-4 security fix, §6.0/§7.5).** Within one tenant, **no graph read surface** may return a node (or an edge/relation touching a node) that the principal's `allowedScopes` + `{private,team,world}` tier excludes. This is a **`ScopedDB` contract on every `pages`/`entities` read**, not a per-op rule (mirroring §7.3, where `visibilityPredicate`/`scopePredicate` are un-omittable on every row carrying those columns): the node gate rides automatically on `traverse_graph`, `get_links`, `get_backlinks`, **and** the entity read surfaces `list_entities`/`get_entity`/`entity_relations`/`find_orphans` — anything that resolves a node row. Enforced structurally: (i) any seed `startId`/`slug`/anchor is resolved through a **scoped node lookup**, so an out-of-grant start yields an empty result — *not* a 403 and *not* an existence-leaking error (drop-don't-error); (ii) every node JOIN (`nf`/`nt`, or the single-row lookup) ANDs `scopePredicate` + `visibilityPredicate`, so a walk dead-ends at the first unreadable node rather than crossing it. On the entity arm the visibility branch reduces to `{world,team}` (the KG node space carries no `private`, §6.0) while `scopePredicate` applies in full (entities are scope-partitioned, §6.1). **Blocking CI test:** seed, within ONE tenant, a depth-2 path A→B→C where B (or C) is `visibility='private'` of another user (doc graph) / a `visibility='team'` node of a team the principal is not in / an entity in a non-granted `scope` (entity graph, restricted principal); assert a traverse from A as the restricted principal returns A→(stops), never reaching the gated node, that a direct `traverse_graph(slug_of_gated_node)` returns empty (no existence leak), and that `list_entities`/`find_orphans` never enumerate the gated node. This is the intra-tenant companion to the cross-tenant slug-collision test above; both are blocking.
- **Self-loop / cycle:** `visited` Set short-circuits; the "only emit edge to unvisited node" rule (`engine.ts:519`) prevents re-emitting the arrival edge on a `both`-direction walk.
- **Orphaned edge after node delete:** `pages` soft-delete (`deleted_at`) + BFS/`getLinks` filter on `deleted_at IS NULL`, so a deleted node's edges silently vanish from traversal without a cascade.
- **Extraction returns malformed/truncated JSON:** `extractJsonFromText` 3-strategy salvage; if all fail, the batch step throws → Workflow retries 3× exponential; if still failing, the doc is marked `indexed` with `kg_error` (KG extraction is non-fatal — the doc stays searchable).
- **Relation endpoint unresolved:** if an extracted relation names an entity that failed to upsert, the relation is skipped (cf-graph `entity-extraction.ts:233` guards `if (sourceId && targetId)`).
- **D1 100-param limit:** frontier `IN (...)` queries are bounded; if a frontier exceeds ~90 ids, chunk it into sub-queries (BFS already iterates layer-by-layer, so this is a per-layer chunk loop, not a redesign).
- **Re-extract racing in-flight vector indexing:** deterministic entity ids + D1-as-existence-gate mean a racing upsert converges rather than duplicating (plan §5h).
- **Empty evidence relation:** deleted on prune, never left dangling (openbrains rule).

#### Code references

- gbrain-cf:/home/roboto/devel/gbrain-cf/src/engine.ts — traverseGraph/traversePaths JS BFS (depth clamp, direction in|out|both, visited Map, IN(...) frontier, CTE-parity edge emission at :519); getLinks/getBacklinks (:426/:435); addLink ON CONFLICT DO UPDATE edge dedup (:392); addTag/removeTag/getTags (:362-372); addTimelineEntry INSERT OR IGNORE/getTimeline (:541-555); getVersions/revertToVersion snapshot-before-restore db.batch (:566-602). Port wholesale + tenant_id + EdgeSpec parameterization.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0001_init.sql — links DDL with link_type/link_source/origin_page_id/origin_field + COALESCE-on-nullable unique index (:52-67); tags/timeline_entries/page_versions DDL. Port + tenant_id, nanoid ids, FTS5 external-content trigger pattern for entity_fts.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/platform.ts — findOrphans (zero in/out links, NOT EXISTS, pseudo-page exclusion, returns total_orphans/total_linkable/total_pages/excluded, :141) and listLinkSources provenance counts (:122). Generalize findOrphans to entity_relations.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/core.ts — traverse_graph op: depth clamp Math.max(1,Math.min(depth??5,10)) (:300); MANAGED_LINK_SOURCES reserved provenance set (:8) and refusal to manually write managed sources (:239).
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/entity-extraction.ts — Durable EntityExtractionWorkflow: step structure (update-status -> load-chunks -> extract-kg-batch-${i} -> store-kg -> finalize/mark-failed), KG_BATCH_SIZE=5, retries {limit:3, backoff:'exponential'}, case-insensitive entity merge (:137), merged chunk ids (:171), relation endpoint resolution guard (:233). Adopt + tenant_id; write into openbrains-shaped tables instead of kg_entities/kg_relationships.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/kg-extraction.ts — extractJsonFromText 3-strategy truncation salvage (parse / first-brace..last-brace slice / trim to last complete object, :13); extractEntitiesFromChunk llama-3.1-8b call. Combine with openbrains response_format json_object.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/entities.ts — Entity algorithms to port to D1: upsertInternal key (userId,kind,canonicalName)+dedupeCapped alias union cap 50 (:196,233); relateInternal evidence-union + confidence=max on conflict (:308,337); mentionInternal idempotent no-op-on-dup (:253); clearForThoughtInternal re-extract cleanup deleting mentions + pruning relation evidence + deleting empty relations (:358). Generalize userId->tenant_id, thoughtId->source_id.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/entities/workers-ai.ts — createWorkersAiEntityExtractor: llama-3.1-8b + response_format json_object, canonicalName/kind/aliases + typed relation kinds + confidence, strict per-field parsing of untrusted LLM output.

---

## 7. Multi-Tenant Company Brain: Auth, Scoping, Trust & Audit

This section specifies the security spine of Brain Platform: the identity model, the authentication resolver, the single choke-point that makes cross-tenant access *impossible by construction* (not by convention), the Vectorize namespace strategy, application-level RLS on D1, the trust-grade governance model, and the append-only audit + recall-trace machinery.

The design fuses three proven patterns from the mined repos and removes Convex entirely:
- **openbrains' isolation-by-construction**: `requireUserId` as the auth-first invariant (`openbrains:packages/convex/convex/_lib/identity.ts`) and `createVectorizeClient` hard-wiring `namespace` on every call (`openbrains:packages/services/src/deps/vectorize.ts`). We generalize `userId` → `tenantId`.
- **cf-graph's multi-token resolver chain**: `cliTokenFallback` unifying Clerk JWT → API key → CLI JWT into one identity (`cf-graph:apps/graph/src/api/middleware/auth.ts`), HMAC CLI tokens (`cf-graph:apps/graph/src/api/services/cli-tokens.ts`), and the `/mcp/<slug>` rewrite (`cf-graph:apps/graph/src/mcp/workspace-scoped-handler.ts`).
- **gbrain's OAuth wiring** via `@cloudflare/workers-oauth-provider` (`gbrain-cf:src/mcp-oauth.ts`, `oauth-props.ts`) and its epistemic fact model (`gbrain-cf:migrations/0004_facts.sql`).

The one structural gap in all three is **a membership model** — none of them has org→team→user. cf-graph scopes by a single `userId`-owned `workspace`; gbrain is single-tenant (`gbrain-cf:src/oauth-props.ts` `AuthInfo` carries no userId/tenant); openbrains scopes by `userId` only. We add `orgs`/`teams`/`memberships` as net-new.

---

### 7.1 Identity model (org → team → user → client/scope)

The hierarchy every isolatable row hangs off:

- **org** = the tenant = the hard isolation boundary (`tenant_id`). A company.
- **team** = an optional sub-partition inside a tenant (`team_id`).
- **user** = authorship/actor (`user_id`), resolved from the auth identity.
- **scope** = a project/client sub-partition (`scope`), porting openbrains `projects` (`openbrains:packages/convex/convex/schema.ts` lines 12-20) but adding `tenant_id`/`team_id`. Unscoped rows are tenant-global, matching openbrains' "scope undefined = visible from any project view" rule (schema.ts lines 8-11).

**Tenancy & auth tables (Drizzle / D1).** Every column is `NOT NULL` except where optionality is meaningful.

```ts
// packages/db/schema.ts  (Drizzle, SQLite/D1)
export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  name: text('name').notNull(),
  slug: text('slug').notNull(),              // unique tenant slug
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({ slugUx: uniqueIndex('orgs_slug_ux').on(t.slug) }));

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
}, (t) => ({ teamUx: uniqueIndex('teams_tenant_slug_ux').on(t.tenantId, t.slug) }));

// NET-NEW: no mined project has a membership model.
export const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  tenantId: text('tenant_id').notNull(),
  userId: text('user_id').notNull(),         // Clerk sub
  teamId: text('team_id'),                    // null = tenant-wide membership
  role: text('role').notNull(),               // 'owner'|'admin'|'member'|'readonly'
  // DATA-partition grant (NOT capabilities). NULL = '*' = all tenant scopes — the
  // default that honors Persona C "staff move freely between clients". A non-null
  // JSON string[] restricts the principal to those client/project scopes; the
  // agency-hard-isolation variant sets this per member. (iteration-2 scope fix.)
  allowedScopes: text('allowed_scopes'),      // JSON string[] | NULL(='*')
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  byUser: index('memberships_user_ix').on(t.userId),
  byTenant: index('memberships_tenant_ix').on(t.tenantId, t.userId),
}));

export const scopes = sqliteTable('scopes', {            // ports openbrains `projects`
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  tenantId: text('tenant_id').notNull(),
  teamId: text('team_id'),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
}, (t) => ({ scopeUx: uniqueIndex('scopes_tenant_slug_ux').on(t.tenantId, t.slug) }));

// SHA-256 hash, bound to exactly one tenant. Fuses cf-graph api_keys + openbrains apiKeys.
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  tenantId: text('tenant_id').notNull(),      // a key is bound to ONE tenant
  userId: text('user_id').notNull(),          // the minting actor
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),        // sha256(rawKey)
  keyPrefix: text('key_prefix').notNull(),    // display prefix, cf-graph pattern
  scopes: text('scopes').notNull().default('[]'),   // CAPABILITY axis JSON string[] e.g. ["read","write"]
  // DATA-partition grant for the key (iter-3 escalation fix). NULL = '*' = all
  // tenant scopes — but '*' is stored ONLY when the MINTER was itself '*'. A
  // restricted minter (allowedScopes=['clientA']) stores the intersection of the
  // requested grant with its own allowedScopes, so a non-* member can NEVER mint a
  // key that widens its own data partition. Populates Principal.allowedScopes in
  // the bk_ branch (§7.2), NOT the capability axis.
  allowedScopes: text('allowed_scopes'),      // JSON string[] | NULL(='*' iff minter was '*')
  readOnly: integer('read_only').notNull().default(0),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (t) => ({ byHash: uniqueIndex('api_keys_hash_ux').on(t.keyHash) }));

// device-code flow, ported verbatim from cf-graph
export const cliAuthSessions = sqliteTable('cli_auth_sessions', { /* ...cf-graph... */ });
export const cliRefreshTokens = sqliteTable('cli_refresh_tokens', { /* ...cf-graph... */ });

// NET-NEW: the shard map read by ScopedDB/ScopedVectorize. v1: one row per tenant
// pointing at the single shared DB + the two base indexes (§5e of the plan).
export const tenantShards = sqliteTable('tenant_shards', {
  tenantId: text('tenant_id').primaryKey(),
  dbBinding: text('db_binding').notNull(),     // 'DB' in v1
  chunkIndex: text('chunk_index').notNull(),   // 'brain-chunks' in v1
  entityIndex: text('entity_index'),           // 'brain-entities' in v1
});
```

`apiKeys` keeps cf-graph's prefix + SHA-256 hash + `readOnly` + fire-and-forget `lastUsedAt` (`cf-graph:apps/graph/src/api/services/api-keys.ts` `generateApiKey`/`validateApiKey`) but replaces cf-graph's `workspaceIds[]` JSON array with a single `tenant_id` column — a key in Brain Platform is bound to exactly one tenant, which is strictly safer than a key that can reference an arbitrary set of workspaces. openbrains' `apiKeys.verify` documents the one legitimate exception to the auth-first rule (`openbrains:packages/convex/convex/apiKeys.ts` lines 70-94): verification establishes identity from a possessed key, so it looks up by hash, never the raw key, and returns `null` (not the row) for unknown/expired keys.

**Mint-time data-partition derivation (iter-3 escalation fix).** A key's `allowed_scopes` is **derived from the minter's membership at mint time, never hard-coded to `'*'`**. `mintApiKey` computes `allowed_scopes = intersect(requestedGrant, minter.allowedScopes)` where `minter.allowedScopes === '*'` is the identity element (a `'*'` minter may store `NULL`=`'*'` or any finite grant; a restricted minter can only ever store a subset of its own grant — widening is structurally impossible). Without this, a restricted Persona-C member (`allowedScopes=['clientA']`) could mint a key and immediately read the *entire* tenant across all client scopes — a one-step privilege escalation that defeats the same cross-scope isolation `assertScopeAllowed`/`scopePredicate` enforce. The mint mutation emits an `apiKey.mint` audit row carrying the stored grant (§7.6).

---

### 7.2 Principal — the resolved identity carried below the edge

`resolvePrincipal()` runs once per request at the Worker edge and reduces *any* credential to one immutable object. **No bare token travels below the edge** — every service, Workflow step, and Queue handler receives a `Principal`. (This is the canonical `Principal` contract from §1.4; reproduced here with the auth-spine resolution chain for self-containment.)

```ts
// packages/shared/src/principal.ts — the ONE canonical shape (§1.4); §9 references it.
export interface Principal {
  tenantId: string;            // the hard boundary; never optional
  userId: string;              // authorship / actor
  teamIds: readonly string[];  // teams the user belongs to within this tenant
  role: 'owner' | 'admin' | 'member' | 'readonly';
  // DATA-partition axis: client/project scopes the principal may touch.
  // '*' = all tenant scopes (the default — Persona C "staff move freely").
  allowedScopes: readonly string[] | '*';
  // CAPABILITY axis (NOT a data partition): read|write|admin. Sourced from the
  // API key's stored scopes JSON, or derived from role. Consumed by scopeSatisfied.
  capabilities: readonly ('read' | 'write' | 'admin')[];
  readOnly: boolean;           // true if role==='readonly' OR the credential is RO
}
```

> **iteration-2 fix — two axes, one shape.** Earlier drafts of §7.2/§9 used a single `scopes` field for both "client/project slugs" and "read|write|admin", and the API-key branch fed `["read","write"]` into the data-partition predicate (so `documents.scope IN ('read','write')` matched nothing — or, worse, a client literally named `read`). `allowedScopes` (data) and `capabilities` (capability) are now separate fields, sourced separately and consumed by separate code, matching the §1.4 canonical contract.

**Clerk is the confirmed OAuth 2.1 upstream IdP** (DECIDED — matches gbrain-cf + openbrains; not "IdP TBD"). The Bearer-JWT branch below verifies a Clerk-issued token (jose `jwtVerify` against Clerk's JWKS, issuer-checked, via openbrains' `createClerkRemoteVerifier`); Clerk is the single OAuth 2.1 upstream for the platform's human-auth surface, and the `@cloudflare/workers-oauth-provider` wiring (below) fronts it.

**Resolution chain** (try in order; first match wins — generalizes cf-graph's `cliTokenFallback`, `cf-graph:apps/graph/src/api/middleware/auth.ts`):

```ts
async function resolvePrincipal(req: Request, env: Env): Promise<Principal | null> {
  const auth = req.headers.get('Authorization') ?? '';

  // Canonical credential prefixes: bdev_ (machine token), bk_ (API key).
  // 1. OAuth 2.1 / Clerk JWT  (jose jwtVerify vs JWKS, issuer-checked)
  //    Port openbrains createClerkRemoteVerifier (openbrains:apps/mcp/src/auth/clerk.ts).
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer && !bearer.startsWith('bdev_') && !bearer.startsWith('bk_')) {
    const id = await clerkVerifier(env).verify(bearer).catch(() => null);  // {userId, email?}
    if (id) return await principalFromMembership(env, id.userId, requestedTenant(req));
  }

  // 2. HMAC machine token  (bdev_ pattern; tenant baked into claims)
  //    Port signDeviceToken/verifyDeviceToken (openbrains:apps/mcp/src/auth/device-token.ts).
  if (bearer?.startsWith('bdev_')) {
    const claims = await verifyDeviceToken(env.DEVICE_FLOW_SECRET, bearer, () => Date.now());
    if (claims) return await principalFromMembership(env, claims.userId, claims.tenantId);
  }

  // 3. API key  (bk_ prefix, SHA-256 hash, tenant-bound)
  if (bearer?.startsWith('bk_')) {
    const row = await validateApiKey(env.DB, bearer);   // by hash; null on revoked/expired
    if (row) return {
      tenantId: row.tenantId, userId: row.userId, teamIds: [],
      role: row.readOnly ? 'readonly' : 'member',
      // The key's stored scopes JSON is the CAPABILITY axis (read|write|admin).
      capabilities: parseCapabilities(row.scopes),   // e.g. ['read','write']
      // DATA-partition axis: read from the key's stored allowed_scopes, which was
      // pinned at mint time to the intersection of the request with the MINTER's
      // grant (§7.1). NULL means '*' — and a NULL is only ever stored when the
      // minter was itself '*', so a restricted minter's key can never widen to '*'.
      // (iter-3 escalation fix: previously hard-coded to '*', which let a restricted
      // member mint a tenant-wide key in one step.)
      allowedScopes: row.allowedScopes === null ? '*' : parseScopeGrant(row.allowedScopes),
      readOnly: row.readOnly,
    };
  }
  return null;  // 401 — see WWW-Authenticate handling below
}

// Membership lookup: turns a (userId, tenantId) into a fully-scoped Principal.
async function principalFromMembership(env: Env, userId: string, tenantId: string)
  : Promise<Principal | null> {
  const rows = await env.DB.prepare(
    'SELECT team_id, role, allowed_scopes FROM memberships WHERE user_id = ? AND tenant_id = ?')
    .bind(userId, tenantId)
    .all<{ team_id: string|null; role: Principal['role']; allowed_scopes: string|null }>();
  if (rows.results.length === 0) return null;             // not a member → no Principal
  const role = highestRole(rows.results.map(r => r.role)); // owner>admin>member>readonly
  // allowedScopes = union of the member's per-row grants. A NULL grant (or owner/admin)
  // means '*' (all tenant scopes). Only when EVERY row is a restricted list do we
  // intersect to that finite set — never '[]' (which would mean "no scopes").
  const allowedScopes: readonly string[] | '*' =
    (role === 'owner' || role === 'admin' || rows.results.some(r => r.allowed_scopes === null))
      ? '*'
      : [...new Set(rows.results.flatMap(r => JSON.parse(r.allowed_scopes!) as string[]))];
  // capabilities derived from role: readonly→['read']; member/admin/owner→['read','write']
  // (+ 'admin' for owner/admin). The API-key path overrides this from the key's scopes.
  const capabilities: readonly ('read'|'write'|'admin')[] =
    role === 'readonly' ? ['read']
    : role === 'member' ? ['read', 'write']
    : ['read', 'write', 'admin'];
  return {
    tenantId, userId,
    teamIds: rows.results.map(r => r.team_id).filter((x): x is string => x !== null),
    role, allowedScopes, capabilities, readOnly: role === 'readonly',
  };
}
```

> **`requestedTenant(req)` (the active-tenant selector for the Clerk-JWT path).** A JWT alone does not name a tenant, so `requestedTenant` resolves the *requested* tenant from a single pinned mechanism per surface — **MCP:** the signed `/mcp/<slug>` slug; **REST:** a validated `X-Brain-Tenant` header; **dashboard:** a server-side session pin. When none is supplied the resolver returns an **error (401)**, never a silent first-membership default (which could write to the wrong tenant). The chosen value is always re-checked against `memberships` inside `principalFromMembership`, so the mechanism is a UX/ergonomics choice, not a trust boundary — a forged tenant a user is not a member of yields `null` → 401.

```ts
// (continued — type guard used above)
function parseCapabilities(scopesJson: string): readonly ('read'|'write'|'admin')[] {
  try { return (JSON.parse(scopesJson) as string[])
    .filter((s): s is 'read'|'write'|'admin' => s === 'read' || s === 'write' || s === 'admin'); }
  catch { return ['read']; }
}

// Data-partition grant stored on the key (NULL handled by the caller as '*'). A
// malformed grant fails closed to '[]' = no scopes, never '*'. (iter-3 fix.)
function parseScopeGrant(grantJson: string): readonly string[] {
  try { const g = JSON.parse(grantJson); return Array.isArray(g) ? (g as string[]) : []; }
  catch { return []; }
}
```

**Machine-token claims** carry `tenantId` so a token resolves without a Clerk round-trip. The `DeviceTokenClaims` interface (`openbrains:apps/mcp/src/auth/device-token.ts` lines 24-32) is extended with `tenantId: string`. The HMAC sign/verify (`signDeviceToken`/`verifyDeviceToken`) and the base64url helpers port verbatim — they are already Workers-portable (Web Crypto, `crypto.subtle`).

**OAuth provider wiring.** `@cloudflare/workers-oauth-provider` owns `/authorize`, `/token`, `/register`, and provider metadata, exactly as in `gbrain-cf:src/mcp-oauth.ts` and `openbrains:apps/mcp/src/index.ts`. Brain Platform reuses openbrains' two extensions:
1. `resolveExternalToken` recognizes `bdev_` HMAC bearers (the platform's canonical machine-token prefix — openbrains' source uses `obdev_`, which we rebrand) and returns `{ props: { userId, tenantId, email? } }` so the same `apiHandler` sees `ctx.props` (openbrains index.ts lines 51-66).
2. The RFC 8628 device-code pre-filter on `fetch` intercepts `POST /token` with the device-code grant and the device-authorization endpoints before they reach the provider (openbrains index.ts lines 75-142).

We also port gbrain's `wrapOAuthResponse` (`gbrain-cf:src/mcp-oauth.ts` lines 45-81): rewrite `http://`→`https://` in AS metadata behind tunnels and add `resource_metadata` (RFC 9728) to the 401 `WWW-Authenticate` header so MCP connectors auto-discover the protected-resource document.

**Edge default-scope pinning.** Port openbrains' `session-scope-store` (`openbrains:packages/services/.../session-scope-store.ts` is referenced via `apps/mcp/src/mcp/session-scope-store.ts`): a per-`(tenantId,userId)` default scope is pinned in `OAUTH_KV` under a `session-scope:` prefix, and `withSessionDefaultScope` splices it into tool input only when the caller did not supply `scope` (tool-supplied scope always wins). Key shape becomes `session-scope:${tenantId}:${userId}` to keep it tenant-isolated.

---

### 7.3 The single choke-point: ScopedDB, ScopedVectorize, ScopedR2

D1 has no native row-level security. We substitute **application-level RLS** by making the raw bindings unreachable outside one package and forcing all access through Principal-constructed wrappers that inject the tenant predicate. This is openbrains' `requireUserId`-first discipline (`openbrains:packages/convex/convex/_lib/identity.ts`) hardened from a convention into a structural control.

**ScopedDB** — a repository over Drizzle constructed with a `Principal`. It never exposes a raw table handle **and exposes no raw-SQL passthrough** (there is no `.all(sql, binds)`-style escape hatch that a caller could use to bind only `tenant_id` and skip the scope/visibility gates); every read goes through a typed method that injects `tenant_id = ?` (+ the `scopePredicate`, + the `visibilityPredicate` on visibility-bearing tables), and it resolves the tenant's shard binding from `tenant_shards`. This applies uniformly to the typed arms — `listDocuments`/`hydrateChunks`/`readFacts` **and** the graph-arm methods `getLinks`/`expandFrontier` (used by `traverse_graph`/`get_links`/`get_backlinks` and the §7.4 BFS) — so no read arm can inject the tenant binding while skipping the scope gate.

```ts
// packages/db/scoped-db.ts  — the ONLY module allowed to touch env.DB
export class ScopedDB {
  private constructor(private readonly db: DrizzleD1, private readonly p: Principal) {}

  static async forPrincipal(env: Env, p: Principal): Promise<ScopedDB> {
    const shard = await env.DB.prepare(
      'SELECT db_binding FROM tenant_shards WHERE tenant_id = ?').bind(p.tenantId)
      .first<{ db_binding: string }>();
    const binding = shard?.db_binding ?? 'DB';
    return new ScopedDB(drizzle(env[binding] as D1Database), p);  // v1: always 'DB'
  }

  // Authorization helper: assert an EXPLICIT scope argument is one the principal
  // may touch. '*' (or owner/admin) may name any scope; a restricted principal
  // naming an out-of-grant scope is rejected 403 (mirrors the drop-don't-error
  // discipline used for tenant_id, but for the explicit-request path). (iter-2 fix)
  private assertScopeAllowed(scope: string) {
    if (this.p.allowedScopes === '*') return;
    if (!this.p.allowedScopes.includes(scope))
      throw new ForbiddenError(`scope '${scope}' not in this principal's allowedScopes`);
  }

  // Build the scope predicate that ALWAYS applies (the drop-don't-error gate):
  // a restricted principal can only ever see rows in its granted scopes, even on
  // an unscoped query. '*' adds no predicate. Returns undefined for '*'.
  private scopePredicate() {
    return this.p.allowedScopes === '*'
      ? undefined
      : inArray(documents.scope, [...this.p.allowedScopes]);
  }

  // ── Visibility predicate (iter-3 CRITICAL fix: intra-tenant RLS) ─────────────
  // The access tier of §7.5 ({private, team, world}) is an UN-OMITTABLE part of
  // the Scoped* contract, NOT a per-op convention. It is enforced HERE, at the
  // single choke-point, on every read of a row that carries a `visibility` column
  // — drop-don't-error, exactly like the tenant/scope gates. Moving
  // namespace=userId → namespace=tenantId (§7.4) dissolved openbrains' only
  // per-user enforcement (recall.ts:36 thought.userId !== args.userId); this
  // predicate is its structural replacement, riding on the userId/teamIds that
  // Principal already carries (zero new plumbing). It applies to the `facts`
  // store AND to `chunks` (§4.9 carries visibility/user_id/team_id), so the
  // hybrid/think arm is gated too: ingested-document chunks default
  // visibility='world' (org/team knowledge → predicate is a no-op), while
  // session-transcript chunks inherit the session's visibility (a private
  // session is private on the hybrid arm, not just its promoted facts). See §7.5.
  //
  //   visibility='world'                                  → any member of the tenant
  //   visibility='team'  AND team_id IN (:p.teamIds)      → members of the row's team
  //   visibility='private' AND user_id = :p.userId        → only the author
  //
  // owner/admin do NOT bypass this on the DEFAULT recall/think path — a fact
  // authored private by user A is private even from an admin's recall. The ONE
  // exception is an explicit, role-gated, fully-audited BREAK-GLASS read surface
  // (§7.6 ScopedDB.breakGlassReadPrivate): it is a separate, deliberately-invoked
  // call (an admin-only tool / breakGlass:true param that fails CLOSED for
  // non-admins → 403), NOT this predicate going soft. visibilityPredicate itself
  // is still un-omittable on every default read; break-glass is a distinct method
  // that does not run this predicate and writes a memory_audit row + fires an alert
  // on every invocation. The default recall/think/graph path NEVER bypasses this.
  private visibilityPredicate(t: { visibility: Column; teamId: Column; userId: Column }) {
    const teamClause = this.p.teamIds.length > 0
      ? and(eq(t.visibility, 'team'), inArray(t.teamId, [...this.p.teamIds]))
      : sql`0`;                                            // no teams → no team rows
    return or(
      eq(t.visibility, 'world'),
      teamClause,
      and(eq(t.visibility, 'private'), eq(t.userId, this.p.userId)),
    );
  }

  // Every read auto-applies the tenant predicate AND the allowedScopes gate.
  // Callers cannot omit either.
  async listDocuments(opts?: { scope?: string }) {
    const where = [eq(documents.tenantId, this.p.tenantId)];
    if (opts?.scope) {
      this.assertScopeAllowed(opts.scope);          // explicit out-of-grant → 403
      where.push(eq(documents.scope, opts.scope));
    } else {
      const sp = this.scopePredicate();             // restricted → AND scope IN (grants)
      if (sp) where.push(sp);                        // '*' → no extra predicate
    }
    return this.db.select().from(documents).where(and(...where));
  }

  // Drop-don't-error hydration (openbrains memory/recall.ts rule): an id from
  // another tenant — OR from a scope outside allowedScopes — returns nothing.
  // This is the gate that closes the VECTOR arm's scope leak (the Vectorize
  // query itself is not trusted to enforce scope). No existence leak. (iter-2 fix)
  async hydrateChunks(ids: readonly string[]) {
    const where = [eq(chunks.tenantId, this.p.tenantId), inArray(chunks.id, [...ids])];
    if (this.p.allowedScopes !== '*') where.push(inArray(chunks.scope, [...this.p.allowedScopes]));
    where.push(this.visibilityPredicate({                   // iter-3: intra-tenant RLS on the hybrid/think arm
      visibility: chunks.visibility, teamId: chunks.teamId, userId: chunks.userId }));
    return this.db.select().from(chunks).where(and(...where));  // out-of-grant / out-of-visibility ids silently absent
  }

  // Facts read (recall, get_session_context, hot-memory): tenant + scope + the
  // VISIBILITY predicate are all injected here. This is the choke-point §8.4
  // recall and the §8.5 get_session_context injection route through — neither
  // builds its own WHERE. (iter-3 CRITICAL fix: every facts read passes through
  // visibilityPredicate, so a new read surface inherits intra-tenant RLS for free,
  // not as a per-query convention it could forget.)
  async readFacts(where: SQL[] = []) {
    const base = [eq(facts.tenantId, this.p.tenantId)];
    const sp = this.scopePredicate2(facts.scope);          // restricted → AND scope IN (grants)
    if (sp) base.push(sp);
    base.push(this.visibilityPredicate({                    // UN-OMITTABLE access tier
      visibility: facts.visibility, teamId: facts.teamId, userId: facts.userId }));
    return this.db.select().from(facts)
      .where(and(...base, ...where, isNull(facts.expiredAt)));
  }
  // scopePredicate generalized to an arbitrary table's scope column (facts/chunks/links).
  private scopePredicate2(scopeCol: Column) {
    return this.p.allowedScopes === '*' ? undefined : inArray(scopeCol, [...this.p.allowedScopes]);
  }

  // ── Graph arm (iter-3 CRITICAL fix: no raw-SQL escape hatch for graph reads) ──
  // traverse_graph / get_links / get_backlinks and the §7.4 BFS frontier are TYPED
  // methods here — ScopedDB exposes NO raw-SQL passthrough (no `.all(sql, binds)`)
  // that a graph read could use to bind only `tenant_id` and bypass the scope /
  // visibility gates. Each frontier `IN (...)` query is built HERE and injects the
  // SAME three predicates every other read does: tenant_id (always), the
  // scopePredicate (restricted principals can only hop within their granted
  // scopes), and — once a graph node/page carries a `visibility` column — the
  // visibilityPredicate. Without this, a restricted Persona-C staffer
  // (allowedScopes=['clientA']) could traverse a shared slug into a scope='clientB'
  // page within the same tenant; the node-gate now stops the hop. The same
  // `nodeGate` (scope AND visibility) the BFS ANDs onto `nf`/`nt` is applied to
  // BOTH link endpoints here, so getLinks/expandFrontier gate identically to the
  // BFS — not edge-scope-only. Re-hydrating returned node ids through
  // hydrateChunks/listDocuments remains as defense-in-depth (a second, final
  // gate), no longer the ONLY node-level gate.
  //
  // getLinks/expandFrontier take the same EdgeSpec (§6.1) the BFS uses, so they
  // are not hardwired to `docLinks`/`pages`; `spec.edgeTable`/`fromCol`/`toCol`
  // name the relation, `spec.nodeTable` the endpoint node table. nodeGate(spec,'nf')
  // gates the FROM endpoint, nodeGate(spec,'nt') the TO endpoint — both endpoints,
  // each on scope AND visibility, exactly like the BFS frontier JOIN.
  async getLinks(spec: EdgeSpec, fromId: string, dir: 'out' | 'in') {
    const anchorCol = dir === 'out' ? spec.fromCol : spec.toCol;
    const gf = this.nodeGate(spec, 'nf');                // FROM-endpoint node gate
    const gt = this.nodeGate(spec, 'nt');                // TO-endpoint node gate
    return this.all(
      `SELECT e.* FROM ${spec.edgeTable} e
         JOIN ${spec.nodeTable} nf ON nf.id = e.${spec.fromCol} AND nf.tenant_id = e.tenant_id
         JOIN ${spec.nodeTable} nt ON nt.id = e.${spec.toCol}   AND nt.tenant_id = e.tenant_id
        WHERE e.tenant_id = ? AND e.${anchorCol} = ?
          ${gf.sql} ${gt.sql}`,                          // BOTH endpoints node-gated
      [this.p.tenantId, fromId, ...gf.binds, ...gt.binds]);
  }
  // BFS frontier expansion — one hop. Tenant + the SAME node-gate on BOTH endpoints.
  async expandFrontier(spec: EdgeSpec, ids: readonly string[]) {
    const gf = this.nodeGate(spec, 'nf');
    const gt = this.nodeGate(spec, 'nt');
    const ph = ids.map(() => '?').join(',');
    return this.all(
      `SELECT e.* FROM ${spec.edgeTable} e
         JOIN ${spec.nodeTable} nf ON nf.id = e.${spec.fromCol} AND nf.tenant_id = e.tenant_id
         JOIN ${spec.nodeTable} nt ON nt.id = e.${spec.toCol}   AND nt.tenant_id = e.tenant_id
        WHERE e.tenant_id = ? AND e.${spec.fromCol} IN (${ph})
          ${gf.sql} ${gt.sql}`,                          // out-of-grant/visibility endpoints never enumerated
      [this.p.tenantId, ...ids, ...gf.binds, ...gt.binds]);
  }

  // ── Node-scope/visibility gate for the generalized BFS (the contract §6.4/§6.5/§6.8
  //    calls). One generic gate, parameterized by EdgeSpec (§6.1), serves BOTH node
  //    tables: `pages` (full {private,team,world} + userCol) and `entities`
  //    ({world,team} only — no userCol, the KG node space carries no private tier,
  //    §6.0). All three helpers below are pure ScopedDB members, so tenant_id + the
  //    principal's scope/visibility are injected here, never caller-supplied. ──
  //
  //    NOT an injection surface: nodeGate/nodeVisible/resolveScopedNode (and the
  //    getLinks/expandFrontier endpoint JOINs) build SQL by interpolating EdgeSpec
  //    field names (nodeTable/edgeTable, fromCol/toCol, scopeCol/visibilityCol/
  //    teamCol/userCol/softDeleteCol) and the fixed `nf`/`nt`/`n` aliases — every
  //    one of those identifiers is validated at EdgeSpec construction against a
  //    fixed allowlist of known table/column names (§6.1), never arbitrary or
  //    caller-supplied input; all *values* are bound parameters (`?`). ──

  // nodeGate(spec, alias) → { sql, binds }: the SQL predicate fragment + binds that
  // §6.4 ANDs onto each frontier node JOIN (`nf`/`nt`). Mirrors scopePredicate +
  // visibilityPredicate as raw SQL against a JOINed node alias. '*' / no-team / a
  // spec without the column each drop the corresponding clause. Returns empty SQL
  // when the principal is unrestricted AND the node table carries no visibility col.
  nodeGate(spec: EdgeSpec, alias: string): { sql: string; binds: unknown[] } {
    const parts: string[] = []; const binds: unknown[] = [];
    // scope partition (both node tables carry spec.scopeCol)
    if (spec.scopeCol && this.p.allowedScopes !== '*') {
      const grants = [...this.p.allowedScopes];
      parts.push(`AND ${alias}.${spec.scopeCol} IN (${grants.map(() => '?').join(',')})`);
      binds.push(...grants);
    }
    // visibility tier (pages: world|team|private; entities: world|team — no userCol)
    if (spec.visibilityCol) {
      const v = `${alias}.${spec.visibilityCol}`;
      const branches = [`${v} = 'world'`];
      if (spec.teamCol && this.p.teamIds.length > 0) {
        branches.push(`(${v} = 'team' AND ${alias}.${spec.teamCol} IN (${this.p.teamIds.map(() => '?').join(',')}))`);
        binds.push(...this.p.teamIds);
      }
      if (spec.userCol) {                                // doc graph only — private tier reachable
        branches.push(`(${v} = 'private' AND ${alias}.${spec.userCol} = ?)`);
        binds.push(this.p.userId);
      }
      parts.push(`AND (${branches.join(' OR ')})`);
    }
    return { sql: parts.join(' '), binds };
  }

  // nodeVisible(spec, id) → boolean: the seed/anchor check §6.4 runs BEFORE the BFS
  // begins. An out-of-grant / out-of-visibility start returns false → empty traversal,
  // NOT a 403 and not an existence-leaking error (drop-don't-error, §6.8). tenant_id +
  // the same scope/visibility gate as nodeGate, applied to a single row of spec.nodeTable.
  async nodeVisible(spec: EdgeSpec, id: string): Promise<boolean> {
    const g = this.nodeGate(spec, 'n');
    const soft = spec.softDeleteCol ? `AND n.${spec.softDeleteCol} IS NULL` : '';
    // this.first/this.all/this.run are the package-internal raw-SQL helpers the graph
    // arm uses (§6.3/§6.4); they are NOT exposed outside packages/db (no caller escape
    // hatch — the no-raw-SQL-passthrough rule above is about the public surface).
    const row = await this.first(
      `SELECT 1 FROM ${spec.nodeTable} n
        WHERE n.id = ? AND n.tenant_id = ? ${soft} ${g.sql} LIMIT 1`,
      [id, this.p.tenantId, ...g.binds]);
    return row != null;
  }

  // resolveScopedNode(spec, slugOrId) → node id | null: scoped seed/anchor resolution
  // used by traverse_graph / get_links / get_backlinks before the walk. Resolves a slug
  // (or id) to a node id ONLY if the principal may see it — a slug the principal can't
  // see resolves to null → empty result, no existence leak (§6.4/§6.8). Same gate as
  // nodeVisible; matches on id or slug within spec.nodeTable.
  async resolveScopedNode(spec: EdgeSpec, slugOrId: string): Promise<string | null> {
    const g = this.nodeGate(spec, 'n');
    const soft = spec.softDeleteCol ? `AND n.${spec.softDeleteCol} IS NULL` : '';
    const row = await this.first<{ id: string }>(
      `SELECT n.id FROM ${spec.nodeTable} n
        WHERE n.tenant_id = ? AND (n.id = ? OR n.slug = ?) ${soft} ${g.sql} LIMIT 1`,
      [this.p.tenantId, slugOrId, slugOrId, ...g.binds]);
    return row?.id ?? null;
  }

  // Mutations: every write batches its memory_audit row in the SAME db.batch.
  // Body-supplied partition fields are validated before the write (iter-3 fix):
  // scope must pass assertScopeAllowed; team_id must be in p.teamIds; user_id is
  // forced to p.userId (never body-controlled); a visibility upgrade to
  // 'world'/'team' beyond the author's role is constrained (see §7.10).
  async writeFact(input: FactInput) {
    if (this.p.readOnly) throw new ForbiddenError('read-only principal');
    if (input.scope) this.assertScopeAllowed(input.scope);              // out-of-grant scope → 403
    if (input.teamId && !this.p.teamIds.includes(input.teamId))         // can't write to a team you're not in
      throw new ForbiddenError(`team '${input.teamId}' not in this principal's teamIds`);
    const userId = this.p.userId;                                       // authorship forced, never body-controlled
    const visibility = constrainVisibility(input.visibility, this.p);   // role-constrained (see §7.10)
    return this.db.batch([
      this.db.insert(facts).values({ ...input, userId, visibility, tenantId: this.p.tenantId }),
      this.db.insert(memoryAudit).values({
        tenantId: this.p.tenantId, userId: this.p.userId,
        action: 'fact.create', targetId: input.id, at: Date.now(),
      }),
    ]);
  }
}
```

**ScopedVectorize** — lifts openbrains `createVectorizeClient` (`openbrains:packages/services/src/deps/vectorize.ts`) and renames `userId`→`tenantId`. The client hard-wires `namespace: tenantId` on every upsert/query — physically impossible to omit — and resolves the index (shard) from `tenant_shards`. `team_id`/`scope`/`embedding_model` are metadata filters *within* the namespace.

```ts
// packages/db/scoped-vectorize.ts  — the ONLY module allowed to touch env.<index>
export function createScopedVectorize(binding: VectorizeBinding, p: Principal) {
  return {
    async upsert(input: { id: string; values: number[]; metadata: ChunkMeta }) {
      await binding.upsert([{
        id: input.id, values: input.values,
        namespace: p.tenantId,                          // hard-wired, like openbrains
        metadata: { ...input.metadata, tenant_id: p.tenantId }, // belt-and-suspenders
      }]);
    },
    // iter-3 recall-cliff fix: fold the principal's stable partition predicates
    // INTO the metadata filter so a restricted principal spends its (≤100) topK
    // budget inside its granted partition, not on tenant-wide top rows the D1 gate
    // would discard (the silent recall cliff). ALL granted scopes (one or many)
    // collapse to a SINGLE filtered query via {scope:{$in:[...granted scopes]}} —
    // the form §5.3.2 agrees on (Vectorize supports $in), so a multi-grant
    // principal gets ONE filtered query, never a per-scope fan-out/union.
    // visibility is NOT pushed (it would drop the principal's own private chunks
    // the D1 re-check can't recover — §5.3.2); it stays authoritative at D1. For
    // '*' this is a no-op. Best-effort (the D1 re-check is still authoritative).
    foldPartitionFilter(filter?: VectorFilter): VectorFilter | undefined {
      if (p.allowedScopes === '*') return filter;
      return { ...filter, scope: { $in: [...p.allowedScopes] } }; // one query, any # of grants
    },
    async query(input: { values: number[]; topK: number; filter?: VectorFilter }) {
      // iter-2 fix: an EXPLICIT scope filter must be authorized before it is passed
      // through. (The Vectorize result is ALSO re-checked at the D1 gate via
      // ScopedDB.hydrateChunks, which drops any out-of-grant scope id — so a missing
      // metadata index or a forged filter cannot leak another client's scope.)
      // The scope filter is shape-aware: a plain string {scope} OR the folded
      // {scope:{$in:[...]}} form (foldPartitionFilter) — every named scope must be
      // in the grant. (Folded filters are self-derived from the grant, so they pass;
      // the check still rejects a forged explicit $in / string that escapes it.)
      if (input.filter?.scope && p.allowedScopes !== '*') {
        const f = input.filter.scope;
        const named = typeof f === 'string' ? [f] : (f.$in ?? []);
        const bad = named.find((s) => !p.allowedScopes.includes(s));
        if (bad) throw new ForbiddenError(`scope '${bad}' not in allowedScopes`);
      }
      const res = await binding.query(input.values, {
        topK: Math.min(input.topK, 100),                // Vectorize topK max is 100; it drops to
                                                        // 50 ONLY with returnValues:true or
                                                        // returnMetadata:'all' — we set neither, so
                                                        // 100 is available even with a metadata filter (§5.3)
        namespace: p.tenantId,                          // cannot be forgotten
        filter: input.filter,                           // {scope}, {team_id}
        returnMetadata: 'indexed',
      });
      return res.matches.map((m) => ({ id: m.id, score: m.score }));
    },
  };
}
```

**ScopedR2** — prefixes every key with `${tenantId}/`. `put`/`get`/`delete` reject keys that do not start with the principal's tenant prefix.

**Enforcement is a control, not a convention (plan §5i).** A custom ESLint banned-import rule makes the raw `env.DB`, raw Vectorize index, and raw R2 bindings importable *only* inside `packages/db`. Any `env.DB.prepare(...)` / raw `.query(` / raw `.put(` outside `packages/db` fails lint. Blocking CI isolation tests (required before merge) include a cross-tenant read test, a dedicated FTS-arm leak test, a BFS cross-tenant-hop test, a Vectorize-recheck test, **a cross-scope test** (§10.6 canary #7), **a graph-arm cross-scope test** (§10.6 canary #13, iter-3 CRITICAL fix), **and intra-tenant visibility tests** (§10.6 canary #8/#9, iter-3 CRITICAL fix): a restricted-`allowedScopes` principal naming another client's scope explicitly gets `403`, an unscoped query returns only its granted scopes — on the FTS arm, the vector arm, **the graph arm (`traverse_graph`/`get_links`/`get_backlinks`)**, and `ScopedDB.listDocuments` — **and** a non-author, non-teammate user B in the same tenant cannot recall/search/`think`/`get_session_context` a `private` fact authored by user A, a teammate CAN recall a `team` fact while a non-teammate in the same tenant CANNOT, and the author recalls both. Canary #13 mirrors #7 on the graph arm: a restricted-`allowedScopes` principal that `traverse_graph`/`get_links`/`get_backlinks` from a slug shared across scopes must not return another client's-scope pages within the same tenant. The table-driven canary meta-test treats `visibility` as a third isolation axis, so adding a facts/chunks read surface without routing it through `readFacts`/`visibilityPredicate` — or a graph read surface that does not route through the typed scope-gated frontier methods — fails the meta-test.

---

### 7.4 Vectorize namespace strategy + D1 as correctness gate

**`namespace = tenantId`, never `userId`.** A Vectorize namespace is a query-time partition parameter — it *scopes the search space* and is the same **class** of mechanism as a metadata filter; Cloudflare does not document it as a security/isolation boundary. So the tenant guarantee does **not** rest on the namespace being "physical." It rests on two things the platform owns: (a) `createScopedVectorize` hard-wires `namespace = tenantId` on every upsert/query, so a forgotten namespace is impossible (callers never build the raw query), and (b) the mandatory D1 row re-check (below) drops any id whose live `tenant_id` does not match. Within the namespace, `userId`/`teamId`/`scope`/`visibility`/`embedding_model` ride as filterable metadata. This is operationally safer than cf-graph's metadata-only `filter:{workspaceId}` on a shared index (`cf-graph:apps/graph/src/api/services/documents.ts` ~line 400) — there a forgotten filter leaks the whole index, whereas here the namespace cannot be forgotten and the D1 re-check is a second gate. The choice of `tenantId` over `userId` (`openbrains:packages/services/src/deps/vectorize.ts`) is justified on **team-recall** grounds: `namespace=userId` physically blocks a teammate from recalling shared evidence; it is not claimed as a stronger security boundary than `namespace=userId`.

**Metadata indexes are created before any filtered upsert** (Vectorize requires this):
```
wrangler vectorize create-metadata-index brain-chunks --property-name=scope      --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=team_id    --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=visibility --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=embedding_model --type=string
```
Vectorize caps at 10 metadata indexes / 64 B each — budget reserved for the above plus `source`.

**D1 is the correctness gate (eventual consistency rule).** Vectorize metadata lags writes. After every vector query, the kept ids are re-JOINed to live D1 rows through `ScopedDB.hydrateChunks` and re-checked on `tenant_id`/`scope`/`deleted_at`. Cross-tenant ids are **silently dropped** — the exact rule openbrains uses (`openbrains:packages/convex/convex/memory/recall.ts` lines 36-38: `if (thought === null || thought.userId !== args.userId) continue;`). No existence leak.

**FTS5 isolation (plan §5g).** FTS5 external-content tables cannot carry `tenant_id` inside `MATCH`. Every `MATCH` result is JOINed back to the tenant-scoped base table via `ScopedDB` and re-checked on `tenant_id`/`scope`/`deleted_at` before any row leaves the bm25 arm — identical in spirit to the Vectorize re-check. A `MATCH`-then-unscoped-read is forbidden and is the subject of a dedicated blocking CI test. We keep gbrain's external-content trigger-synced FTS (`gbrain-cf:migrations/0001_init.sql`) and cf-graph's `sanitizeFtsQuery` hardening (`cf-graph:apps/graph/src/api/search/fts.ts`).

**BFS traversal carries `tenant_id` AND the node-gate (scope AND visibility) on BOTH endpoints of every hop** (iter-3 CRITICAL fix — the graph arm is a scope gate too, not just a tenant gate): a shared slug must not let the generalized BFS (over `doc_links` or `entity_relations`) walk across tenants **or across client scopes within a tenant**. Every frontier query includes `tenant_id = ?` and, for a restricted principal, applies the same `nodeGate` (scope `IN (grants)` **and** the visibility tier) to **both** the FROM-node (`nf`) and the TO-node (`nt`) endpoints — identical to the gate the §7.3 BFS already ANDs onto its frontier JOIN — so a restricted Persona-C staffer (`allowedScopes=['clientA']`) cannot `traverse_graph`/`get_links`/`get_backlinks` into a `scope='clientB'` (or out-of-visibility) page. The link-arm `ScopedDB.getLinks`/`expandFrontier` methods (§7.3) gate identically to the BFS — both endpoints, not edge-scope-only — and there is no raw-SQL path that binds only `tenant_id`. The visibility clause of `nodeGate` is emitted only when the node table's `EdgeSpec` declares a `visibilityCol` (the `pages`/`entities` specs do — §6.0); a node table that does not yet carry a `visibility` column simply contributes no visibility clause, and its ids are gated on tenant + scope at the endpoint and on visibility at re-hydration. Re-hydrating discovered ids through `hydrateChunks`/`listDocuments` (which apply scope **and** visibility) remains as **defense-in-depth** — a second, final gate, no longer the only node-level gate — so an out-of-grant or out-of-visibility node surfaced by a relation row is dropped at the endpoint gate and again at hydration.

---

### 7.5 Trust grades, provenance, review (governance model)

Ported from openbrains' governed-memory sidecars (`openbrains:packages/convex/convex/schema.ts` lines 89-125, `memory/writeback.ts`, `memory/recall.ts`, `_lib/audit.ts`) and reimplemented against D1, enriched with gbrain's epistemic fact fields (`gbrain-cf:migrations/0004_facts.sql`).

**Trust vs visibility are orthogonal and never conflated:**
- `trust_grade ∈ {instruction, evidence, draft}` — an *agent-behaviour* signal (how much an agent should weight a memory).
- `visibility ∈ {private, team, world}` — pure access control (the canonical three-value enum, matching the `facts` DDL `CHECK (visibility IN ('private','team','world'))` in §8). The value→access-tier mapping is:

| `visibility` | Who can recall it | Boundary |
|---|---|---|
| `private` | only the authoring `user_id` (within the tenant) | user-scoped |
| `team`    | members of any `team_id` the row carries (within the tenant) | team-scoped |
| `world`   | **all members of the tenant** — i.e. **tenant-global** | tenant-scoped |

  **`world` is tenant-global, never cross-tenant.** It means "visible to everyone in this org," and it can never cross the `tenant_id` hard boundary of §7.4 — a `world` row of tenant A is invisible to tenant B by construction (the namespace + D1 `tenant_id` re-check apply regardless of `visibility`). Visibility filters *within* a tenant; it never widens the tenant boundary.

**Where visibility is ENFORCED (iter-3 CRITICAL fix — it is a Scoped\* contract, not a per-op convention).** The access tier above is not a hint or an optional narrowing filter (gbrain's `recallFacts` treated `visibility` as an *optional caller-supplied* filter, `gbrain-cf:src/facts.ts` `if (f.visibility && f.visibility.length>0)` — safe there only because gbrain is single-tenant/single-user). Here it is an **un-omittable predicate** at the single choke-point: `ScopedDB.readFacts` (§7.3) always ANDs `visibilityPredicate({visibility, team_id, user_id})` — `(visibility='world' OR (visibility='team' AND team_id IN p.teamIds) OR (visibility='private' AND user_id = p.userId))` — drop-don't-error, mirroring the tenant/scope gate. Every facts read surface routes through it: §8.4 `recall`, the §8.5 `get_session_context` injection, the §9 `recall`/`think` tools, and any hybrid arm that surfaces facts. The Pillar-2 line ("filtered by `trust_grade='instruction'` and visibility") is satisfied by this choke-point predicate, **not** by per-op prose. A best-effort Vectorize metadata pre-filter on `visibility` (where expressible) reduces topK pressure (§5.3), but the D1 `visibilityPredicate` re-check is the authority. The move from `namespace=userId` to `namespace=tenantId` (§7.4) removed openbrains' only per-user enforcement (`thought.userId !== args.userId`); `visibilityPredicate` is its structural replacement and is the subject of blocking canaries #8/#9 (§10.6).

**The single carve-out is BREAK-GLASS, never the default path.** `visibilityPredicate` is un-omittable on every *default* read surface (recall/`think`/graph/`get_session_context`); owner/admin do **not** see other users' `private`/`team` rows on any of those paths. The *only* way an admin/owner reaches another user's `private` content is the explicit, role-gated, fully-audited **break-glass** read of §7.6 (`ScopedDB.breakGlassReadPrivate`) — a separate call that fails **closed** for non-admins (`403`), writes a distinct `memory_audit` row (`action='breakglass_read'`), and fires an alert on every invocation. Break-glass does not "relax" this predicate; it is a distinct method that bypasses it by design and is loud about it. The default-path guarantee above is therefore unchanged.

**v1 column-coverage note (conscious scope decision).** The `facts` store carries per-row `visibility`/`user_id`/`team_id`, so the predicate applies in full there (and to session-derived facts). **Chunks carry the same three columns** (§4.9 DDL, iter-3): the predicate therefore applies on the hybrid/`think` arm too (`hydrateChunks`/`getChunksByIds`), closing the intra-tenant leak the security review named — a user must not semantically retrieve another user's **private session** chunk. The default differs by source, which is the conscious decision: **ingested-document chunks default `visibility='world'`** (an ingested doc is org/team knowledge, not a personal memory, so it is recallable tenant-wide and the predicate is a no-op for it), while **session-transcript chunks inherit the originating session's `visibility`/`user_id`/`team_id`** (so a private Claude-Code session is private on the hybrid arm exactly as its promoted facts are). A document author who wants a private *document* sets its `visibility` at ingest and it mirrors to the chunk. This boundary is asserted by canaries #8/#9 across **both** the facts paths and the chunk/hybrid paths.

**The hard-wired invariant (the governance keystone).** The agent-writeback path sets `trust_grade='evidence'` with **no `trustGrade` argument on the input** — there is intentionally no way for an agent to self-assign `instruction`. This is openbrains' `writebackInternal` rule verbatim (`openbrains:packages/convex/convex/memory/writeback.ts` lines 21-29, 111-116: `trustGrade: "evidence", // hard-wired`). Promotion to `instruction` flows *exclusively* through a human-confirmed `memory_review` mutation.

```sql
-- packages/db/migrations  (D1)
CREATE TABLE memory_use_policy (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,                 -- fact/chunk/document id
  trust_grade TEXT NOT NULL DEFAULT 'evidence'
              CHECK (trust_grade IN ('instruction','evidence','draft')),
  scopes      TEXT NOT NULL DEFAULT '[]',
  expires_at  TEXT
);
CREATE TABLE memory_provenance (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  origin     TEXT NOT NULL
             CHECK (origin IN ('human','agent_inferred','agent_generated','import')),
  agent      TEXT, session_id TEXT, captured_at TEXT NOT NULL
);
CREATE TABLE memory_review (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  status      TEXT NOT NULL
              CHECK (status IN ('unreviewed','confirmed','rejected','needs_revision')),
  reviewer    TEXT NOT NULL, reviewed_at TEXT NOT NULL, note TEXT
);
```

**Promotion flow (`memory_review.promote`):**
```ts
async function promoteToInstruction(sdb: ScopedDB, p: Principal, targetId: string) {
  if (p.role !== 'owner' && p.role !== 'admin')
    throw new ForbiddenError('only owner/admin may promote trust grade');
  // single db.batch: review row + use_policy update + audit row (atomic — D1 has
  // no interactive cross-await transactions). Modeled on openbrains writeback's
  // "thought + provenance + use_policy in a single mutation" atomicity.
  await sdb.batch([
    upsertReview({ tenantId: p.tenantId, targetId, status: 'confirmed',
                   reviewer: p.userId, reviewedAt: nowIso() }),
    updateUsePolicy({ tenantId: p.tenantId, targetId, trustGrade: 'instruction' }),
    auditRow({ tenantId: p.tenantId, userId: p.userId,
               action: 'usePolicy.promote', targetId, at: Date.now() }),
  ]);
}
```

**Epistemic fact fields** (the hot-memory store) port gbrain's `facts` shape (`gbrain-cf:migrations/0004_facts.sql`): `kind ∈ {event,preference,commitment,belief,fact}`, `confidence (0..1)`, `notability ∈ {high,medium,low}`, `visibility ∈ {private,team,world}`, validity window `valid_from`/`valid_until`/`expired_at`, lineage `superseded_by`, plus `facts_fts` external-content triggers. Every fact carries `tenant_id` + optional `scope` + `source_session_id`. `forget_fact` is a soft-expire (sets `expired_at`), never a hard delete.

**Trust grade feeds search ranking** (not isolation): the hybrid pipeline applies a trust-grade boost (generalizing gbrain's `COMPILED_TRUTH_BOOST`, `gbrain-cf:src/search.ts`) so `instruction > evidence > draft` in RRF ordering.

---

### 7.6 Audit + recall traces (append-only)

Two append-only tables, both tenant-scoped, both written *inside the same `db.batch`* as the change they describe (D1 has no interactive transactions across awaits, so atomicity = one batch). This ports openbrains' `writeAudit` discipline (`openbrains:packages/convex/convex/_lib/audit.ts`: "Every mutation that affects a memory sidecar or thought writes here") and `memory_recall_traces` (one row per kept hit, `openbrains:packages/convex/convex/memory/recall.ts` lines 52-59).

```sql
CREATE TABLE memory_audit (                 -- append-only; no UPDATE/DELETE in app code
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,                  -- actor
  action    TEXT NOT NULL,                  -- 'fact.create','usePolicy.promote','apiKey.mint','breakglass_read',...
  target_id TEXT,
  at        INTEGER NOT NULL,               -- epoch ms
  diff      TEXT                            -- opaque JSON (openbrains memory_audit.diff)
);
CREATE INDEX memory_audit_tenant_at ON memory_audit(tenant_id, at DESC);

CREATE TABLE memory_recall_traces (         -- one row per KEPT hit
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  query     TEXT NOT NULL,
  target_id TEXT NOT NULL,
  score     REAL NOT NULL,
  client_id TEXT NOT NULL,                  -- which AI client surfaced it
  at        INTEGER NOT NULL
);
CREATE INDEX recall_traces_tenant_at ON memory_recall_traces(tenant_id, at DESC);
```

**Recall-trace rule:** dropped (cross-tenant) ids never produce a trace — only kept hits do (openbrains recall.ts: the trace insert is *inside* the keep branch, after the `tenant_id` re-check). We also port gbrain's `mcp_request_log` (operation/latency/status, `gbrain-cf:migrations/0005_platform.sql`) for ops-level observability, tenant-scoped.

**Read authorization for these tables (iter-3 fix — second-order intra-tenant privacy).** A recall trace stores the raw `query` text plus the `target_id` of every kept hit, so an unrestricted intra-tenant read would let any member reconstruct what other users searched for and which (possibly `private`) facts they surfaced. Read access is therefore scoped, not tenant-wide: `memory_recall_traces` is readable **only by the authoring `user_id`** (`ScopedDB.readRecallTraces` ANDs `user_id = p.userId`), with an explicit **owner/admin compliance read** surface that is itself audited; `memory_audit` reads are restricted to **owner/admin** (`requireRole('admin')`). Both read surfaces are rows in the §10.6 canary table (a member of tenant T cannot read another member's traces; a non-admin cannot read the audit log), so a new reporting surface cannot bypass the gate.

**Admin/owner BREAK-GLASS read over private memory (the audited exception to §7.3/§7.5).** §7.3/§7.5 state that owner/admin do *not* bypass `visibilityPredicate` on the **default** recall/`think`/graph/`get_session_context` paths. The *one* sanctioned way an org owner/admin reaches another member's `private` content is this surface — a **full, audited, break-glass read over the private CONTENT itself** (private chunks **and** private facts), never the default path and never silent. It is defined here so the §7.3/§7.5 cross-reference resolves to a concrete contract with all four gates:

- **(a) Role-gated (org scope).** `ScopedDB.breakGlassReadPrivate` is callable **only** by `role ∈ {owner, admin}` of the principal's org/tenant (`requireRole('admin')`). The role is read from the resolved `Principal` (§7.2), so the gate is the same org-scoped role the rest of §7 trusts.
- **(b) Explicit signal, fails CLOSED.** It is reachable **only** via an explicit signal — a separate admin-only MCP tool (`memory.break_glass_read`) / REST route, or, on a shared read entry point, a `breakGlass: true` parameter. The signal is what *selects* this method; there is no implicit fall-through from a default read. A **non-admin** that supplies `breakGlass: true` (or calls the tool) is **rejected `403`** — it does **not** silently downgrade to the normal `visibilityPredicate` path. Fail-closed, not fail-open.
- **(c) Every read is audited AND alerted.** Each invocation **must** write a distinct `memory_audit` row with `action='breakglass_read'`, the acting `user_id` (actor), and a `diff` JSON carrying the **target principal** (the `user_id` whose private memory was read) and the `query`/`target_id`/scope — written in the **same `db.batch`** as nothing-else-bypassable, so an unaudited break-glass read is impossible by construction. In addition it **emits a high-severity alert to the alert sink** (`emitAlert(env, {kind:'breakglass_read', tenantId, actor, target, query, at})`, the same alerting pipeline §10.5 Tier-2 / §0 scale-trigger alerts feed) via `ctx.waitUntil` as a guaranteed-fire emission. (The alert is *not* part of `db.batch` — it is not a D1 write — but it is fired on every call; a break-glass read that produced no alert is a test failure, §10.6 canary #15.) The audit row is the durable record; the alert makes the read non-silent in real time.
- **(d) The default path is unchanged.** This method reads `facts`/`chunks` for the tenant **without** applying `visibilityPredicate` (so `private`/`team` rows authored by other users are returned), but it still applies `tenant_id` (the hard boundary is **never** bypassed — break-glass is intra-tenant only) and the `scopePredicate`. The default recall/`think`/graph/injection paths continue to AND `visibilityPredicate` and exclude `private` — break-glass is a **separate, explicit, logged call**, not a flag that loosens the default surface.

This is a deliberate break-glass surface; it is rows in the §10.6 canary table — canary #14 (a non-admin invoking it, incl. `breakGlass:true` without the admin role, gets `403` and reads no private content) and canary #15 (an admin break-glass read **does** return another user's `private` chunks and facts **and** writes the `breakglass_read` audit row **and** emits the alert). A deployment that prefers "admin has no path to private memory in v1" can disable this route via config — but the §7.3/§7.5 promise now resolves to a concrete, audited, alerted surface rather than an undefined reference.

`api_keys` minting/revocation also emit audit rows (`openbrains:packages/convex/convex/apiKeys.ts` `mint`/`revoke` call `writeAudit`; the `apiKey.mint` row carries the key's pinned `allowed_scopes` grant, §7.1), so the key lifecycle is auditable per tenant.

**Tamper-evidence backstop (SC7).** D1 has no table-level immutability, so `memory_audit` append-only-ness is enforced two ways: (1) app code never `UPDATE`/`DELETE`s the table, guarded by the banned-import lint that keeps raw `env.DB` out of every package except `packages/db`; (2) a scheduled cron exports new `memory_audit` rows **append-only** to R2 (`${tenantId}/audit/${yyyymm}.ndjson`, never rewritten) so the durable export is tamper-evident even if a future bug mutated the live table. This is the durable backstop the SC7 "auditable" claim rests on (the open question in the §7 residuals — accept app-discipline for v1 *plus* the R2 export — is resolved this way).

---

### 7.7 MCP transport scoping (read-only honored)

Port cf-graph's `/mcp/<slug>` URL-rewrite (`cf-graph:apps/graph/src/mcp/workspace-scoped-handler.ts`): the handler extracts the first path segment as a slug (validated against `SLUG_PATTERN`, with `sse`/`message` passed through), rewrites the URL to bare `/mcp`, and injects the slug into `ctx.props`. In Brain Platform the slug resolves to `{tenant_id, scope}` against `memberships`/`scopes` (not cf-graph's `userId`-owned workspace), and the MCP DO's `init()` stamps `read_only` from the membership role — exactly cf-graph's `MyMCP.init()` pattern (`cf-graph:apps/graph/src/mcp/server.ts` lines 63-72: `const readOnly = this.props?.readOnly === true; ... if (!readOnly) registerDocumentMutationTools(...)`).

```ts
// apps/api MCP DO init() — Brain Platform variant
async init() {
  const { userId, tenantSlug } = this.props ?? {};
  if (!userId || !tenantSlug) { this.server.tool('error', /* reconnect to /mcp/:slug */); return; }
  const principal = await resolvePrincipalForSlug(this.env, userId, tenantSlug);  // membership lookup
  if (!principal) { this.server.tool('error', /* not a member */); return; }
  const sdb = await ScopedDB.forPrincipal(this.env, principal);
  registerReadTools(this.server, sdb, principal);          // search/think/traverse/recall
  if (!principal.readOnly) registerWriteTools(this.server, sdb, principal);  // capture/finalize/promote
}
```

The MCP DO is **only the per-tenant MCP server instance** (cf-graph `MyMCP` pattern), never the system of record — D1 + Vectorize remain the substrate.

---

### 7.8 Internal hops: native bindings, no shared secret (the divergence from openbrains)

openbrains' MCP-Worker↔Convex boundary uses a static `X-OpenBrains-Internal-Secret` header (`openbrains:apps/mcp/src/index.ts` lines 91-114: every `/internal/*` route gated by `INTERNAL_API_SECRET`; `openbrains` CLAUDE.md "MCP Worker → Convex trust boundary"). Brain Platform **does not port the shared secret.** Worker↔Workflow, Worker↔Queue-consumer, and Worker↔Worker calls go over Service/Workflow bindings — there is no static HTTP secret to leak or rotate.

Rationale (plan §5d): a leaked static internal secret that "passes `tenant_id` explicitly" would bypass all `Scoped*` enforcement. Bindings eliminate the network attack surface entirely. Internal handlers still **construct a `Principal` from the explicit `tenant_id` carried in the Workflow/Queue params and go through `Scoped*`** — bindings remove the wire, not the isolation gate. If a future *external* integration genuinely needs an HTTP secret, it is per-target, stored in Secrets Store, rotated on a schedule, and the handler still builds a Principal.

**Fail-closed producer check (iter-2).** Because the internal-hop `tenant_id` is trust-the-producer (a buggy enumerator that emits the wrong `tenant_id` would write cross-tenant with full `Scoped*` blessing), the consumer adds a cheap invariant before constructing the system `Principal`: assert the message `tenantId` corresponds to a real `orgs` row, and for backfill that the `run_id`'s owning tenant matches the message `tenantId`. A mismatch fails the message into the DLQ (fail-closed) rather than writing silently to the wrong tenant.

---

### 7.9 Request flows (end-to-end)

**A. Authenticated search (`think`):**
1. `resolvePrincipal(req)` → `Principal{tenantId, userId, role, allowedScopes, capabilities, readOnly}` (§7.2). On null → `401` with RFC 9728 `WWW-Authenticate: Bearer resource_metadata="..."`.
2. `ScopedDB.forPrincipal` + `createScopedVectorize` constructed from the Principal (shard resolved from `tenant_shards`, v1=`DB`/`brain-chunks`).
3. Embed query → Vectorize arm (`namespace=tenantId`, metadata filter `{scope}`) ∥ FTS5 bm25 arm.
4. **Both arms re-JOIN to live D1 rows via `ScopedDB` and re-check `tenant_id`/`scope`/`deleted_at`**; cross-tenant ids silently dropped (§7.4).
5. RRF fuse + trust-grade boost → rerank → synthesis.
6. One `memory_recall_traces` row per kept hit, in a `db.batch` (§7.6).

**B. Agent writeback (capture):**
1. Principal resolved; `readOnly` rejected with `403`.
2. `ScopedDB.writeFact` runs one `db.batch`: `facts` row (+`tenant_id`) → `memory_provenance` (`origin='agent_inferred'`) → `memory_use_policy` (`trust_grade='evidence'`, hard-wired) → `memory_audit`. Atomic; rolls back together (§7.5, openbrains writeback atomicity).
3. Chunk + embed → `createScopedVectorize.upsert` (`namespace=tenantId`).

**C. Internal hop (Queue consumer ingesting a backfill item):**
1. Message carries explicit `{ tenantId, sourceId, runId, payloadRef }` (no token, no secret).
2. Consumer **validates** `tenantId` against a real `orgs` row and that `runId`'s owning tenant matches (fail-closed to DLQ on mismatch, §7.8), then constructs `Principal{tenantId, userId:'system', role:'member', allowedScopes:'*', capabilities:['read','write'], readOnly:false}` and `ScopedDB.forPrincipal` — all writes still go through the choke-point (§7.8).

---

### 7.10 Edge cases & failure modes

- **Token valid but no membership** → `principalFromMembership` returns `null` → `401`. A valid Clerk user is not authorized for a tenant they are not a member of.
- **API key for tenant A used to read tenant B** → the key resolves `tenantId=A`; `ScopedDB` injects `tenant_id=A`; tenant B rows never match. Impossible by construction.
- **Restricted member mints an API key to escape their scope grant** → the key's `allowed_scopes` is pinned at mint time to `intersect(requestedGrant, minter.allowedScopes)` (§7.1), so a minter with `allowedScopes=['clientA']` can never store a wider grant (including `'*'`); the `bk_` branch (§7.2) populates `Principal.allowedScopes` from `row.allowed_scopes` (NULL→`'*'` only when the minter was `'*'`), and `ScopedDB` then gates every read/hop on that grant. A restricted member's key thus reads exactly the scopes the member could read — no one-step escalation to tenant-wide. Covered by a key-grant-isolation CI test.
- **Restricted-scope member names another client's scope** → `assertScopeAllowed` rejects an explicit out-of-grant `scope` with `403`; an unscoped query has `AND scope IN (grants)` injected so out-of-grant rows never match; the vector arm's out-of-grant ids are dropped at `hydrateChunks`. A member with `allowedScopes='*'` (the default) is unaffected — staff move freely. Covered by the cross-scope CI test (§10.6 canary #7).
- **User B recalls user A's `private` fact (intra-tenant RLS)** → `ScopedDB.readFacts` always ANDs `visibilityPredicate`, so a `private` row only matches when `user_id = p.userId`; a `team` row only matches when its `team_id ∈ p.teamIds`. Drop-don't-error, identical to the tenant gate — B simply gets no row, no existence leak, on recall / hybrid / `think` / `get_session_context`. Covered by canaries #8/#9 (§10.6). (iter-3 CRITICAL fix.)
- **Body-supplied partition fields on a write (`writeFact`/`capture_turn`/`POST /ingest`)** → validated through `ScopedDB` before insert (iter-3 fix): `scope` must pass `assertScopeAllowed` (else `403`); `team_id` must be in `p.teamIds`; `user_id` is **forced** to `p.userId` (never body-controlled, so a fact can't be mis-attributed); `visibility` is role-constrained by `constrainVisibility(requested, p)` — a `member`/`readonly` author may write `private` or `team` (for a team they belong to) but a `world` (tenant-global) write requires `admin`/`owner` (an org-wide announcement is a privileged act). A restricted key thus cannot create a row outside its grant or mis-attribute it. Covered by the write-isolation canary (§10.6).
- **Vectorize returns a stale cross-tenant id** (index lag after a tenant re-shard) → D1 re-check drops it (§7.4). Never observable.
- **FTS5 MATCH returns a row from another tenant** (shared token) → JOIN re-check on `tenant_id` drops it before it leaves the arm (§7.4). Covered by a dedicated blocking CI test.
- **BFS / graph hop on a slug shared across tenants OR across scopes** → every frontier query (the typed `ScopedDB.expandFrontier`/`getLinks`, §7.3) carries `tenant_id = ?` **and** applies the same `nodeGate` (scope `IN (grants)` **and** the visibility tier) to **both** endpoints (`nf`/`nt`), identical to the BFS; the cross-tenant or out-of-grant/visibility node is never enumerated, and a restricted Persona-C staffer cannot `traverse_graph`/`get_links`/`get_backlinks` into another client's scope. There is no raw-SQL passthrough that binds only `tenant_id`; re-hydration is defense-in-depth on top. Covered by a BFS-isolation CI test and the graph-arm cross-scope test (§10.6 canary #13, iter-3 CRITICAL fix).
- **Agent attempts to set `trust_grade='instruction'`** → no such argument exists on the writeback input; the value is hard-wired to `evidence` (§7.5).
- **Read-only key/role attempts a write** → `ScopedDB` mutations and the MCP DO's tool registration both gate on `readOnly`; write tools are not even registered for a read-only principal (§7.7).
- **Expired/revoked credential** → `validateApiKey`/`verifyDeviceToken`/`jwtVerify` return null/throw → `401`. No partial trust.
- **D1 batch partial failure** → the whole `db.batch` (change + audit) rolls back; no orphaned audit row, no audited-but-uncommitted change.
- **Raw binding used outside `packages/db`** → ESLint banned-import rule fails CI before merge (§7.3).

#### Code references

- openbrains:/home/roboto/devel/openbrains/packages/services/src/deps/vectorize.ts — createVectorizeClient that hard-wires namespace on every upsert/query and carries scope/type/source as metadata; the 'metadata may lag, D1 row is the correctness gate' rule. Lift verbatim, rename userId->tenantId, add team_id/visibility/embedding_model metadata (trust_grade is sidecar-only, never a Vectorize field) -> ScopedVectorize.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/_lib/identity.ts — requireUserId auth-first invariant (every public fn calls it first). The discipline to mechanize as ScopedDB.forPrincipal + the ESLint banned-binding control.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/writeback.ts — Agent writeback hard-wires trustGrade='evidence' with NO trustGrade argument; thought+provenance+use_policy+audit written atomically in one mutation. Reimplement as a single D1 db.batch in ScopedDB.writeFact.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/recall.ts — Drop-don't-error cross-tenant rule (skip rows where tenant id mismatches -> no existence leak) and one memory_recall_traces row per KEPT hit (trace insert inside the keep branch). Port both to D1.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/_lib/audit.ts — writeAudit: append-only memory_audit row written inside the same mutation as the change. Port to a D1 audit row inside the same db.batch.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/apiKeys.ts — API key mint (32 random bytes, SHA-256 hash, scopes, expiresAt, audited) and the 'verify is the legitimate exception to auth-first' pattern (lookup by hash, return null on unknown/expired). Mint/revoke emit audit rows.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/schema.ts — Governed-memory sidecar shapes: memory_use_policy(trustGrade), memory_provenance(origin), memory_review(status), memory_recall_traces, memory_audit, projects(scope) with the 'scope undefined = tenant-global' rule. Translate to D1 + tenant_id.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/auth/clerk.ts — createClerkRemoteVerifier: jose jwtVerify vs JWKS, issuer-checked, sub->userId, email extraction, ClerkAuthError. Use as step 1 of resolvePrincipal.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/auth/device-token.ts — HMAC-SHA256 self-contained obdev_ machine tokens (signDeviceToken/verifyDeviceToken, base64url helpers, exp check). Extend DeviceTokenClaims with tenantId; use as step 2 of resolvePrincipal.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/index.ts — OAuthProvider wiring: resolveExternalToken recognizing obdev_ bearers -> ctx.props, and the RFC 8628 device-code pre-filter on fetch. Also the (rejected-for-internal-hops) INTERNAL_API_SECRET-gated /internal/* routes pattern.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/mcp/handler.ts — extractAuth(ctx.props)->AuthContext single point that threads identity into the per-request MCP server build. Generalize to extract {userId, tenantId}.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/mcp/session-scope-store.ts — Per-user default scope pinned in OAUTH_KV under session-scope: prefix + withSessionDefaultScope splice (tool scope wins). Key by tenant+user.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/middleware/auth.ts — cliTokenFallback: the multi-token resolver chain (Clerk -> API key -> CLI JWT) normalizing to one identity. Template for resolvePrincipal's ordered try-chain.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/api-keys.ts — generateApiKey (prefix + SHA-256 hash), validateApiKey (by hash, reject revoked/expired, fire-and-forget lastUsedAt), readOnly model. Replace workspaceIds[] with a single tenant_id column.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/cli-tokens.ts — HMAC-SHA256 CLI access(1h)/refresh(30d) JWTs via Web Crypto, refresh-token rotation with hashed storage. Port for the brain CLI device flow + cli_refresh_tokens table.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/workspace-scoped-handler.ts — /mcp/<slug> URL-rewrite -> ctx.props injection with slug validation and sse/message pass-through. Resolve slug to {tenant_id, scope} via memberships instead of a userId-owned workspace.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/server.ts — MyMCP.init() slug->workspace resolution and readOnly gating (only register mutation tools when !readOnly). Reuse pattern; gate on membership role.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/db/schema.ts — CF-native Drizzle/D1 column conventions (nanoid pk, workspaceId/userId scoping, api_keys, cli_refresh_tokens, cli_auth_sessions). Generalize workspaceId -> tenant_id and add memberships/teams/orgs.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/documents.ts — The metadata-filter-only Vectorize isolation (filter:{workspaceId}) — cited as the REJECTED weaker pattern; ScopedVectorize namespace isolation supersedes it.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/mcp-oauth.ts — @cloudflare/workers-oauth-provider setup (apiRoute /mcp, authorize/token/register endpoints) and wrapOAuthResponse (http->https AS-metadata fix + RFC 9728 resource_metadata on 401 WWW-Authenticate).
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/oauth-props.ts — authFromProps adapting ctx.props -> AuthInfo. Note AuthInfo carries NO userId/tenant — the single-tenancy gap Brain Platform fixes with Principal+memberships.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/auth.ts — Legacy bearer verify (SHA-256 hash, scopes, 60s-debounced last_used_at) — the coarse single-tenant pattern to NOT copy; shows why per-tenant binding is required.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0004_facts.sql — Epistemic fact model: kind/visibility/notability/confidence(0..1)/valid_from/valid_until/expired_at/superseded_by + facts_fts external-content triggers + soft-expire forget. Add tenant_id + scope; the trust-grade-vs-visibility orthogonality source.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0001_init.sql — FTS5 external-content + trigger-synced chunks_fts pattern (correct auto-sync). Isolation for the bm25 arm comes from the mandatory JOIN back to the tenant-scoped base table.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0005_platform.sql — mcp_request_log (operation/latency/status) for ops observability; ingest_log audit. Add tenant_id.

---

## 8. Session Capture, Hot Memory & Backfill

This section specifies how the Brain Platform stores sessions from many clients/users/teams, runs the stop-hook **promote-to-fact + embed-everything** loop, serves **hot memory** (facts) vs **long-term memory** (chunks/Vectorize), injects **frozen snapshots**, and durably **backfills** old sessions/repos/docs via Workflows + Queues. It is the integration point of three mined subsystems: gbrain's facts hot-memory + recall + webhook ingest (`gbrain-cf:src/ops/facts.ts`, `gbrain-cf:src/facts.ts`, `gbrain-cf:migrations/0004_facts.sql`, `gbrain-cf:src/routes-platform.ts`), cf-graph's durable ingestion Workflow (`cf-graph:apps/graph/src/api/workflows/ingestion.ts`), and openbrains' importer SDK + governed writeback/recall (`openbrains:packages/ingest/src/sources/*`, `openbrains:packages/convex/convex/memory/writeback.ts`, `openbrains:packages/convex/convex/memory/recall.ts`). **No Convex** — Convex orchestration is rewritten against D1 + Queues + Workflows; only the platform-neutral importer SDK is lifted.

Everything below threads `tenant_id` through every row, every Vectorize namespace, every R2 key, every Queue message, and every Workflow param. Isolation is enforced structurally via `ScopedDB`/`ScopedVectorize`/`ScopedR2` (§5), never by hand-written WHERE clauses.

---

### 8.1 Data model — sessions, turns, facts, snapshots, backfill_runs

**Body-offload rule (D1 capacity discipline, §0/§3):** D1 holds the **index + lean rows**; full transcripts live in **R2** addressed by `r2_key`. `session_turns` are lean (role + short content, or an R2 offset for long turns). This is a correctness requirement for the single shared D1 under 10 GB, not an optimization.

#### `sessions` (NET-NEW — no mined project has a first-class session store)

```sql
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,              -- nanoid
  tenant_id        TEXT NOT NULL,
  team_id          TEXT,
  user_id          TEXT NOT NULL,                 -- authorship
  scope            TEXT,                          -- project/client sub-partition
  client           TEXT NOT NULL                  -- claude-code|claude-desktop|chatgpt|cli|web
                   CHECK (client IN ('claude-code','claude-desktop','chatgpt','cli','web','import')),
  source_session_id TEXT,                         -- the client's own session id (for idempotent upsert)
  title            TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,                          -- set ONLY on explicit close/finalize (may be NULL forever on a missed Stop-hook)
  last_activity_at TEXT NOT NULL                  -- refreshed on EVERY capture_turn (iter-3 SC6 fix): the idle-sweep key
                   DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','finalizing','promoted','failed')),
  turn_count       INTEGER NOT NULL DEFAULT 0,
  r2_key           TEXT,                          -- full transcript in R2: ${tenantId}/sessions/${id}.jsonl
  content_hash     TEXT,                          -- sha256(normalizeForFingerprint(transcript)) for dedup
  metadata         TEXT,                          -- JSON
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user      ON sessions(tenant_id, user_id, started_at DESC);
CREATE INDEX idx_sessions_client    ON sessions(tenant_id, client, started_at DESC);
-- Idle-promotion sweep target (§8.3): open sessions whose LAST ACTIVITY is stale.
-- Keyed on last_activity_at, NOT ended_at — a missed Stop-hook leaves ended_at NULL,
-- so an ended_at-keyed sweep could never recover it (iter-3 SC6 fix).
CREATE INDEX idx_sessions_open      ON sessions(tenant_id, status, last_activity_at);
-- Idempotent ingress: a client re-pushing the same source session upserts, not duplicates.
CREATE UNIQUE INDEX idx_sessions_source ON sessions(tenant_id, client, source_session_id)
  WHERE source_session_id IS NOT NULL;
```

#### `session_turns` (lean index; long bodies offloaded to R2)

```sql
CREATE TABLE session_turns (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  idx         INTEGER NOT NULL,                   -- ordinal within the session
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content     TEXT,                               -- short turns inline; NULL when offloaded
  r2_offset   TEXT,                               -- "${r2_key}#L<start>-L<end>" when content offloaded
  token_count INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_session_turns_order ON session_turns(tenant_id, session_id, idx);
```

A turn is offloaded (its `content` set NULL, `r2_offset` set) when `length(content) > TURN_INLINE_MAX` (default 2 KB). The full transcript is always present in R2 regardless; inline `content` is a hot-path convenience for short turns.

#### `facts` — hot memory (port `gbrain-cf:migrations/0004_facts.sql` verbatim + `tenant_id`/`scope`/governance columns)

gbrain's epistemic model is ported wholesale (kind/visibility/notability/confidence, validity window, supersession lineage, FTS5 external-content + triggers). We add tenancy and replace gbrain's single-tenant `source_id='default'` with `tenant_id`.

```sql
CREATE TABLE facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT    NOT NULL,             -- replaces gbrain source_id='default'
  scope             TEXT,                         -- project/client sub-partition
  team_id           TEXT,
  user_id           TEXT,                         -- authorship
  entity_slug       TEXT,
  fact              TEXT    NOT NULL,
  kind              TEXT    NOT NULL DEFAULT 'fact'
                    CHECK (kind IN ('event','preference','commitment','belief','fact')),
  visibility        TEXT    NOT NULL DEFAULT 'private'   -- ACCESS control (private→tenant/team/user)
                    CHECK (visibility IN ('private','team','world')),
  notability        TEXT    NOT NULL DEFAULT 'medium'
                    CHECK (notability IN ('high','medium','low')),
  context           TEXT,
  valid_from        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_until       TEXT,
  expired_at        TEXT,
  superseded_by     INTEGER REFERENCES facts(id),
  consolidated_at   TEXT,
  consolidated_into INTEGER,
  source            TEXT    NOT NULL,             -- e.g. 'mcp:extract_facts', 'session:promote'
  source_session_id TEXT,                         -- renamed from gbrain source_session
  confidence        REAL    NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  is_dream_generated INTEGER NOT NULL DEFAULT 0,  -- anti-loop guard surfaced as a column
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- gbrain partial indexes, re-keyed on tenant_id (active = expired_at IS NULL):
CREATE INDEX idx_facts_entity_active ON facts(tenant_id, entity_slug, valid_from DESC) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_session       ON facts(tenant_id, source_session_id, created_at DESC) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_since         ON facts(tenant_id, created_at DESC) WHERE expired_at IS NULL;

-- facts_fts external-content + triggers (gbrain 0004_facts.sql:62-84 verbatim).
CREATE VIRTUAL TABLE facts_fts USING fts5(fact, entity_slug, content='facts', content_rowid='id');
-- insert/delete/update triggers identical to gbrain-cf:migrations/0004_facts.sql:69-84.
```

**`trust_grade` vs `visibility` stay orthogonal (§5):** `visibility` (above) is access control; `trust_grade` (instruction|evidence|draft, in the `memory_use_policy` sidecar of §3) is an agent-behaviour signal. A promoted fact is written `trust_grade='evidence'` and never auto-promoted to `instruction` (§8.3).

**FTS5 isolation (§5g):** `facts_fts MATCH` cannot carry `tenant_id`. The recall query (8.4) JOINs the `facts_fts` rowid back to the tenant-scoped `facts` base table via `ScopedDB` and re-checks `tenant_id`/`scope`/`expired_at` before any row leaves the keyword arm — `gbrain-cf:src/facts.ts:144-153` already uses the `id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?)` subquery pattern; we keep it but the enclosing `WHERE` is built by `ScopedDB`, so `tenant_id = ?` is always present.

#### `brain_snapshots` — frozen-snapshot storage (DEFERRED phase; port `gbrain-cf` `page_versions` shape)

```sql
CREATE TABLE brain_snapshots (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  scope       TEXT,
  label       TEXT NOT NULL,
  created_by  TEXT NOT NULL,                      -- user_id
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  manifest    TEXT NOT NULL                       -- JSON: pinned immutable version ids (see 8.5)
);
CREATE INDEX idx_snapshots_tenant ON brain_snapshots(tenant_id, created_at DESC);
```

#### `backfill_runs` — fuse `gbrain-cf` `jobs` (`migrations/0005_platform.sql:44`) + openbrains `imports`

Replaces both substrates. The **Queue** owns message-level dispatch; this row owns the **enumerator-run** state (cursor/anchor/stats) and the optimistic claim.

```sql
CREATE TABLE backfill_runs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,                     -- session|repo|doc|gmail|ob1|reembed
  direction    TEXT NOT NULL DEFAULT 'backfill'   -- backfill|incremental
               CHECK (direction IN ('backfill','incremental')),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','success','failure','cancelled')),
  cursor       TEXT,                              -- importer opaque cursor (resume point)
  anchor       TEXT,                              -- durable anchor (advances only on clean pass)
  stats        TEXT,                              -- JSON {processed,created,skipped,errors,merged}
  attempts     INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_backfill_status ON backfill_runs(tenant_id, source_id, status);
```

---

### 8.2 Session ingress — three paths

All three paths terminate in the same `sessions`/`session_turns` rows + R2 transcript, then trigger `SessionPromoteWorkflow` (8.3). The `Principal` (§5) is resolved at the edge; every path goes through `ScopedDB`/`ScopedR2`.

**(1) Live per-turn MCP — `capture_turn`.** Models gbrain's `extract_facts` op shape (`gbrain-cf:src/ops/facts.ts:29`) but writes a turn, not a fact.

```ts
// MCP tool, write scope, honors read_only flag from Principal.role
capture_turn(p: { session_id: string; role: 'user'|'assistant'|'system'|'tool'; content: string; client: string })
```
Flow: upsert the `sessions` row by `(tenant_id, client, source_session_id=session_id)`; append a `session_turns` row at `idx = turn_count`; bump `turn_count`; **refresh `sessions.last_activity_at = now()` on this same write** (iter-3 SC6 fix — this is what the idle sweep keys off, so a session that is actively capturing turns but never receives an explicit Stop-hook is still recoverable once it goes idle); append the turn to the R2 transcript (`${tenantId}/sessions/${id}.jsonl`). All D1 writes in one `db.batch([...])` (D1 has no interactive transactions across awaits — same rule as `openbrains:packages/convex/convex/memory/writeback.ts:43-126`, ported to `db.batch`).

**(2) Batch importer (ChatGPT / Claude-Code exports).** Net-new importers `chatgpt.ts` and `claude-code.ts` implement the openbrains `Importer` contract (`openbrains:packages/ingest/src/sources/types.ts:56-63`), modeled on `openbrains:packages/ingest/src/sources/ob1.ts`. **Their INPUT export schemas — the ChatGPT `conversations.json` mapping-tree and the Claude Code JSONL transcript, the per-field guards, and the turn→`session_turns` mapping — are specified in §4.7.1** (ob1.ts is only the *output* contract). In brief: parse untrusted JSON/JSONL export, narrow each row from `unknown` with per-field guards (skip-record on drift, never throw), **drop any foreign embeddings**, emit `embeddingModel:'pending'` / `embeddingDims:0` so the re-embed worker (8.6) re-embeds at 1024d. Each emitted `BrainBundleThought` carries a `provenance[]` with `origin:'import'` and `sessionId`, and a `sourceRefs[]` pointing at the export. Driven by the Enumerator Workflow (8.6).

**(3) Webhook push — `POST /ingest`.** Port `gbrain-cf:src/routes-platform.ts` near-verbatim: bearer + write scope, content-type normalize (md/plain/json), **256 KB cap**, `content_hash = sha256Hex(body)`, write an audit row + enqueue (gbrain wrote a D1 `jobs` row because it had no Queues; we **enqueue a `brain-backfill` message instead** — §8.6), return `202 {job_id}`. Two substantive changes over the single-tenant original: (a) replace the D1-`jobs` insert (`gbrain-cf:src/routes-platform.ts:96-113`) with `env.BACKFILL_QUEUE.send({...})`, and the bearer verify with `resolvePrincipal()` so the request carries a `tenant_id`; (b) **all body-supplied partition fields are validated through `ScopedDB` on write, never trusted from the body** (iter-3 write-isolation fix): a body `scope` must pass `assertScopeAllowed` (out-of-grant → `403`); a body `team_id` must be in `p.teamIds`; `user_id` is **forced** to `p.userId` (not body-controlled); a body `visibility` is constrained by `constrainVisibility(requested, p)` (a `world`/tenant-global write requires `admin`/`owner`). So a low-privilege key cannot write a row that escapes its `allowedScopes`, is mis-attributed, or is mis-broadcast. Covered by the write-isolation canary (§10.6).

---

### 8.3 Stop-hook: promote-to-fact + embed-everything loop

The stop-hook is a `finalize_session(session_id)` MCP tool (or the importer's `finalize()`), which sets `sessions.status='finalizing'` and creates a `SessionPromoteWorkflow` with deterministic id `promote-${tenantId}-${sessionId}` (idempotent under retries/duplicate Stop-hooks). The Workflow is the literal cf-graph `IngestionWorkflow` template (`cf-graph:apps/graph/src/api/workflows/ingestion.ts:51-422`) — per-phase `step.do` with `retries:{limit,backoff:'exponential'}`, batch constants, status FSM — specialized for sessions.

```
SessionPromoteWorkflow(payload: { tenantId, sessionId, scope?, teamId?, userId })
  step('load-transcript')        // ScopedR2.get(`${tenantId}/sessions/${sessionId}.jsonl`)
  step('extract-facts')          // gbrain extractFactsFromText() → typed candidate facts
      retries:{limit:3, backoff:'exponential'}
  step('writeback-facts')        // atomic db.batch: insert facts + memory_* sidecars + audit
  step('chunk')                  // gbrain paragraph-packing (CHUNK_TARGET≈1200) over the transcript
  step('embed-batch-N')          // EMBED_BATCH_SIZE=50, bge-m3 1024d, ScopedVectorize upsert
      retries:{limit:5, backoff:'exponential'}
  step('store-chunks-batch-N')   // CHUNK_DB_BATCH_SIZE=10 (D1 100-param limit) + chunks_fts triggers
                                 //   each chunk row carries the SESSION's visibility/user_id/team_id (iter-3),
                                 //   so a private session's chunks are private on the hybrid/think arm too
  step('finalize')               // sessions.status='promoted'
```

**Promote (extract-facts → writeback).** Reuse gbrain's `extractFactsFromText(env, turnText, {sessionId, entityHints, visibility, source})` (`gbrain-cf:src/facts.ts`, called from `gbrain-cf:src/ops/facts.ts:73-78`). It runs the `ai.ts` `generate()` seam against the transcript and returns typed `NewFact[]` (`kind`/`entity_slug`/`visibility`/`notability`/`confidence`). The **anti-loop guard** is honored: if the session/turn is `is_dream_generated`, extraction is skipped exactly as `gbrain-cf:src/ops/facts.ts:62-64`.

Writeback is the openbrains atomic pattern (`openbrains:packages/convex/convex/memory/writeback.ts:30-127`) rewritten against D1 `db.batch`: for each extracted fact, **`trust_grade='evidence'` is hard-wired (no arg)**, `source_session_id` is set, and a `memory_audit` row + `memory_provenance(origin:'agent_inferred', sessionId)` row are written in the **same batch** as the `facts` INSERT. The fact INSERT itself reuses gbrain `insertFacts` SQL (`gbrain-cf:src/facts.ts:64-92`), extended with `tenant_id`/`scope`/`team_id`/`user_id`/`source_session_id` columns.

**Re-finalize is a clean replace, not an append (iter-3 dedup fix).** Re-promoting an edited/re-run session must not insert near-duplicate facts (content_hash skip-unchanged does nothing once the transcript genuinely changes). So `writeback-facts` first **soft-expires the prior promoted set** for this `source_session_id` (`UPDATE facts SET expired_at=now() WHERE tenant_id=? AND source_session_id=? AND expired_at IS NULL` — preserving lineage, not hard-deleting), then inserts the freshly-extracted facts; and the extracted set is deduped in-batch on `(tenant_id, entity_slug, kind, LOWER(TRIM(fact)))` so duplicate sentences collapse. This is a deterministic, embedding-free rule (NOT gbrain's cosine/classifier dedup, still Phase-3.5); it makes re-finalize idempotent.

```ts
// pseudo-code inside step('writeback-facts'), one db.batch (D1 has no cross-await tx)
// 0) supersede the prior promoted set for this source_session_id (clean replace):
await scopedDb.expireFactsBySession(sessionId);   // soft-expire, preserves lineage
const facts = dedupeFacts(extracted);             // collapse on (entity_slug,kind,lower(trim(fact)))
for (const f of facts) {
  await scopedDb.batch([
    insertFact({ tenant_id, scope, team_id, user_id, entity_slug: f.entity_slug, fact: f.fact,
                 kind: f.kind, visibility: f.visibility, notability: f.notability,
                 confidence: f.confidence, source: 'session:promote', source_session_id: sessionId }),
    insertUsePolicy({ tenant_id, target_id: factId, trust_grade: 'evidence' }),       // hard-wired
    insertProvenance({ tenant_id, target_id: factId, origin: 'agent_inferred', session_id: sessionId }),
    insertAudit({ tenant_id, user_id, action: 'fact.promote', target_id: factId }),
  ]);
}
```

**Embed-everything.** In the same Workflow, chunk the transcript and embed at 1024d via the `@brain/ingest` `embed()` chokepoint (gbrain's null-returning never-throw contract, `gbrain-cf:src/ai.ts`), upserting through `ScopedVectorize` with `namespace=tenantId` and metadata `{userId, teamId, scope, sessionId, visibility, embedding_model:'bge-m3'}` — `visibility` is carried so the vector arm can apply a best-effort metadata pre-filter (§5.3); the authoritative gate remains the D1 `readFacts`/`visibilityPredicate` re-check. Chunk rows get `embedded_at`/`embedding_model` stamps (gbrain `0002_search.sql` staleness columns) so the re-embed sweep (8.6) can detect drift.

**Reliability — idle-promotion cron (NET-NEW).** A missed client Stop-hook must not lose a transcript. The whole point of this sweep is the case where `ended_at` was **never set** (the Stop-hook never fired), so the sweep keys off `last_activity_at` (refreshed on every `capture_turn`, §8.2), **not** `ended_at`. A Cron trigger sweeps `idx_sessions_open`:

```sql
SELECT id, tenant_id, scope, team_id, user_id FROM sessions
WHERE status = 'open'
  AND last_activity_at < datetime('now', '-' || :idle_minutes || ' minutes')
LIMIT :batch;
```
and creates a `SessionPromoteWorkflow` for each (deterministic id `promote-${tenantId}-${sessionId}` makes a racing manual finalize a no-op). Because every open session has a non-NULL `last_activity_at` (DEFAULT now() at insert, refreshed per turn), a session whose Stop-hook never arrived is caught the moment it has been idle for `idle_minutes` — closing the SC6 gap that an `ended_at IS NOT NULL` predicate left open. This generalizes gbrain's cron job runner reclaim posture (`gbrain-cf:src/jobs.ts:33-59`) to sessions.

---

### 8.4 Hot vs long-term memory + recall

**Hot memory = `facts` + `facts_fts` + `recall`.** Port the gbrain `recall` op (`gbrain-cf:src/ops/facts.ts:97-160`) and `recallFacts` engine (`gbrain-cf:src/facts.ts:111-159`): dispatch by entity / since / session / keyword query / grep, newest-first, with `parseSinceParam` ("8 hours ago", "30m", ISO) ported verbatim (`gbrain-cf:src/ops/facts.ts:199-223`). Two changes for multi-tenancy and governance:

1. The base `WHERE` always carries `tenant_id = ?` (+ scope **+ the visibility predicate**) injected by `ScopedDB.readFacts` (§7.3), replacing gbrain's `source_id = ?` (`gbrain-cf:src/facts.ts:116-117`). gbrain treated `visibility` as an *optional caller-supplied narrowing filter* (`if (f.visibility && f.visibility.length>0)`), safe only because gbrain is single-user; here `readFacts` **always** ANDs `visibilityPredicate({visibility, team_id, user_id})` — `(visibility='world' OR (visibility='team' AND team_id IN p.teamIds) OR (visibility='private' AND user_id = p.userId))` — so user B never recalls user A's `private` fact and the `team` tier is enforced (iter-3 CRITICAL intra-tenant RLS fix, §7.5). The FTS keyword arm's `id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?)` subquery stays, JOINed back to the tenant-scoped base (§5g), and the hydrated rows pass the same `readFacts` gate so the visibility predicate closes the keyword arm too.
2. Every kept hit writes a `memory_recall_traces` row (`tenant_id, user_id, query, target_id, score, client_id, at`) — port openbrains' per-hit trace write and **drop-don't-error cross-tenant rule** (`openbrains:packages/convex/convex/memory/recall.ts:36-59`): a `target_id` whose hydrated row `tenant_id !== principal.tenantId` — **or whose `visibility` does not satisfy the predicate above** — is silently skipped (no existence leak), and no trace is written for it. Trace **writes are off the synchronous read path** (`ctx.waitUntil`, batched to a separate trace store) — see the D1 write-throughput note in §10.7 — so a read does not block on a single-writer D1 write.

`forget_fact` (soft-expire) ports `gbrain-cf:src/ops/facts.ts:162-192` unchanged except for tenant scoping on the lookup.

**Long-term = chunks + Vectorize + hybrid search.** Session chunks join the same `brain-chunks` index and are retrieved by the §4.3 hybrid pipeline (FTS bm25 ∥ Vectorize → RRF → rerank → cited `think`). Promoted facts and session chunks are thus reachable both via fast keyword recall (hot) and semantic hybrid search (long-term).

---

### 8.5 Frozen-snapshot injection (DEFERRED phase)

**Storage:** a `brain_snapshots.manifest` JSON pins immutable version ids (fact ids at their `valid_from`, `page_versions` ids, chunk ids) frozen at snapshot time — the read-side half that exists in no mined repo. **Injection:** a `get_session_context(snapshot_id?)` MCP tool / SessionStart resource resolves the pinned versions and returns the frozen brain view (soul/user/memory/today projections), **never live rows**; with no `snapshot_id` it returns live state. Resolution is purely read-side over `ScopedDB` — and the live-state path reads facts through `ScopedDB.readFacts`, so the **visibility predicate (§7.5) and `trust_grade='instruction'` filter both apply**: the v1 injection surfaces only instruction-grade, visibility-permitted memory, and one user's `private` instruction-fact is never injected into another user's session. (iter-3 CRITICAL fix — this path was the one place visibility was mentioned in prose; it now routes through the choke-point.) This is explicitly out of the core scope (§6) and built only when needed — do not over-build early.

---

### 8.6 Backfill spine — Enumerator Workflow → Queue → Batch-Ingest

The three-stage async spine (NET-NEW; Queues is the primitive none of the three projects had) backfills old sessions/repos/docs/Gmail/OB1 durably and at-least-once.

**Stage 1 — Enumerator Workflow** (one instance per `(tenantId, sourceId)`). Runs the openbrains `Importer` contract (`begin → nextBatch(cursor) → finalize`, `openbrains:packages/ingest/src/sources/types.ts:56-63`) with the `runImporterContract` invariants (no empty-batch-with-non-null-cursor; terminal null cursor; finalize once — `openbrains:packages/ingest/src/sources/contract.ts:18-51`) and gbrain's cursor/anchor discipline (`gbrain-cf:src/sync.ts`): `cursor` lives in `backfill_runs.cursor`, the durable `anchor` (e.g. `last_commit`) **advances only on a clean full pass**; a per-item failure never advances the anchor (no silent page loss); a truncated source tree refuses to recompute the anchor. Each page is one named `step.do(`page-${n}`)` so a restarted enumerator resumes from the last completed page (cf-graph batch-as-step pattern). The enumerator **only enqueues references** — it never embeds inline — staying under the 10k-step / 1 MiB step-output caps (§0). For huge sources it bounds items per run (gbrain `MAX_FILES_PER_TICK=150`, `gbrain-cf:src/sync.ts:31`) and re-creates itself with the saved cursor.

The per-batch drive/persist loop is ported from openbrains `driveImport` (`openbrains:packages/convex/convex/importsAction.ts:106+`): persist `cursor`+`stats` after every batch (resumable), re-check tenancy on the run row (mismatched `(tenantId, runId)` → NOT_FOUND before any write), and fold the fingerprint-dedup "merged" count into `stats` — rewritten against `backfill_runs` (D1) instead of the Convex `imports` row.

```ts
class EnumeratorWorkflow extends WorkflowEntrypoint<Env, { tenantId; sourceId; runId; kind }> {
  async run(event, step) {
    const { tenantId, sourceId, runId, kind } = event.payload;
    const importer = makeImporter(kind, /* untrusted config */);   // chatgpt|claude-code|gmail|ob1|github
    const begin = await step.do('begin', () => importer.begin({ resumeCursor: loadCursor(runId) }));
    let cursor = begin.cursor; let n = 0;
    while (cursor !== null) {
      const batch = await step.do(`page-${n}`, async () => {
        const b = await importer.nextBatch(cursor);
        // enqueue REFERENCES, never payloads (write body to R2 first if large):
        for (const item of b.items) {
          const payloadRef = await scopedR2.putIfLarge(item);     // returns inline string OR r2 key
          await env.BACKFILL_QUEUE.send({ tenantId, sourceId, runId, kind, payloadRef,
                                          fingerprint: item.fingerprint });
        }
        return { nextCursor: b.nextCursor, count: b.items.length };
      });
      cursor = batch.nextCursor;                                   // persisted via backfill_runs.cursor
      await persistCursor(runId, cursor, importer.stats());        // advance only on clean batch
      n++;
    }
    await step.do('finalize', () => importer.finalize());          // anchor advances here, clean pass only
  }
}
```

**Stage 2 — `brain-backfill` Queue (+ DLQ).** Message = `{ tenantId, sourceId, runId, kind, payloadRef, fingerprint }`. wrangler consumer config (verified shape from the plan): `max_batch_size:10, max_batch_timeout:30, max_retries:5, dead_letter_queue:'brain-backfill-dlq', max_concurrency:10, retry_delay:30`. The consumer does **per-message** `msg.ack()` / `msg.retry({delaySeconds})` so one poison item doesn't fail the batch (mirrors gbrain pushing one path to `cursor.failed`, `gbrain-cf:src/sync.ts`). Poison messages land in the DLQ — a real DLQ vs gbrain's dead-end `jobs.error`. Heavy multi-step items spawn a **Batch-Ingest Workflow** with deterministic id `ingest-${tenantId}-${fingerprint}` (idempotent under at-least-once delivery — re-delivery is a no-op). The consumer builds a `Principal` from the explicit `tenant_id` in the message and goes through `Scoped*` (§5d — bindings remove the network surface but never bypass isolation).

**Stage 3 — Batch-Ingest Workflow.** cf-graph `IngestionWorkflow` near-verbatim (`cf-graph:apps/graph/src/api/workflows/ingestion.ts`): `CHUNK_DB_BATCH_SIZE=10`, `EMBED_BATCH_SIZE=50`, `KG_BATCH_SIZE=5`, per-phase retries, status FSM. Add `tenant_id` to every row/vector + `embedded_at`/`embedding_model` stamping (which cf-graph currently lacks). Body → R2, index → D1. For session backfill the item is a transcript and this Workflow does the same promote+embed as 8.3.

**Provenance/trust on backfilled records.** Every backfilled record gets `provenance{origin:'import', sourceId}`, `sourceRefs`, `trust_grade='evidence'` (never auto-`instruction`), and a `memory_audit` row — the openbrains import discipline (`openbrains:packages/convex/convex/memory/writeback.ts`).

**Backfill claim.** The enumerator-run row keeps gbrain's optimistic conditional claim `UPDATE backfill_runs SET status='running', updated_at=? WHERE id=? AND status=? AND updated_at=?` + a `STALE_RUNNING_MS` reclaim (`gbrain-cf:src/jobs.ts:52-59`). The Queue owns message-level dispatch; the row owns enumerator-run state only.

---

### 8.7 Re-embed worker (`brain-reembed` Queue, cron-fed)

Combines gbrain's `runEmbedJob` sweep (`gbrain-cf:src/jobs.ts:103-120`: `SELECT ... WHERE embedded_at IS NULL`) with openbrains' per-row model tracking. A cron sweeps any chunk/fact row where `embedding_model != 'bge-m3' OR embedded_at IS NULL OR updated_at > embedded_at` and enqueues it on `brain-reembed`; the consumer re-embeds, upserts the same Vectorize id, and stamps `embedded_at`/`embedding_model`. This is also how imported sessions (emitted `embeddingModel:'pending'` by the ChatGPT/Claude-Code/OB1 importers) get their 1024d vectors. The re-embed migration is a **budgeted, resumable job**: cost ≈ `N·T × bge-m3 $/Mtok` recorded in the migration `backfill_run` before kickoff; drain rate gated by `EMBED_BATCH_SIZE=50` + Queue concurrency; traffic tagged `migration` in AI Gateway so it cannot exhaust a tenant's interactive budget (§6).

---

### 8.8 Edge cases & invariants

- **Duplicate Stop-hook / duplicate Queue delivery:** deterministic Workflow ids (`promote-${tenantId}-${sessionId}`, `ingest-${tenantId}-${fingerprint}`) make re-triggers no-ops.
- **Client re-pushes a session it already pushed:** `idx_sessions_source` unique index upserts by `(tenant_id, client, source_session_id)`; `content_hash` compare (gbrain skip-unchanged, `gbrain-cf:src/engine.ts`) avoids re-promoting an *unchanged* transcript. A *changed* (edited/re-run) transcript re-promotes, but writeback **soft-expires the prior promoted fact set for that `source_session_id` before inserting** (§8.3), so re-finalize is a clean replace, not a duplicate append (iter-3 dedup fix).
- **Missed Stop-hook:** idle-promotion cron (8.3) promotes `status='open'` sessions whose **`last_activity_at`** is stale. It deliberately does **not** key on `ended_at` — a missed Stop-hook is exactly the case where `ended_at` is NULL, so an `ended_at`-keyed sweep would never fire (iter-3 SC6 fix).
- **AI binding absent:** `embed()`/`generate()` return null/degrade and never throw (gbrain contract, `gbrain-cf:src/ai.ts`); the fact-extract step reports `extraction_failed` (`gbrain-cf:src/ops/facts.ts:80-82`) and the chunk stays `embedded_at IS NULL` for the re-embed sweep to retry.
- **Enumerator killed mid-run:** resumes from `backfill_runs.cursor`; anchor untouched (advances only on clean finalize, `gbrain-cf:src/sync.ts:7-8`).
- **Truncated source tree (GitHub):** refuse to advance the anchor (`gbrain-cf:src/sync.ts:51-52`).
- **Cross-tenant id in recall results:** silently dropped, no trace, no existence leak (`openbrains:packages/convex/convex/memory/recall.ts:36-38`).
- **Oversized turn:** offloaded to R2 with `r2_offset`; `session_turns.content` set NULL. Full transcript always in R2.
- **Anti-loop:** `is_dream_generated` skips extraction (`gbrain-cf:src/ops/facts.ts:62-64`), preventing promoted facts from re-feeding extraction.
- **D1 100-param limit:** `CHUNK_DB_BATCH_SIZE=10` (cf-graph, `cf-graph:apps/graph/src/api/workflows/ingestion.ts:135`); writeback uses one `db.batch` per fact (no cross-await tx in D1).
- **Vectorize eventual consistency:** D1 row is the existence gate; vector deletes idempotent/retry-safe, never assumed immediately visible (§5c/§5h).

#### Code references

- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0004_facts.sql — facts hot-memory table (kind/visibility/notability/confidence, validity window, superseded_by lineage) + facts_fts external-content FTS5 table and insert/delete/update triggers. Port verbatim, re-keyed source_id->tenant_id, add scope/team_id/user_id/source_session_id/is_dream_generated columns.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/facts.ts — extract_facts / recall / forget_fact MCP op shapes, anti-loop is_dream_generated guard (62-64), recall dispatch (entity/since/session/query/grep) and parseSinceParam (199-223). Port with tenant_id replacing the DEFAULT_SOURCE_ID constant.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/facts.ts — insertFacts INSERT SQL (64-92), recallFacts WHERE-builder with FTS5 subquery + LIKE fallback (111-159) and the id IN (SELECT rowid FROM facts_fts WHERE MATCH ?) keyword arm (144-153). Base WHERE switched from source_id to ScopedDB-injected tenant_id.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/routes-platform.ts — POST /ingest webhook: bearer+write scope, content-type normalize, 256KB cap, sha256 content_hash, audit row + 202 response. Port; replace the D1 jobs insert (96-113) with env.BACKFILL_QUEUE.send and verifyBearer with resolvePrincipal.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/jobs.ts — Optimistic conditional claim + STALE_RUNNING_MS reclaim (33-59) for backfill_runs enumerator state; runEmbedJob embedded_at IS NULL sweep (103-120) as the re-embed worker skeleton.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/sync.ts — Cursor/anchor discipline: cursor in job row, anchor advances only on clean pass (7-8), per-file failure never advances (no silent loss), truncated-tree refusal (51-52), MAX_FILES_PER_TICK bound (31). The Enumerator Workflow cursor/anchor logic.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0005_platform.sql — jobs table FSM (status CHECK queued/running/completed/failed/cancelled, params/result, 44-58) + ingest_log + sources tables — base for the unified backfill_runs table and source registry.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/workflows/ingestion.ts — Durable WorkflowEntrypoint template (51-422): per-phase step.do with retries{limit,backoff:'exponential'}, CHUNK_DB_BATCH_SIZE=10 (135), EMBED_BATCH_SIZE=50, KG_BATCH_SIZE=5, status FSM, fts trigger insert. Literal template for SessionPromoteWorkflow and Batch-Ingest Workflow; add tenant_id + embedded_at/embedding_model stamping.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/types.ts — Importer contract (begin/nextBatch/finalize, 56-63) and BrainBundleThought shape incl. provenance[].sessionId + sourceRefs[] (12-39). Lift verbatim as the batch-import interface for ChatGPT/Claude-Code/Gmail/OB1 importers.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/contract.ts — runImporterContract invariants (18-51): no empty-batch-with-non-null-cursor, terminal null cursor, finalize once. The Enumerator Workflow drive-loop invariants + per-source test harness.
- openbrains:/home/roboto/devel/openbrains/packages/ingest/src/sources/ob1.ts — Template for net-new chatgpt.ts/claude-code.ts importers: parse untrusted JSON, per-field narrowing (asRecord/asStringArray), drop foreign embeddings, emit embeddingModel:'pending'/0, offset cursor with parse guard (50-65), {items,nextCursor} batching (190-207).
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/writeback.ts — Atomic governed writeback (30-127): trust_grade='evidence' hard-wired (114, no arg), thought+provenance+use_policy+audit in one transaction. Rewrite against D1 db.batch as the promote writeback (one batch per fact).
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/recall.ts — Drop-don't-error cross-tenant rule (36-38, no existence leak) + per-kept-hit memory_recall_traces write (52-59). Port to D1 for the recall op's audit + isolation gate.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/importsAction.ts — driveImport orchestration (106+): persist cursor+stats after every batch (resumable), tenancy re-check on the run row -> NOT_FOUND before any write, merged-dedup accounting. Reimplement against backfill_runs (D1) inside the Enumerator Workflow; drop Convex.

---

## 9. API, MCP Server, CLI & Frontend

This section specifies the **four client-facing surfaces** of the Brain Platform — the HTTP/tRPC API, the unified MCP tool catalog, the `brain` CLI, and the TanStack Start + shadcn dashboard — and how each is bound to the single isolation invariant from §5: **every surface resolves a `Principal` at the edge and touches tenant data only through `ScopedDB`/`ScopedVectorize`/`ScopedR2`.** A surface never re-implements scoping; it is a thin adapter that maps a request into a service-layer call carrying the `Principal`.

All four surfaces live in the monorepo (§2): `apps/api` (Worker: Hono REST + tRPC + MCP DO + webhook), `apps/cli` (`brain`), `apps/dashboard` (TanStack Start on Workers). They share `packages/shared` (Zod tool schemas + types + model constants) so the tool catalog, the REST contract, the CLI client types, and the dashboard server-fn validators are **one source of truth**, not four hand-synced copies.

---

### 9.0 Shared foundations (the contract layer)

#### 9.0.1 `Principal` and the edge resolver

Every request — REST, tRPC, MCP, webhook — resolves to one shape before any handler runs. This is the **same canonical `Principal` contract defined in §1.4** (and detailed in §7.2) — it is *referenced, not redefined*; the surface layer adds only two non-security convenience fields (`defaultScope`, `via`). Crucially it keeps the two axes separate (`allowedScopes` = data partition, `capabilities` = read|write|admin) — the earlier single-`scopes` collapse is removed (§1.4, §7.2):

```ts
// packages/shared/src/principal.ts — surface-layer view of the §1.4 / §7.2 contract
export interface Principal {
  tenantId: string;          // hard isolation boundary (orgs.id)
  userId: string;            // authorship / audit attribution
  teamIds: string[];         // teams the user belongs to within tenantId
  role: 'owner' | 'admin' | 'member' | 'readonly';
  allowedScopes: string[] | '*'; // DATA partition: client/project scopes ('*' = all; the default)
  capabilities: ('read' | 'write' | 'admin')[]; // CAPABILITY axis (consumed by scopeSatisfied)
  readOnly: boolean;         // role==='readonly' OR API-key/MCP-slug read_only flag
  defaultScope?: string;     // session-pinned DEFAULT scope (KV); a tool arg overrides it,
                             //   and the supplied scope is still authorized against allowedScopes (§7.3)
  via: 'oauth' | 'machine' | 'apikey'; // for audit
}
```

`resolvePrincipal(req, env): Promise<Principal>` tries, in order (port of cf-graph's fallback chain, openbrains' multi-token resolver, gbrain's bearer verify):
1. **OAuth/Clerk JWT** — `jose.jwtVerify` against remote JWKS, issuer-checked, `sub → userId` (`openbrains:apps/mcp/src/auth/clerk.ts`). The **active tenant is resolved first** by one pinned mechanism per surface (§7.2 `requestedTenant`): the signed `/mcp/<slug>` slug (MCP), a validated `X-Brain-Tenant` header (REST), or a server-side session pin (dashboard) — i.e. `tenantId` comes from the authenticated context / OAuth resource, never the JWT alone. **When unspecified the resolver errors (401) — never a silent first-membership default** (which could write to the wrong tenant). The **membership lookup is then scoped to that one tenant**: `SELECT tenant_id, team_id, role, allowed_scopes FROM memberships WHERE user_id = ? AND tenant_id = ?` → no matching row ⇒ `401` (this query IS the re-check against `memberships`, so the mechanism is ergonomics, not a trust boundary), else attach `tenantId/teamIds/role/allowedScopes` for the matched row (NULL grant or owner/admin ⇒ `allowedScopes='*'`). Scoping the resolution to the request's tenant means a user who belongs to **multiple** tenants never over-matches: the resolved `Principal` is bound to exactly one tenant per request.
2. **Machine token** — HMAC-SHA256 self-contained `bdev_<payload>.<sig>` (port `openbrains:apps/mcp/src/auth/device-token.ts`), `tenant_id` baked into claims, verified with WebCrypto; `allowedScopes` is resolved from the membership lookup for `(userId, tenantId)` (§7.2 `principalFromMembership`) — NULL grant or owner/admin ⇒ `'*'`, else the union of the member's restricted grants — never a hard-coded `'*'`.
3. **API key** — `bk_` prefix + SHA-256 hash looked up in `api_keys.hash` (port `cf-graph:apps/graph/src/api/services/api-keys.ts`), carrying `tenant_id`, the stored `scopes[]` JSON (which becomes `Principal.capabilities`, **not** `allowedScopes`), `read_only`, `expires_at`; `allowedScopes` is resolved from the key's stored `api_keys.allowed_scopes` (pinned at mint time to the intersection with the minter's grant — §7.2 iter-3 escalation fix; NULL ⇒ `'*'` only when the minter was itself `'*'`), so a restricted key never resolves to `'*'`; `last_used_at` updated fire-and-forget.

Failure → `401`. The resolved `Principal` is the only thing handlers receive; **a bare token never reaches the service layer** (§2 diagram).

#### 9.0.2 The unified tool catalog (one registry, three consumers)

The MCP tool catalog, the tRPC procedures, and the CLI commands are all generated from **one operation registry** modeled on gbrain's ops pattern (`gbrain-cf:src/ops/index.ts`, `op-types.ts`), which is the cleanest of the three (gbrain auto-builds MCP `inputSchema` and does scope-gated dispatch from a single array). We upgrade it from gbrain's hand-rolled `ParamDef` to **Zod schemas** (openbrains already uses Zod input/output schemas per tool — `openbrains:apps/mcp/src/mcp/server.ts`), so the same schema validates MCP args, tRPC input, CLI flags, and dashboard server-fn input.

```ts
// packages/shared/src/ops/types.ts
export interface Operation<I = unknown, O = unknown> {
  name: string;                       // 'search', 'capture_session', ...
  description: string;
  scope: 'read' | 'write' | 'admin';  // gbrain scope hierarchy: admin⊃write⊃read
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  surfaces?: ('mcp' | 'rest' | 'cli')[]; // default: all three
  handler: (ctx: OpContext, input: I) => Promise<O>;
}
export interface OpContext {
  principal: Principal;
  db: ScopedDB;          // already tenant-bound (§5a)
  vec: ScopedVectorize;  // already namespace-bound (§5b)
  r2: ScopedR2;          // already prefix-bound
  ai: AiServices;        // embed/gen/rerank chokepoints (§4.2, §4.3)
  env: Env;
  waitUntil: (p: Promise<unknown>) => void;
}
```

`scopeSatisfied(required, principal)` is gbrain's hierarchy verbatim (`gbrain-cf:src/mcp.ts`), evaluated against `principal.capabilities` (the capability axis — **not** `allowedScopes`, which is the data partition): `admin` implies all; `write` implies `read`; a `readOnly` principal is denied any `write`/`admin` op. **Mutating ops also check `principal.readOnly` before dispatch** (cf-graph honors this by not even registering mutation tools for read-only keys — `cf-graph:apps/graph/src/mcp/server.ts`; we keep that belt-and-suspenders: read-only principals get the read subset registered only).

Adding a capability = adding one `Operation`; it appears in MCP `tools/list`, in tRPC, and in `brain` CLI help with no further wiring.

---

### 9.1 HTTP / tRPC API surface

#### 9.1.1 Two layers: tRPC (typed app surface) + Hono REST (everything else)

cf-graph proves tRPC-on-Workers works (`cf-graph:apps/graph/src/api/trpc/`): `protectedProcedure` is the choke-point (`cf-graph:apps/graph/src/api/trpc/trpc.ts` — `UNAUTHORIZED` if no identity, narrows ctx). We adopt tRPC for the **dashboard ↔ API typed surface and the CLI** (cf-graph's CLI is a tRPC client — `cf-graph:apps/cli/src/client.ts`), and Hono REST for **webhooks, file upload, OAuth, MCP transport, and importer triggers** (multipart and raw-body paths that don't fit tRPC).

The tRPC context is upgraded from cf-graph's `{ db, userId }` to carry the full `Principal` and the scoped handles:

```ts
// apps/api/src/trpc/context.ts  (cf. cf-graph:apps/graph/src/api/trpc/context.ts)
export function createContext(env: Env, principal: Principal, ec: ExecutionContext) {
  return {
    principal,
    db: new ScopedDB(principal, env),           // §5a
    vec: new ScopedVectorize(principal, env),   // §5b
    r2: new ScopedR2(principal, env),
    ai: createAiServices(env),
    env, executionCtx: ec,
  };
}
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx });
});
export const writeProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.readOnly) throw new TRPCError({ code: 'FORBIDDEN' });
  return next({ ctx });
});
```

**Router tree** (generalizing `cf-graph:apps/graph/src/api/trpc/router.ts` + the new capabilities):

```ts
export const appRouter = router({
  documents,    // ingest, list, get, search, reprocess, delete, listChunks, ingestChunked
  search,       // search | query | think (hybrid + rerank + synth)
  graph,        // entities, relations, traverse, backlinks, tags, timeline, orphans
  sessions,     // list, get, captureTurn, finalize, importStatus  (NET-NEW)
  facts,        // recall, extract, forget                          (gbrain port)
  governance,   // review, audit (list), recallTraces (list)        (openbrains port)
  backfill,     // sources (CRUD), runs (list/cancel), reembed.dryRun(NET-NEW)
  admin,        // tenancy: teams, memberships, scopes, apiKeys, tokenSpend
});
```

`documents` is ported nearly verbatim from `cf-graph:apps/graph/src/api/trpc/routers/documents.ts` (note its `ctx.executionCtx.waitUntil(result.backgroundWork)` pattern for kicking the Workflow after the response — we keep that), swapping `workspaceId` inputs for **implicit `ctx.principal.tenantId`** (the input no longer carries the tenant; the scoped ctx supplies it — this removes the "forgot a `workspaceId` filter" leak class).

#### 9.1.2 REST routes (Hono)

| Method & path | Purpose | Source pattern | Auth |
|---|---|---|---|
| `POST /trpc/*` | tRPC batch endpoint | cf-graph | Principal |
| `POST /ingest` | webhook capture: hash body, 256 KB cap, content-type normalize, `ingest_log` audit row + enqueue to `brain-backfill`, return `202 {runId}` | `gbrain-cf:src/routes-platform.ts` | API key / machine token, `write` |
| `POST /documents/upload` | multipart file upload → R2 → trigger Batch-Ingest Workflow | `cf-graph:apps/graph/src/api/services/documents.ts` `uploadDocument` | Principal, `write` |
| `POST /importers/:kind/run` | start an Enumerator Workflow for a registered source | NET-NEW (§6) | Principal, `write` |
| `ALL /mcp` and `/mcp/:slug` | MCP Streamable-HTTP transport (see §9.2) | gbrain + cf-graph | OAuth/machine |
| `POST /authorize`, `/token`, `/register`, `/device_authorization` | OAuth 2.1 + RFC 8628 device flow | `openbrains:apps/mcp/src/index.ts` | n/a |
| `GET /healthz` | liveness; no tenant data | — | none |

The `/ingest` handler is ported almost verbatim (it already does body-hash, content-type normalization to `md/plain/json`, the 256 KB cap, an audit row, and a queued job + `202`); the only change is the queued job becomes a **Queue message** instead of a D1 `jobs` row, and the row carries `tenant_id` (resolved from the API key).

**Internal hops are NOT REST.** Worker↔Workflow / Worker↔Queue-consumer go over native bindings (§5d) — we explicitly drop openbrains' `X-OpenBrains-Internal-Secret` HTTP internal routes (`openbrains:apps/mcp/src/internal/ai-route.ts`, `vector-route.ts`) because those existed only to bridge Convex→Worker; with no Convex, there is no internal HTTP boundary to secure.

#### 9.1.3 Error envelope & edge cases

- tRPC: standard `TRPCError` codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`) — cf-graph's router already maps service exceptions to these.
- REST/MCP tool errors use gbrain's `OperationError` JSON envelope (`{error, message}` with `isError`) so MCP clients get structured failures (`gbrain-cf:src/mcp.ts` `toolResult(..., true)`).
- **Cross-tenant id requested** → `NOT_FOUND` (never `FORBIDDEN`), so existence isn't leaked (openbrains drop-don't-error rule, `openbrains:packages/convex/convex/memory/recall.ts`). An *unscoped* query by a restricted-`allowedScopes` principal likewise just returns its granted scopes (no leak, no error).
- **Read-only writes** → `FORBIDDEN`.
- **Explicit out-of-grant `scope` argument** → `FORBIDDEN` (the caller named a scope outside its `allowedScopes`; this is a deliberate authorization denial, distinct from the silent drop on unscoped reads — §7.3 `assertScopeAllowed`).
- **Spend ceiling breached** → `429` with `Retry-After`, raised by the **app-level `token_spend` pre-check before `env.AI.run`** (the enforcing cap for the all-`@cf/` v1 model set; AI Gateway spend limits do not cover it, §5f). The pre-check trips when projected monthly spend would exceed `MONTHLY_COST_CEILING_USD` (default `400`, configurable via env var and per-tenant-overridable; at 1-2 tenants this is effectively the whole-platform budget). The dashboard surfaces this as a banner. A Workers-AI **request-RATE** limit, by contrast, degrades the read path or re-queues the write path (§5.1) rather than returning `429` to the user.

---

### 9.2 MCP server (the unified tool catalog)

#### 9.2.1 Transport & isolation

The MCP server is a **per-tenant Durable Object** that is *only* the protocol instance, never the system of record (§1 DO decision). We take cf-graph's `MyMCP extends McpAgent` DO pattern (`cf-graph:apps/graph/src/mcp/server.ts`) and its slug-scoped routing (`cf-graph:apps/graph/src/mcp/workspace-scoped-handler.ts`): a request to `/mcp/<slug>` resolves the slug → `{tenant_id, scope, read_only}` against `memberships`/`scopes`, stamps `Principal.readOnly` from role, and injects it as `ctx.props`. The OAuth provider wiring (`/authorize`, `/token`, `/register`, device flow, `resolveExternalToken` for `bdev_` machine tokens) is ported from `openbrains:apps/mcp/src/index.ts` near-verbatim.

For maximum client compatibility we expose **both** transports behind the same registry:
- a **stateless Streamable-HTTP** `POST /mcp` (gbrain's `handleMcp` — `gbrain-cf:src/mcp.ts`: `initialize`, `notifications/initialized`→204, `tools/list`, `tools/call`), and
- the **DO-backed `McpAgent`** at `/mcp/:slug` (cf-graph) for stateful sessions and SSE.

Both call the **same `operations[]` registry** and the same `scopeSatisfied` gate. Tool registration mirrors openbrains (`server.registerTool(name, {description, inputSchema, outputSchema}, handler)` — `openbrains:apps/mcp/src/mcp/server.ts`) but reads from our shared registry so the catalog can't drift between MCP and tRPC.

Per-call observability: every `tools/call` writes an `mcp_request_log` row (operation, latency, status, tenant) via `waitUntil` — gbrain already does this (`gbrain-cf:src/mcp.ts` `logMcpRequest`).

#### 9.2.2 The unified tool set

The catalog is the **union of gbrain's 47-tool surface** (`gbrain-cf:src/ops/{core,search,facts,platform,skills}.ts`) and **openbrains' 25 tools** (`openbrains:apps/mcp/src/mcp/server.ts`), deduplicated, tenant-scoped, and extended with the net-new session/backfill/governance tools. Grouped by capability:

**Search & think** (gbrain `search.ts` + openbrains): `search` (keyword+vector RRF, expansion off), `query` (expansion on), `think` (expansion + rerank + cited synthesis with `{answer, evidence[], citations[], gaps[], warnings}`), `recall` (hot facts: entity/since/session/query/grep), plus the **ChatGPT-connector-compatible `search`→`[{id,title,url}]` and `fetch`** pair (port `openbrains:apps/mcp/src/mcp/tools/search.ts` + `fetch-thought.ts` — required for ChatGPT Deep Research connector compatibility).

**Documents & ingestion** (cf-graph + gbrain): `put_page`/`upsert_document`, `get_document`, `list_documents`, `search_documents`, `document_status`, `get_chunks`, `reprocess_document`, `delete_document`, `ingest_chunked` (pre-chunked path — `cf-graph:apps/graph/src/api/trpc/routers/documents.ts`).

**Graph** (gbrain BFS + cf-graph/openbrains entities): `traverse_graph` (generalized BFS over `doc_links` AND `entity_relations`, depth 1..10), `get_links`, `get_backlinks`, `find_orphans`, `add_link`/`remove_link`, `list_entities`, `get_entity`, `entity_relations`, `search_entities` (v1 — scoped entity vector search over `brain-entities` via `ScopedVectorize` `namespace=tenantId`, scope/visibility folded into the metadata filter and re-checked on the `entities` D1 row with `scopePredicate` + the `{world,team}` `visibilityPredicate`, optionally fused with `entity_fts` via RRF; §6.6/§6.7/§3.2), `add_tag`/`remove_tag`/`get_tags`, `add_timeline_entry`/`get_timeline`, `get_versions`/`revert_version`.

**Facts / governed memory** (gbrain facts + openbrains trust): `extract_facts`, `forget_fact`, `memory_writeback` (hard-wires `trust_grade='evidence'`, no arg — openbrains invariant `openbrains:packages/convex/convex/memory/writeback.ts`), `memory_recall` (writes a `memory_recall_traces` row per kept hit), `memory_review` (the *only* path to `instruction` grade).

**Sessions (NET-NEW)**: `capture_turn(session_id, role, content)` (live per-turn ingress), `finalize_session(session_id)` (triggers `SessionPromoteWorkflow`), `get_session`, `list_sessions`, `get_session_context(snapshot_id?)` (v1 live instruction-grade injection via `ScopedDB.readFacts` — §1.5/§8.5/§7.5; the optional `snapshot_id` arg for a frozen-snapshot read is accepted but deferred).

**Enrichment** (openbrains LLM tools): `classify_thought`/`classify_thought_apply`, `enrich_thought`/`enrich_thought_apply`, `pan_brain_dump`/`pan_brain_dump_apply` (split freeform dumps into idea candidates).

**Scope/session pinning** (openbrains): `list_projects`/`create_project` (scopes), `set_session_scope`/`get_session_scope` (pin a default scope in `OAUTH_KV`, tool arg overrides — `openbrains:apps/mcp/src/mcp/session-scope-store.ts`).

**Backfill & ops** (gbrain platform + NET-NEW): `sources_add`/`sources_list`/`sources_remove`/`sources_status`, `list_jobs`/`get_job`/`cancel_job` (now backed by `backfill_runs`), `reembed_dry_run` (reports estimated vectors + dollar cost before draining — §6), `get_stats`/`get_health`/`run_doctor`/`get_ingest_log`, `whoami`/`get_brain_identity` (returns the resolved `Principal` minus secrets).

**Admin (`admin` scope only)**: `list_memberships`, `invite_member`, `create_team`, `mint_api_key`, `get_token_spend` (per-tenant spend from `token_spend`), `memory.break_glass_read` (§7.6 audited break-glass read over another member's `private` chunks/facts — `role ∈ {owner, admin}` only, fails CLOSED to `403` for non-admins, writes a `breakglass_read` audit row + high-severity alert on every call; intra-tenant only, exercised by canaries #14/#15).

Every tool's `input`/`output` is a Zod schema in `packages/shared/src/ops/*`; defaults (cosine `threshold` 0.5 for recall, 0.85 for related, `topK` caps 1..50) are reused from openbrains' validated constants (`openbrains:packages/shared/src/tools/search-thoughts.ts`).

#### 9.2.3 MCP edge cases

- **Read-only key** → only `scope: 'read'` ops are registered (cf-graph) AND `scopeSatisfied` denies any leaked write (gbrain) — double gate.
- **Unknown tool** → `toolResult({error:'unknown_tool'}, true)` (gbrain).
- **Missing slug/tenant context** → register a single `error` tool explaining reconnection (cf-graph `MyMCP.init` does exactly this).
- **`traverse_graph` cross-tenant hop** is structurally impossible: every BFS frontier query goes through `ScopedDB` which appends `AND tenant_id = ?` to the `IN (...)` query (§5 "every BFS hop carries tenant_id"); a dedicated CI test asserts a shared slug cannot walk across tenants.

---

### 9.3 CLI (`brain`)

The `brain` CLI is a Commander program (port `cf-graph:apps/cli/src/index.ts` — `commander`, `program.name('brain')`, global `--url` and a `--tenant`/`-t` flag replacing cf-graph's `-w/--workspace`). It is a **tRPC client** over the same `appRouter` (port `cf-graph:apps/cli/src/client.ts`, `api-types.ts`), so command inputs are type-checked against the server contract.

**Auth = OAuth 2.1 device flow** (port `cf-graph:apps/cli/src/commands/auth.ts` + `auth.ts` `loginWithBrowser`; server side is the RFC 8628 device-code grant from `openbrains:apps/mcp/src/index.ts` + `auth/device-flow.ts`). Tokens (access + refresh + `expiresAt`) are persisted to `~/.config/brain/config.json` (cf-graph `config.ts` pattern); the client auto-refreshes on `401`. `brain auth status` shows tenant, token expiry, and refresh-token presence (cf-graph verbatim).

**Command groups** (mirror `cf-graph:apps/cli/src/commands/*` + new capabilities):

```
brain auth      login | logout | status                 # device flow
brain tenant    list | use <slug> | members | invite    # multi-tenant (NET-NEW)
brain doc       upload <file> | list | get <id> | reprocess <id> | rm <id>
brain search    "<query>" [--mode vector|keyword|hybrid] [--rerank] [--think]
brain graph     entities | relations <id> | traverse <slug> [--depth N] | orphans
brain session   capture <id> --role --content | finalize <id> | list | show <id>
brain facts     recall [--entity --since --session] | extract <text> | forget <id>
brain source    add <kind> <config> | list | status <id> | sync <id>   # backfill
brain backfill  runs | cancel <id> | reembed --dry-run                 # NET-NEW
brain key       create [--read-only --scope ...] | list | revoke <id>
```

`brain doc upload` reuses cf-graph's chunked-upload helper (`cf-graph:apps/cli/src/utils/upload.ts`) and the `ingestChunked` mutation for already-chunked inputs. Output is human tables by default, `--json` for piping (cf-graph commands already branch on a `--json` flag). A `--tenant` flag, or `brain tenant use <slug>` (persisted), selects the active tenant; the server still re-validates membership server-side, so a spoofed flag changes nothing.

---

### 9.4 Frontend / dashboard (TanStack Start + shadcn on Workers)

#### 9.4.1 Stack & shape

The dashboard is **TanStack Start + shadcn, deployed to Workers**, using `openbrains:apps/dashboard` as the literal template — same `wrangler.jsonc`, `vite.config.ts`, file-based routing under `src/routes/`, `__root.tsx` with a sidebar + header shell, and **`createServerFn` for the data layer**. The two changes versus openbrains:
1. **Auth stays Clerk** (`ClerkProvider`, `<Show when="signed-in">` gates — `openbrains:apps/dashboard/src/routes/__root.tsx`), but the **project switcher becomes a tenant + scope switcher** (the openbrains `ProjectSwitcher`/`NewProjectDialog` components map onto our `scopes`, and a top-level org switcher is added because openbrains was single-org-per-user).
2. **`createServerFn` handlers call the service layer through `ScopedDB`/`ScopedVectorize` directly** (no Convex). openbrains' server fns already do exactly this shape — resolve `userId` from Clerk `auth()` server-side, build service deps from Worker bindings, call the typed service, map `ServiceInputError`→`Error` (`openbrains:apps/dashboard/src/server/search.ts`, `stats.ts`, `deps.ts`). We swap `userId` for the full `Principal` (tenant from the active-tenant cookie, re-validated against `memberships`) and drop the Convex client from `deps.ts`. **Critical: the tenant is taken from server-side membership resolution, never from the request body** (openbrains' `deps.ts` already documents this rule — "userId attribution comes from `auth()`, NOT from the request body").

The dashboard worker is a trusted server; it does NOT need the internal-secret bridge openbrains used for Convex (`openbrains:apps/dashboard/src/server/internal-ai-chat-route.ts` is dropped — that endpoint only existed to let Convex actions borrow the Worker's `AI` binding).

#### 9.4.2 Routes & key screens

Mapping the openbrains route set (`openbrains:apps/dashboard/src/routes/`) onto the Brain Platform's capabilities:

| Route | Screen | Reuses (openbrains) | Notes |
|---|---|---|---|
| `/` | Overview: counts, recent sessions, spend headroom vs §0 triggers | `index.tsx` | adds `token_spend` + D1/Vectorize usage panels |
| `/search` | **Search / think**: query box, mode toggle (vector/keyword/hybrid), rerank+think toggles; results with scores; `think` view shows answer + numbered evidence + citations + gaps/warnings | `search.tsx` | new "think" panel renders the `{answer,evidence,citations,gaps,warnings}` envelope from §4.3 |
| `/documents`, `/documents/$id` | Document list + detail (chunks, status FSM, r2_key preview) | `thoughts.tsx`, `thoughts_.$id.tsx`, `ingest.tsx` | body fetched from R2 on demand (D1 has preview only) |
| `/inspector` | **Inspector / review**: review queue (`unreviewed|confirmed|rejected|needs_revision`) + duplicate candidates; promote evidence→instruction | `inspector.tsx` (reviews + duplicates tabs) | drives `memory_review`; promotion is the only path to `instruction` grade |
| `/graph` | **Graph** visualization: entities + typed relations + doc_links, click-to-traverse (BFS depth control), backlinks, orphans | `graph.tsx`, `entities.tsx`, `entities.$id.tsx` | both edge tables via the generalized BFS |
| `/audit` | **Audit**: append-only `memory_audit` + `memory_recall_traces` + `mcp_request_log`, tenant-filtered | `audit.tsx` | |
| `/sessions`, `/sessions/$id` | Session list + transcript view (turns + facts promoted) | NET-NEW (model on `thoughts_.$id.tsx`) | transcript body streamed from R2 |
| `/jobs` | Backfill runs / re-embed sweeps: status, cursor, stats, DLQ items | `jobs.tsx` | backed by `backfill_runs` |
| `/admin` | **Admin / tenancy**: teams, memberships, scopes, API keys, per-tenant spend caps | `api-keys.tsx` + new tenancy panels | `admin`-role only; `mint_api_key` with read-only + scope checkboxes |
| `/stats`, `/quality` | Stats + embedding-coverage / quality dashboards | `stats.tsx`, `quality.tsx` | coverage = rows where `embedded_at IS NULL OR embedding_model != bge-m3` |
| `/sign-in/$`, `/sign-up/$` | Clerk auth pages | `sign-in.$.tsx`, `sign-up.$.tsx` | verbatim |

Each authed route follows openbrains' pattern: `createFileRoute('/x')({ component })`, body wrapped in `<Show when="signed-in">`, data via `useServerFn`/loader calling a `createServerFn` handler that resolves the `Principal` and calls the scoped service (`openbrains:apps/dashboard/src/routes/inspector.tsx` is the reference for a two-tab review screen with mutations/actions).

#### 9.4.3 Frontend edge cases

- **Tenant switch** re-keys all loaders (TanStack Router invalidation) so no stale-tenant data is shown; the active-tenant cookie is server-re-validated each fn call.
- **Read-only role** hides mutation affordances client-side and the server `writeProcedure`/op `readOnly` gate rejects regardless (defense-in-depth).
- **Spend `429`** → global banner; mutations that would hit a model are disabled while over budget.
- **Eventual consistency**: graph/search screens may briefly show a vector hit whose D1 row was deleted; the §5c re-check on the server fn drops it before it reaches the client, so the UI never renders a cross-tenant or deleted row.

---

### 9.5 Build order tie-in (Phase 5)

All four surfaces are finished in **Phase 5** (§7): MCP DO with read-only flag honored, `brain` CLI, the TanStack Start dashboard, AI Gateway per-tenant spend caps wired with a `token_spend` panel, and Analytics Engine ops metrics. The tool catalog itself is built incrementally across Phases 1–4 as each capability lands (the registry grows; the surfaces are generated from it), so Phase 5 is wiring transports + UI, not designing the contract.

#### Code references

- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/index.ts — Single operation registry + auto buildToolDefs (op params -> MCP inputSchema) + validateParams. The unified tool-catalog generator pattern; upgrade ParamDef to Zod.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/op-types.ts — Operation/ParamDef/OperationContext interfaces (name, description, scope read|write|admin, params, handler, waitUntil). The shape for the shared Operation type.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/mcp.ts — Stateless MCP Streamable-HTTP handler: initialize/notifications-initialized(204)/tools/list/tools/call, scopeSatisfied hierarchy (admin>write>read), toolResult envelope, OperationError JSON, mcp_request_log via waitUntil.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/search.ts — search/query/think tool definitions and the cited-synthesis {answer,evidence,citations,gaps,warnings} output shape.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/facts.ts — extract_facts/recall/forget_fact tool surface for hot-memory facts.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/ops/platform.ts — sources_*, list_jobs/get_job/cancel_job, get_stats/get_health/run_doctor/get_ingest_log, whoami/get_brain_identity ops to port onto backfill_runs.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/routes-platform.ts — POST /ingest webhook: body hash, 256KB cap, content-type normalize, audit row + queued job, 202 response. Port with tenant_id + Queue instead of D1 job.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/mcp/server.ts — McpServer.registerTool(name,{description,inputSchema,outputSchema},handler) with per-tool Zod input/output schemas; the 25-tool catalog incl. ChatGPT-connector search/fetch, memory_*, classify/enrich/pan_brain_dump, session-scope tools.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/index.ts — OAuthProvider wiring (/authorize,/token,/register), resolveExternalToken for bdev_ machine tokens, RFC 8628 device-code grant pre-filter on /token + /device_authorization. Drop the internal AI/vector HTTP routes (Convex-only).
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/auth/clerk.ts — Clerk JWT verify via jose jwtVerify (remote JWKS, issuer-checked, sub->userId) for resolvePrincipal step 1.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/auth/device-token.ts — HMAC-SHA256 self-contained machine tokens (signDeviceToken/verifyDeviceToken via WebCrypto). Generalize obdev_->bdev_ with tenant_id in claims.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/mcp/session-scope-store.ts — Per-user default scope pinned in OAUTH_KV + tool-arg-overrides-pin pattern for set_session_scope/get_session_scope.
- openbrains:/home/roboto/devel/openbrains/apps/mcp/src/mcp/tools/search.ts — ChatGPT-connector-compatible search tool returning [{id,title,url}] (paired with fetch-thought.ts).
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/writeback.ts — memory_writeback hard-wiring trust_grade='evidence' (no arg); the agent-writeback invariant for the MCP tool.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/recall.ts — Drop-don't-error cross-tenant rule (return NOT_FOUND, no existence leak) + memory_recall_traces write per kept hit.
- openbrains:/home/roboto/devel/openbrains/apps/dashboard/src/routes/__root.tsx — TanStack Start root shell: ClerkProvider, <Show when=signed-in/out>, sidebar+header layout, ProjectSwitcher/NewProjectDialog (map to tenant+scope switcher).
- openbrains:/home/roboto/devel/openbrains/apps/dashboard/src/routes/inspector.tsx — Inspector/review screen: reviews + duplicates tabs, useMutation/useAction, filter state. Reference for the /inspector review-queue screen.
- openbrains:/home/roboto/devel/openbrains/apps/dashboard/src/routes/graph.tsx — Graph visualization route (entities + relations). Reference for /graph.
- openbrains:/home/roboto/devel/openbrains/apps/dashboard/src/server/search.ts — createServerFn data-layer pattern: resolve userId from Clerk auth() server-side, validate input with shared Zod schema, call typed service, map ServiceInputError->Error. Swap userId for Principal.
- openbrains:/home/roboto/devel/openbrains/apps/dashboard/src/server/deps.ts — Server-only construction of service deps from Worker bindings (AI, VECTORIZE) and the rule that tenant/user attribution comes from auth(), NOT the request body. Drop Convex client.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/trpc/trpc.ts — protectedProcedure choke-point (UNAUTHORIZED + ctx narrowing). Add writeProcedure that rejects readOnly principals.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/trpc/router.ts — appRouter composition (documents/knowledgeGraph/workspaces/apiKeys). Extend with search/sessions/facts/governance/backfill/admin sub-routers.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/trpc/context.ts — createContext(env,userId,executionCtx) building db+ai. Upgrade to carry full Principal + ScopedDB/ScopedVectorize/ScopedR2.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/trpc/routers/documents.ts — documents router: list/get/delete/reprocess/search/ingestChunked/listChunks/update with Zod inputs and ctx.executionCtx.waitUntil(backgroundWork). Port replacing workspaceId input with ctx.principal.tenantId.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/server.ts — MyMCP extends McpAgent DO: slug->workspace resolution, readOnly prop gates which tool sets register (mutation tools skipped for read-only). Generalize to tenant/scope.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/mcp/workspace-scoped-handler.ts — /mcp/:slug URL-rewrite -> ctx.props injection. Resolve slug -> {tenant_id, scope, read_only} against memberships.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/middleware/auth.ts — cliTokenFallback multi-token resolver chain (Clerk -> API key -> CLI JWT -> one identity). Template for resolvePrincipal fallback order.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/api-keys.ts — API key generate (prefix + SHA-256 hash), validateApiKey, readOnly + scopes model, last_used_at fire-and-forget. Bind to one tenant_id.
- cf-graph:/home/roboto/devel/cf-graph/apps/cli/src/index.ts — Commander program scaffold (name, global --url, workspace flag w/ slug->id resolution preAction hook, register*Commands). Rename cfg->brain, -w->--tenant.
- cf-graph:/home/roboto/devel/cf-graph/apps/cli/src/commands/auth.ts — CLI auth login/logout/status (loginWithBrowser device flow, config persistence, token-expiry display).
- cf-graph:/home/roboto/devel/cf-graph/apps/cli/src/client.ts — tRPC client construction so the CLI is type-checked against appRouter.
- cf-graph:/home/roboto/devel/cf-graph/apps/cli/src/utils/upload.ts — Chunked file-upload helper for `brain doc upload`.

---

## 10. Deployment, Observability, Testing & Rollout

> Scope note: this section is the *operational spine* — it specifies the `wrangler.jsonc` shape, secrets/migrations/cron mechanics, the observability tiers, the test harness that *proves* isolation, and the deploy/rollout runbook. It does **not** re-specify the data model (§3) or the capability pipelines (§4–§6); it cites them. Where a mined repo has a directly-reusable artifact it is cited inline as `project:path`. Where the platform direction requires something **no mined repo has** (Queues, Service Bindings, Analytics Engine, AI Gateway wiring, the workerd test harness) it is marked **NET-NEW** and the syntax is taken from current Cloudflare docs (verified 2026-06-25), not extrapolated from the mined `wrangler.jsonc` files (which predate these primitives).

---

### 10.1 `wrangler.jsonc` — the binding manifest

`apps/api` is the single deployed Worker. It owns the Hono REST router, the MCP Durable Object, all Workflow classes, and all Queue consumers (the plan keeps one entry point — §2). The mined configs are the starting point for the *shape* of the simple bindings but are missing the entire async/observability spine; treat the block below as authoritative.

Baseline reused verbatim in spirit from `cf-graph:apps/graph/wrangler.jsonc` (D1 `DB`, Vectorize index bindings, R2 `FILES`, `ai.binding=AI`, `workflows[]`, DO `MCP_OBJECT` + `migrations[].new_sqlite_classes`, `OAUTH_KV`) and `gbrain-cf:wrangler.jsonc` (`observability.enabled`, `triggers.crons`, custom-domain `routes[]`).

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "brain-platform",
  "main": "apps/api/src/server.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],

  // TIER 1 observability: structured logs + tail. (gbrain-cf:wrangler.jsonc)
  "observability": { "enabled": true },

  // --- Relational source of truth (§3). v1 = a SINGLE D1, no shard fan-out (§5e). ---
  // At 1-2 tenants every tenant_shards row resolves to this ONE 'DB'; the multi-tenant
  // ISOLATION model is fully intact (tenant_id on every row), but the horizontal D1
  // SPLIT is a DEFERRED Phase-N scale-out trigger (§10.7), not a v1 build.
  "d1_databases": [
    { "binding": "DB", "database_name": "brain-platform", "database_id": "<id>", "migrations_dir": "packages/db/migrations" }
    // Phase-N sharding (§5e): future shard DBs appended here as DB_SHARD_1, ...;
    // tenant_shards.db_binding names the binding ScopedDB resolves per request (v1: always 'DB').
  ],

  // --- Vector memory (§4.2). Index dimension is LOCKED to bge-m3 1024d. ---
  // Both indexes are provisioned in v1: brain-chunks (chunk vectors) and brain-entities
  // (entity vectors from the embed-entities Workflow step, §4.5 / §6.2). Only cross-session
  // SEMANTIC dedup over entity vectors remains deferred to Phase 3.5.
  "vectorize": [
    { "binding": "CHUNKS_INDEX", "index_name": "brain-chunks" },
    { "binding": "ENTITY_INDEX", "index_name": "brain-entities" }
  ],

  // --- Raw bodies / transcripts. Tenant-prefixed keys ${tenantId}/... (§3 body-offload). ---
  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "brain-platform-files" }
  ],

  // --- Inference. Models pinned via vars, not hard-coded (§1, §4.3 budget guard). ---
  "ai": { "binding": "AI" },

  // --- OAuth provider state (workers-oauth-provider) + per-user default scope KV. ---
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "<id>" }
  ],

  // --- Durable Objects: MCP server instance ONLY (NOT system of record, §1). ---
  "durable_objects": {
    "bindings": [{ "name": "MCP_OBJECT", "class_name": "BrainMCP" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["BrainMCP"] }
  ],

  // --- Durable ingestion. 4 Workflow classes (§4.1, §4.4, §6). NET-NEW count. ---
  "workflows": [
    { "name": "brain-enumerator",  "binding": "ENUMERATOR_WORKFLOW",  "class_name": "EnumeratorWorkflow" },
    { "name": "brain-batch-ingest","binding": "INGEST_WORKFLOW",      "class_name": "BatchIngestWorkflow" },
    { "name": "brain-entity-extract","binding": "ENTITY_WORKFLOW",    "class_name": "EntityExtractionWorkflow" },
    { "name": "brain-session-promote","binding": "PROMOTE_WORKFLOW",  "class_name": "SessionPromoteWorkflow" }
  ],

  // --- Async spine. NET-NEW (no mined repo uses Queues). §6. ---
  // Producers send {tenantId,...} messages; consumers ack/retry per-message.
  "queues": {
    "producers": [
      { "binding": "BACKFILL_QUEUE", "queue": "brain-backfill" },
      { "binding": "REEMBED_QUEUE",  "queue": "brain-reembed" }
    ],
    "consumers": [
      { "queue": "brain-backfill", "max_batch_size": 10, "max_batch_timeout": 30,
        "max_retries": 5, "dead_letter_queue": "brain-backfill-dlq", "max_concurrency": 10, "retry_delay": 30 },
      { "queue": "brain-reembed",  "max_batch_size": 10, "max_batch_timeout": 30,
        "max_retries": 5, "dead_letter_queue": "brain-reembed-dlq",  "max_concurrency": 5,  "retry_delay": 60 }
    ]
  },

  // --- TIER 2 observability: sampled per-tenant ops metrics. NET-NEW. §10.5. ---
  "analytics_engine_datasets": [
    { "binding": "OPS_METRICS", "dataset": "brain_ops_metrics" }
  ],

  // --- Scheduled maintenance. §10.4. ---
  // Single cron; the scheduled() handler fans out to the maintenance tasks.
  "triggers": { "crons": ["*/5 * * * *"] },

  // --- Model + budget config (swappable behind the embed()/gen() chokepoints, §4.3). ---
  "vars": {
    "EMBEDDING_MODEL": "@cf/baai/bge-m3",
    "EMBEDDING_DIMS": "1024",
    "GENERATION_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "EXTRACTION_MODEL": "@cf/meta/llama-3.1-8b-instruct",
    "RERANKER_MODEL": "@cf/baai/bge-reranker-base",
    "AI_GATEWAY_ID": "brain-platform",          // §10.5: env.AI.run(..., {gateway:{id}})
    "SYNTHESIS_TOKEN_BUDGET": "20000",          // §4.3 guard; < 24k window
    "MONTHLY_COST_CEILING_USD": "400"           // §5f/§10.5 token_spend 429 cap; per-tenant-overridable
  },

  "routes": [
    { "pattern": "api.brain.example.com", "custom_domain": true }
  ]
}
```

#### Why AI Gateway is NOT a binding block
AI Gateway is **not** a `wrangler.jsonc` binding. It is invoked through the existing `env.AI` binding by passing a `gateway` option to each call (verified, Cloudflare docs 2026-06-25):

```ts
// packages/db/src/ai-gateway.ts — wrapper used by the embed()/gen() chokepoints (§4.2/§4.3)
const resp = await env.AI.run(env.GENERATION_MODEL, inputs, {
  gateway: {
    id: env.AI_GATEWAY_ID,
    // Per-tenant cost ATTRIBUTION/observability (§5f). For the all-@cf/ v1 model
    // set this metadata does NOT enforce a cap (gateway spend limits price only
    // Unified Billing / BYOK rails) — it enforces only once premium Unified-Billing
    // models are routed. The enforcing cap for @cf/ is the app-level token_spend
    // pre-check that runs BEFORE this env.AI.run call (§5.1).
    metadata: { tenant_id: principal.tenantId, surface: "think" }, // "migration" for re-embed (§6)
    skipCache: false,
  },
});
const logId = env.AI.aiGatewayLogId; // correlate a model call to its gateway log (§10.5)
```

**§5f — Enforcement boundary (the load-bearing correctness point).** As of the 2026-06 AI Gateway spend-limits docs, native `@cf/` neuron-billed Workers AI calls are covered by **neither** the Unified Billing **nor** the BYOK rails the spend-limit feature prices. The entire v1 model set is `@cf/`, so **AI Gateway spend limits cannot enforce the per-tenant cap for v1** — the **enforcing** cap is the app-level `token_spend` pre-check that returns `429` (with `Retry-After`) *before* `env.AI.run` (§5.1). That pre-check trips when a tenant's **projected monthly spend** would exceed **`MONTHLY_COST_CEILING_USD` (default 400, a `vars` env var, per-tenant-overridable; §10.1)**; at 1-2 tenants this is effectively the whole-platform budget. The gateway `metadata.tenant_id` is retained for cost attribution/observability now, and gateway spend limits become a *second* enforcement layer only once premium Unified-Billing models are routed (deferred). When both apply, the app-level `token_spend` accounting (the durable record) and the gateway's eventually-consistent spend view agree within the gateway's overshoot window. Separately, **Workers AI request-RATE limits** (req/min per model) are bounded at the `embed`/`gen`/`rerank` chokepoints and in the re-embed/backfill pacing, and degrade-or-queue rather than 429-ing the user (§5.1).

#### Plan, models & rate limits
**Platform plan: Cloudflare Workers PAID ($5/mo).** This is the deployment plan (not the free tier) — it unlocks Workflows, Queues, Durable Objects (SQLite), Analytics Engine, and the Neuron-billed Workers AI volume the platform's `embed`/`gen`/`rerank` chokepoints consume.

**Workers AI billing = Neurons.** The Paid plan includes **~10,000 Neurons/day**; beyond that, **~$0.011 per 1,000 Neurons** (the v1 billed unit recorded in `token_spend.neurons`, §10.5/§5f). At 1-2 tenants the daily included allotment is the dominant headroom; the `MONTHLY_COST_CEILING_USD=400` cap (above) is the whole-platform budget enforcer, not a per-large-fleet figure.

**Locked v1 model set (all `@cf/`, swappable behind the chokepoints, §4.3):** `@cf/baai/bge-m3` (embed, 1024-dim), `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (synthesis, 24k ctx), `@cf/baai/bge-reranker-base` (rerank).

**Per-model request-RATE limits — ASSUMED, conservative, LABELED.** Exact per-model req/min ceilings on Workers AI Paid are **not pinned here**; the chokepoints (§5.1) are configured against the following **assumed conservative** values, explicitly **unverified-until-staging** and **NON-BINDING at 1-2 tenants** (the assumed bounds exist so the pacing logic has a number to clamp against, not because the limit is expected to bind at dogfood scale):
  - embed (`bge-m3`): assume **~300 req/min** sustained.
  - synthesis (`llama-3.3-70b-...`): assume **~100 req/min** sustained (largest model → most conservative).
  - rerank (`bge-reranker-base`): assume **~300 req/min** sustained.

  These are clamp targets for the `embed`/`gen`/`rerank` pacing and the re-embed/backfill drain; a rate hit **degrades-or-queues**, it does not 429 the interactive user (§5.1). The staging reranker gate (§10.6) is the first place a real ceiling is observed; confirmed values are captured back here.

**Upgrade path (deferred, no v1 build):**
  - **AI Gateway** (already wired via the `gateway` option, §10.1) is the seam for **caching / retry / fallback** and per-tenant cost attribution; its spend-limit *enforcement* activates only once premium Unified-Billing models are routed (§5f).
  - **Bring-your-own / OpenAI-compatible models** later via the AI provider abstraction (`AI_PROVIDER=openai-compatible`, as in `cf-graph:apps/graph/src/api/services/factory.ts`) — the chokepoints (§4.3) are the swap point; no schema or routing change is needed to add an external provider behind them.

#### Service Bindings (internal hops, NET-NEW — replaces the shared secret)
Per §5d the platform has **no internal HTTP secret**. Internal Worker↔Worker hops use Service Bindings; Worker↔Workflow and Worker↔Queue use the native Workflow/Queue bindings already declared above. If the dashboard (`apps/dashboard`) is deployed as a *separate* Worker that calls the API, the dashboard's `wrangler.jsonc` carries:

```jsonc
"services": [ { "binding": "API", "service": "brain-platform", "entrypoint": "DashboardRpc" } ]
```

Internal handlers still **construct a `Principal` from the explicit `tenant_id` in the call params and go through `Scoped*`** (§5d) — the binding removes the network attack surface; it does not bypass isolation. Contrast with `openbrains:apps/mcp/src/index.ts` and `gbrain-cf:src/auth.ts`, both of which gate internal routes on `X-OpenBrains-Internal-Secret` / a static bearer — that pattern is **explicitly rejected** here.

---

### 10.2 Environments

**Environments ≠ tenants.** Each Wrangler environment (`dev`, `staging`, `production`) is a *full, independent stack*: its own D1 database, its own `brain-chunks` Vectorize index, its own Queues+DLQs, its own R2 bucket, its own AI Gateway id, its own KV. **Tenants are partitioned *within* one environment** by `tenant_id` (§5) — never by environment. This mirrors the `env.production` block already present in `cf-graph:apps/graph/wrangler.jsonc`, generalized to three named environments via the `env` key:

```jsonc
"env": {
  "staging":    { "name": "brain-platform-staging",    "d1_databases": [...], "vectorize": [{ "binding": "CHUNKS_INDEX", "index_name": "brain-chunks-staging" }, { "binding": "ENTITY_INDEX", "index_name": "brain-entities-staging" }], "queues": {...}, "vars": { "AI_GATEWAY_ID": "brain-platform-staging" }, "routes": [{ "pattern": "api.staging.brain.example.com", "custom_domain": true }] },
  "production": { "name": "brain-platform",             "d1_databases": [...], "vectorize": [{ "binding": "CHUNKS_INDEX", "index_name": "brain-chunks" }, { "binding": "ENTITY_INDEX", "index_name": "brain-entities" }],         "queues": {...}, "vars": { "AI_GATEWAY_ID": "brain-platform" },         "routes": [{ "pattern": "api.brain.example.com",        "custom_domain": true }] }
}
```

`dev` is the top-level (default) config and points at locally-created resources / a dev D1; `wrangler dev` runs the full stack in `workerd` locally with miniflare-backed D1, R2, KV, Queues, and a Vectorize stub. Service Bindings between Workers in a non-default environment must append the env suffix (`"service": "brain-platform-staging"`), per Cloudflare docs.

---

### 10.3 Secrets

Set with `wrangler secret put <NAME>` (and `--env staging|production`). **There is no internal shared secret** (§5d) — this is the single most important contrast with the mined repos. **Auth/IdP is CONFIRMED Clerk** (OAuth 2.1 upstream IdP; matches `gbrain-cf` + `openbrains`) — the `CLERK_*` secrets below are the full set the OAuth consent flow and `resolvePrincipal()` JWKS verify need; there is no "IdP TBD" choice left open.

| Secret | Purpose | Origin |
|---|---|---|
| `CLERK_CLIENT_ID`, `CLERK_CLIENT_SECRET` | OAuth app (MCP consent → callback) | `gbrain-cf:wrangler.jsonc` secret list |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Clerk session/JWT validation; `resolvePrincipal()` JWKS verify (`openbrains:apps/mcp/src/auth/clerk.ts`) | mined |
| `CLERK_FRONTEND_API` | Clerk frontend origin | `gbrain-cf:wrangler.jsonc` |
| `COOKIE_ENCRYPTION_KEY` | OAuth consent-cookie HMAC (`openssl rand -hex 32`) | `gbrain-cf:wrangler.jsonc` |
| `MACHINE_TOKEN_HMAC_KEY` | HMAC-SHA256 signing of `bdev_` machine tokens + `bk_` API keys (canonical platform prefixes; openbrains' source uses `obdev_`) | `openbrains:apps/mcp/src/auth/device-token.ts`, `cf-graph:apps/graph/src/api/services/cli-tokens.ts` |
| `GITHUB_TOKEN` | GitHub source-sync importer | `gbrain-cf:src/github.ts` |
| `GMAIL_OAUTH_*` | Gmail importer OAuth | `openbrains:packages/ingest/src/sources/gmail.ts` |
| `ADMIN_EMAILS`, `ADMIN_TOKEN` (optional) | Admin allowlist / break-glass token minting | `gbrain-cf:wrangler.jsonc` |

**Explicitly NOT present:** `X-Brain-Internal-Secret` / `INTERNAL_API_SECRET`. Internal hops use bindings (§10.1). The §5d future-exception — a per-target external HTTP secret — would use **Secrets Store** (`secrets_store_secrets` binding), per-target, rotated on a schedule; not needed for v1.

API keys are **not** secrets-store items: they are minted per tenant, SHA-256-hashed, and stored in the D1 `api_keys` table (`cf-graph:apps/graph/src/api/services/api-keys.ts`, `openbrains:packages/convex/convex/apiKeys.ts`), each bound to exactly one `tenant_id` (§3).

---

### 10.4 Migrations & cron triggers

There are **three distinct kinds of "migration"** plus a Vectorize provisioning step. Conflating them is a common error; they are called out separately.

#### (1) D1 schema migrations
Drizzle-generated SQL under `packages/db/migrations/`, applied with `wrangler d1 migrations apply brain-platform [--env <env>]`. Directory wired via `d1_databases[].migrations_dir` (`cf-graph:apps/graph/wrangler.jsonc`). The migration files realize §3's schema; ordering mirrors the mined layouts (`gbrain-cf:migrations/0001_init.sql..0009_sync.sql`, `cf-graph:apps/graph/migrations/0000..0010`). Every isolatable table carries `tenant_id NOT NULL`; FTS5 external-content tables (`chunks_fts`, `entity_fts`, `facts_fts`) use the **trigger-synced** pattern from `gbrain-cf:migrations/0001_init.sql` (NOT cf-graph's manually-populated `0009_add_fts_indexes.sql`). **Reversibility:** each migration ships a tested down-path or an explicit "irreversible" note; additive column/table migrations are the default (drop-free), so a bad deploy rolls back by redeploying the prior Worker without a schema rollback.

#### (2) Durable Object class migrations
The `wrangler.jsonc` `migrations[]` array (`{ tag, new_sqlite_classes: ["BrainMCP"] }`). This is SQLite-DO storage versioning for the MCP server instance only, identical in form to `cf-graph:apps/graph/wrangler.jsonc`. Bumped only when the `BrainMCP` class's persisted shape changes.

#### (3) The data / embedding migration (qwen3 / 1536d → bge-m3 1024d)
A **budgeted, resumable, dry-run-first job**, not a schema change (§6 re-embed model). Any row where `embedding_model != @cf/baai/bge-m3` OR `embedded_at IS NULL` OR `updated_at > embedded_at` is enqueued onto `brain-reembed`. Cost is estimated *before* kickoff (`N chunks × T tokens × bge-m3 $/Mtok`) and recorded in the migration's `backfill_runs` row; traffic is tagged `metadata.surface="migration"` so a runaway re-embed cannot exhaust a tenant's interactive budget (§5f, §6). Skeleton loop from `gbrain-cf:src/jobs.ts` (`runEmbedJob`, `SELECT … WHERE embedded_at IS NULL`); per-row contract from `openbrains:packages/convex/convex/thoughtsAction.ts` (`reembedInternal`). **Same-dimension is not interchangeability** — openbrains qwen3 vectors and any OB1/OpenAI 1536d vectors are re-embedded, never copied (§1).

#### Vectorize provisioning + metadata indexes (deploy-ordering constraint, not a file)
**Metadata indexes must exist before the first filtered upsert** — this is a Phase-0 ordering rule, not a migration file. Commands (pattern from `openbrains:packages/services/src/deps/vectorize.ts` doc comment, which shows `wrangler vectorize create-metadata-index thoughts-v1 --property-name=scope --type=string`):

```bash
wrangler vectorize create brain-chunks --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index brain-chunks --property-name=team_id        --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=scope          --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=visibility     --type=string
wrangler vectorize create-metadata-index brain-chunks --property-name=embedding_model --type=string  # lets the re-embed sweep query "all old-model vectors"

wrangler vectorize create brain-entities --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index brain-entities --property-name=scope           --type=string
wrangler vectorize create-metadata-index brain-entities --property-name=team_id         --type=string
wrangler vectorize create-metadata-index brain-entities --property-name=visibility      --type=string
wrangler vectorize create-metadata-index brain-entities --property-name=embedding_model --type=string  # mirrors §3.2; lets the re-embed sweep query "all old-model entity vectors"
```
(`namespace=tenantId` is enforced in code by `ScopedVectorize`, §5b — it is not a metadata index.)

#### Cron triggers
Single `*/5 * * * *` cron (§10.1). The `scheduled()` handler — modeled on `gbrain-cf:src/server.ts` (which re-exports `scheduled` from `src/index.ts`) and `gbrain-cf:src/jobs.ts` (`runQueuedJobs`) — fans out to three maintenance tasks, each **tenant-agnostic in dispatch but tenant-scoped in work** (every enqueued message carries `tenant_id`):

1. **Stale-source re-enqueue** — re-trigger Enumerator Workflows for sources past their backoff window. Direct port of `gbrain-cf:src/sync.ts` `enqueueStaleSyncs` (exponential backoff `BACKOFF_BASE_MS * 2**fail_count` capped at `BACKOFF_MAX_MS`, gated on `last_attempt_at` + `sync_fail_count` from `gbrain-cf:migrations/0009_sync.sql`).
2. **Re-embed sweep** — enqueue stale/`pending`/wrong-model rows onto `brain-reembed`, rate-paced (§6 throughput model).
3. **Idle-session promotion** — find `sessions` with `status='open' AND last_activity_at < now()-IDLE` and trigger `SessionPromoteWorkflow`, so a missed client Stop-hook never loses a transcript (§8.3 reliability). The sweep keys on `last_activity_at` (refreshed on every `capture_turn`), **not** `ended_at` — a missed Stop-hook leaves `ended_at` NULL, so an `ended_at`-keyed predicate could never recover it (iter-3 SC6 fix; query matches §8.3 verbatim).

The cron handler keeps `gbrain-cf:src/jobs.ts`'s **optimistic conditional claim** (`UPDATE … WHERE status=? AND updated_at=?`, `meta.changes` check) and `STALE_RUNNING_MS` reclaim for the **enumerator-run row only** — the Queue owns message-level dispatch, so the D1-jobs runner is reduced to enumerator scheduling, not the whole async substrate.

---

### 10.5 Observability — four tiers, each answering a different question

None of the mined repos use Analytics Engine or AI Gateway observability; tiers 2 and 4 are **NET-NEW**.

| Tier | Mechanism | Question it answers | Retention | Tenant scoping |
|---|---|---|---|---|
| **1. Workers Logs** | `observability.enabled` + `wrangler tail` | "What just crashed / what's this request doing right now?" | platform default (~days) | log fields include `tenant_id` (never log bodies/PII) |
| **2. Analytics Engine** | `OPS_METRICS.writeDataPoint(...)` | "What's per-tenant op latency / volume / error-rate over weeks?" | ~3 months, aggregate/sampled | `tenant_id` as an **indexed blob** |
| **3. D1 audit tables** | `mcp_request_log`, `memory_audit`, `memory_recall_traces`, `ingest_log`, `token_spend`, `backfill_runs.stats` | "Exactly what happened, queryable, exact, per-tenant?" | until pruned | `tenant_id` column on every row |
| **4. AI Gateway** | `metadata.tenant_id` on every `env.AI.run`, `env.AI.aiGatewayLogId` | "Per-tenant model cost, latency, cache-hit (**attribution** — the enforcing @cf/ cap is the app-level `token_spend` 429, §5f), and per-model request-RATE headroom (§5.1)?" | gateway retention | `tenant_id` custom metadata |

#### Tier 2 — Analytics Engine write shape (NET-NEW)
One data point per significant op (search, think, ingest, traverse). `blobs` are dimensions; `doubles` are measures; `indexes[0]` is the sampling/index key:

```ts
// packages/db/src/ops-metrics.ts
env.OPS_METRICS.writeDataPoint({
  indexes: [principal.tenantId],                         // sampling key → keeps per-tenant cardinality bounded
  blobs:   [op, principal.tenantId, status, surface],    // e.g. ["think", "<tid>", "ok", "mcp"]
  doubles: [latencyMs, candidateCount, evidenceCount],   // measures for dashboards
});
```
Queried via the Analytics Engine SQL API to power the §7-Phase-5 dashboard panels (per-tenant latency, error rate, retrieval recall depth) and the §0 **scale-trigger alerts** (D1 size, Vectorize vector count, namespace count vs the 6 GB / 7 M / 50k thresholds). These thresholds are **Phase-N scale-out triggers** and are **NON-BINDING at the v1 scale of 1-2 tenants** — the panels track headroom for forward-compat, but no split fires at dogfood volume.

#### Tier 3 — `mcp_request_log`, made multi-tenant
Reuse `gbrain-cf:src/log.ts` `logMcpRequest` + `gbrain-cf:migrations/0005_platform.sql` `mcp_request_log` schema, with two changes: **add `tenant_id`** (gbrain's is single-tenant) and keep the **`waitUntil` / never-throw** contract verbatim (a failed log write must never affect the response):

```sql
CREATE TABLE mcp_request_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL,           -- NET-NEW vs gbrain
  token_name    TEXT,
  operation     TEXT NOT NULL,
  latency_ms    INTEGER,
  status        TEXT NOT NULL DEFAULT 'ok',   -- 'ok'|'error'
  error_message TEXT,                     -- message only; never params/PII (gbrain README rule)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_mcp_log_tenant_created ON mcp_request_log(tenant_id, created_at);
CREATE INDEX idx_mcp_log_operation     ON mcp_request_log(operation);
```
The governance audit tables (`memory_audit` written *in the same `db.batch([...])` as the mutation*, `memory_recall_traces` one row per kept hit) are ported from `openbrains:packages/convex/convex/_lib/audit.ts` and `openbrains:packages/convex/convex/memory/recall.ts`, each gaining `tenant_id` (§5).

---

### 10.6 Test strategy

#### Harness: `@cloudflare/vitest-pool-workers` (NET-NEW — the mined harness does not transfer)
openbrains' tests are `bun:test` + `convex-test` with `withIdentity()` (e.g. `openbrains:packages/convex/tests/tenancy.test.ts`). That harness is Convex-specific and **does not port**. The CF-native answer is **Vitest running in `workerd`** via `@cloudflare/vitest-pool-workers`, with **real bindings**: a miniflare-backed D1 seeded by `applyD1Migrations(env.DB, migrations)`, a real R2, real KV, and the actual `ScopedDB`/`ScopedVectorize`/`ScopedR2` modules. This is load-bearing: only a real D1 with the migrations applied can *prove* that `ScopedDB` injects `AND tenant_id = ?` — a mocked DB would let a missing predicate pass. (Vectorize has no local emulator; the vector arm is exercised with a thin in-test fake that records the `namespace` argument, asserting `ScopedVectorize` hard-wires it — the same property `openbrains:packages/services/tests/search-thoughts.test.ts` checks.)

Pyramid:
- **Unit (Node/Vitest, no bindings):** pure logic lifted from mined repos already has tests to mirror — `rrfFusion` / `applyTitleBoost` (`gbrain-cf:src/search.ts`), `sanitizeFtsQuery` (`cf-graph:apps/graph/src/api/search/fts.ts`), `contentFingerprint`/`normalizeForFingerprint` (`openbrains:packages/ingest/src/fingerprint.ts`, `normalize.ts` — see `openbrains:packages/ingest/tests/fingerprint.test.ts`), `chunkText` (`gbrain-cf:src/util.ts`), the synthesis token-budget guard (§4.3, evicts highest-score-last, never truncates mid-doc), and `runImporterContract` invariants (`openbrains:packages/ingest/src/sources/contract.ts`).
- **Integration (workerd):** ingest a PDF → assert body in R2 + only `r2_key`+preview in D1; re-ingest unchanged → `skipped`; Queue duplicate-delivery → no double-ingest (deterministic `ingest-${tenantId}-${fingerprint}` id); kill an Enumerator mid-run → resumes from `backfill_runs.cursor`.
- **Isolation (workerd, BLOCKING in CI):** the canary suite below.

#### The isolation canary (concept ported from `openbrains:packages/convex/tests/tenancy.test.ts`, generalized)
`tenancy.test.ts` asserts, for *every exposed public function*, that (a) no identity → error and (b) user B reading user A's data → `NOT_FOUND`/null. Generalize the **table-driven canary** from "every public Convex fn" to **"every MCP tool + every REST route + every `Scoped*` method"**: a single case table; adding a surface without adding a row fails a meta-test. Cross-tenant access must return **empty, not error** (no existence leak — the drop-don't-error rule from `openbrains:packages/convex/convex/memory/recall.ts`, whose test `openbrains:packages/convex/tests/memory/recall.test.ts` asserts `result.items` is `[]` for a cross-tenant id).

§5i requires these as **named, first-class, blocking** gates — each "green = merge precondition":

1. **`ScopedDB` predicate-injection** — seed tenant A; query as tenant B; assert empty. Also assert the raw SQL emitted contains `tenant_id = ?` (no unscoped path).
2. **FTS-arm JOIN-recheck leak test** (§5g) — tenant A and tenant B both have a chunk matching the same term; an FTS `MATCH` as tenant B must JOIN back through `ScopedDB` and return *only* B's row. A `MATCH`-then-unscoped-read is the forbidden leak path; this test specifically guards it.
3. **Vectorize D1-recheck drop test** (§5c) — inject a vector id belonging to tenant A into tenant B's result set (simulating metadata lag); assert the D1 re-JOIN drops it silently.
4. **BFS cross-tenant-hop test** (§5, §4.4) — tenant A and tenant B share a slug; `traverse_graph` depth-3 as tenant A must never walk into B's nodes. Every frontier `IN (...)` query carries `tenant_id = ?` (the easiest predicate to forget).
5. **`ScopedR2` prefix test** — every key written/read is prefixed `${tenantId}/`; a read with B's principal cannot resolve A's key.
6. **ESLint banned-binding rule** (§5i) — raw `env.DB.prepare` / raw Vectorize / raw R2 bindings are importable *only* inside `packages/db`; any reference elsewhere fails lint. This is a static gate run in the same blocking CI job.
7. **Cross-scope (intra-tenant) isolation test** (§7.3, iter-2) — within ONE tenant, seed client A's scope and client B's scope; a principal whose `allowedScopes=['A']` must (a) get `403` when it names `scope='B'` explicitly, and (b) see only A's rows on an *unscoped* query — asserted across the FTS arm, the vector arm (via `hydrateChunks`'s scope gate), and `ScopedDB.listDocuments`. A principal with `allowedScopes='*'` sees both (the default; "staff move freely"). This guards the agency v1-default model (Persona C) and is a `required` merge check exactly like the cross-tenant tests; it is the test that makes SC1's cross-scope clause verifiable.
8. **Intra-tenant visibility — `private` tier, facts AND chunks** (§7.5, iter-3 CRITICAL) — within ONE tenant, user A writes a `private` fact **and** captures a `private` session (whose transcript chunks land in `brain-chunks`); assert a non-author, non-teammate user B **cannot** recall/search/`think`/`get_session_context` either the fact or the session chunk — via the vector arm, the FTS arm, AND the live `recall`/injection paths (drop-don't-error, no existence leak) — while the **author A can**. The "via ANY path" enumeration includes the **break-glass surface invoked WITHOUT the admin/owner role**: a non-admin user B that supplies `breakGlass:true` (or calls the `memory.break_glass_read` tool) is rejected `403` and reads no private content — break-glass fails closed, it does not fall through to the default predicate (the role-gated success case is canary #15). This covers the hybrid-search arm the finding explicitly named (a private session chunk must not be semantically retrievable cross-user), not just promoted facts. `required` merge check.
9. **Intra-tenant visibility — `team` tier** (§7.5, iter-3 CRITICAL) — user A writes a `team` fact/chunk for team T; assert a **member of T recalls it**, a **non-member of T in the same tenant does NOT**, and a `world` fact/chunk is recalled by any member of the tenant. The table-driven meta-test treats `visibility` as a third isolation axis spanning BOTH `ScopedDB.readFacts` (facts) and `hydrateChunks`/`getChunksByIds` (chunks), so a new facts/chunks read surface that does not route through a `visibilityPredicate` fails the meta-test.
10. **Recall-completeness under topK pressure** (§5.3, iter-3 cf HIGH) — seed a tenant where a restricted-`allowedScopes` principal's granted-scope docs all rank **below** the tenant-wide top-100 (saturate the namespace with higher-scoring out-of-grant rows); assert the principal **still recalls its own granted-scope docs** (because the granted scope is pushed into the Vectorize metadata filter — `foldPartitionFilter` — so the topK budget is spent inside the grant). This is the leak-canary's complement: #7 proves it can't read others' scope; #10 proves it can still read its OWN under pressure. `required` for any Persona-C (agency) tenant before GA.
11. **Write-isolation (body-supplied partition fields)** (§7.10, iter-3) — a restricted key calling `writeFact`/`capture_turn`/`POST /ingest` with a body `scope`/`team_id`/`user_id`/`visibility` outside its grant: assert out-of-grant `scope`→`403`, out-of-team `team_id`→`403`, `user_id` is forced to the principal's, and a `world` write by a non-admin is rejected/down-graded. Guards the write-side analogue of the read gates.
12. **Audit/recall-trace read-auth** (§7.6, iter-3) — a tenant member cannot read another member's `memory_recall_traces`; a non-admin cannot read `memory_audit`. Guards the second-order intra-tenant privacy leak.
13. **Graph-arm cross-scope (intra-tenant) isolation test** (§6.8, §7.3, iter-3 CRITICAL) — the graph-arm mirror of #7. Within ONE tenant, seed a slug/page shared across client A's scope and client B's scope (and, on the entity arm, an entity in a non-granted `scope`); a restricted-`allowedScopes=['A']` principal that calls `traverse_graph`/`get_links`/`get_backlinks` from the shared slug must **not** return another client's-scope pages or entities — the typed scope-gated frontier methods (`expandFrontier`/`getLinks`) and the scoped seed/anchor resolution (`resolveScopedNode`/`nodeVisible`, §7.3) stop the hop, and a direct `traverse_graph(slug_of_gated_node)` returns empty (drop-don't-error, no existence leak). Asserts the graph arm carries the same scope (and, once a node carries `visibility`, the same visibility) gate as the FTS/vector/`listDocuments` arms. `required` merge check.
14. **Break-glass fails CLOSED for non-admins** (§7.6, break-glass) — within ONE tenant, user A authors a `private` fact **and** a `private` session chunk; a **non-admin** principal (a `member`/`readonly` user B, AND a restricted Persona-C key) invokes the break-glass surface — both the admin-only tool `memory.break_glass_read` and a default read entry point with `breakGlass:true` — and is **rejected `403`** in every case, returning **no private content** (it does **not** silently fall through to the normal `visibilityPredicate` path). This is the write-side analogue of #8's "via ANY path" clause for the break-glass route specifically: the explicit signal is gated on the org-scoped admin/owner role and fails closed. `required` merge check.
15. **Admin break-glass returns private content AND writes the audit+alert row** (§7.6, break-glass) — within ONE tenant, user A authors a `private` fact and a `private` session chunk that an `owner`/`admin` user B does **not** see on any default path (re-assert the default-path exclusion, then) invoke `ScopedDB.breakGlassReadPrivate` (via the admin-only tool / `breakGlass:true`) as B: assert it **does** return A's `private` fact **and** A's `private` chunk (both arms), AND that the call wrote exactly one `memory_audit` row with `action='breakglass_read'`, actor=B's `user_id`, and a `diff` carrying the **target principal** (A's `user_id`) and the `query`/`target_id`, AND that it emitted a `breakglass_read` alert to the alert sink (asserted via an in-test alert fake that records emissions, mirroring the `namespace`-recording vector fake). A break-glass read that returns private content but produces **no** audit row, or **no** alert, **fails** the test — an unaudited or silent break-glass read is the precise thing this canary forbids. `required` merge check.

**Reranker output-shape gate (BLOCKING, iter-3 cf MEDIUM).** Beyond the isolation canaries, a **staging integration test against the real `@cf/baai/bge-reranker-base`** that locks the actual output field names and the index→chunk remap is a **hard, named, blocking CI/deploy gate** (not merely "a staging test") — because a silently-wrong remap attributes the **wrong chunk to a citation**, a correctness bug, not just degraded ranking. Until this gate is green for a given Workers AI version, the rerank stage degrades to RRF order in production (the defensive parse in §5.4 makes that safe). When the gate locks the shape, the confirmed shape is captured back into §5.4.

#### CI gating
A single GitHub Actions pipeline runs lint (incl. banned-binding) → typecheck → unit → workerd integration+isolation. **A green pipeline is a precondition for merge** (§5i). The isolation canary (canaries #1–#15), the reranker output-shape gate, and the ESLint rule are `required` checks; a new surface that bypasses `Scoped*` cannot merge.

---

### 10.7 Phased rollout — operational overlay on §7

§7 already defines Phases 0–5 with feature scope and verify criteria; this section **does not restate them** — it adds the deployment/ops dimension and ties milestones to the §0 scale triggers.

#### Deploy-order runbook (order matters — applies to every environment)
1. `wrangler d1 create brain-platform` → `wrangler d1 migrations apply` (schema must exist before the Worker reads it).
2. `wrangler vectorize create brain-chunks --dimensions=1024 --metric=cosine` **and** `wrangler vectorize create brain-entities --dimensions=1024 --metric=cosine` (both indexes are v1, §10.4).
3. **`create-metadata-index` — for `brain-chunks` (`team_id`/`scope`/`visibility`/`embedding_model`) and for `brain-entities` (`scope`/`team_id`/`visibility`/`embedding_model`) — BEFORE any filtered upsert** (§10.4).
4. `wrangler queues create brain-backfill` / `brain-backfill-dlq` / `brain-reembed` / `brain-reembed-dlq`.
5. `wrangler kv namespace create OAUTH_KV`; `wrangler secret put …` (§10.3).
6. `wrangler deploy [--env <env>]` (DO class migration `v1` and Workflow classes register on deploy).

#### Environment promotion
`dev` (local `wrangler dev`, full workerd stack) → `staging` (full independent stack, isolation canary must be green) → `production`. Promotion is `wrangler deploy --env production` of an already-staged, CI-green build.

#### Milestones (each milestone = a §7 phase reaching its verify criteria in **production**)
- **M0 (Phase 0):** tenancy + isolation live; isolation canary blocking in CI; an internal hop reaches a service over a binding and still builds a Principal. *Gate: no P0 leak possible by construction.*
- **M1 (Phase 1):** ingest + hybrid search; both vector and FTS arms tenant-checked. *Alert wired:* D1 size + Vectorize vector-count panels begin tracking against §0 triggers.
- **M2 (Phase 2):** backfill spine; **the re-embed migration runs here as its own gated step**: dry-run first (report estimated vectors + dollar cost from `chunks` counts, §6), operator approves, then a rate-limited drain under the `migration` spend tag. Resumable; observable via `backfill_runs.stats`.
- **M3 (Phase 3):** graph + think; BFS-isolation + oversized-evidence-eviction tests green in CI.
- **M4 (Phase 4):** sessions + governance; transcript-in-R2 invariant asserted in prod smoke test.
- **M5 (Phase 5):** surfaces; per-tenant spend cap enforced by the **app-level `token_spend` pre-check → 429 before `env.AI.run`** when projected monthly spend exceeds **`MONTHLY_COST_CEILING_USD` (default 400, per-tenant-overridable, §10.1)** (the enforcing cap for the all-`@cf/` v1 set; AI Gateway spend limits are attribution-only here, §5f); a Workers-AI request-RATE limit degrades/queues rather than 429-ing the user (§5.1); D1/Vectorize headroom dashboards show margin against §0 triggers.

#### Production alerts tied to §0 scale triggers (Phase-N — NON-BINDING at 1-2 tenants)
These are **documented Phase-N scale-out TRIGGERS, not v1 alerts that fire at dogfood scale** — at 1-2 tenants none of the thresholds below are reachable, so the §5e split is forward-compat machinery, not v1 build work. When (later) the fleet grows: from Tier-2 metrics + scheduled D1/Vectorize size queries: **D1 ≥ 6 GB** (or any tenant over its row budget — recall that the dominant D1 consumers are `chunks.content` + the FTS index + `memory_audit`/`memory_recall_traces`, not the R2-offloaded bodies, so the trigger watches those terms) → begin the `tenant_shards` D1 split (§5e); **Vectorize ≥ 7 M vectors (the headroom alert, fired well before the 10 M-vectors-per-index HARD cap — the binding §0 ceiling, shared across all tenant namespaces) or ≥ 50k namespaces in an index** → allocate `brain-chunks-{shard}` and repoint `tenant_shards.chunk_index` (§5e). Because `ScopedDB`/`ScopedVectorize` resolve the binding/index per request, the (future) alert response is a data/routing change, not a code rewrite.

#### D1 WRITE-THROUGHPUT budget (a SECOND Phase-N scale axis, distinct from the 6 GB byte budget — iter-3 cf-correctness HIGH)
D1 is a **single-writer** SQLite database: all writes to one shard serialize. The "low hundreds of active tenants on one D1" figure (§0) is a **byte** estimate and may be **write-contention-bound long before 6 GB**, because reads generate writes on the hot path — every governed write batches a `memory_audit` row, and historically every kept recall hit wrote a `memory_recall_traces` row **synchronously**. **At the v1 scale of 1-2 tenants the single-writer ceiling is NON-BINDING** — the write-QPS trigger below is a **documented Phase-N scale-out trigger**, NOT v1 build work, and no shard-split fires at dogfood volume. Two points, both forward-compat:

1. **Recall traces are decoupled from the synchronous read path (a v1 design choice, cheap and kept).** A trace need not be atomic with anything (unlike audit rows, which MUST share the change's `db.batch` for atomicity). So recall-trace writes are emitted via **`ctx.waitUntil`** and **batched out-of-band** — buffered and flushed to a **separate trace store** (a dedicated traces D1/shard, or Analytics Engine for the aggregate view) off the request's critical path — so a `recall`/`think`/hybrid read never blocks on a single-writer trace write. Audit rows stay in-batch (atomicity is non-negotiable) but are bounded by **write** volume, not read volume.
2. **A write-QPS budget and trigger sit alongside the byte budget — as a Phase-N trigger.** Tier-2 emits a per-shard **writes/sec** measure (audit-row writes + ingest/promote batches + any in-band traces); the **Phase-N** shard-split trigger fires on **EITHER** D1 ≥ 6 GB **OR** sustained write-QPS approaching the single-writer ceiling — whichever comes first. The concrete write-QPS threshold is observed against the single-writer ceiling at scale-up time (it does not need pre-tuning at 1-2 tenants, where it never approaches). The §5e `tenant_shards` split is the (future) response to both (it partitions writers, not just bytes). This makes the scale story write-throughput-aware, not byte-only — without adding any v1 sharding logic.

#### Rollback per primitive
- **Worker:** redeploy the prior version (`wrangler rollback` / prior tag) — instant.
- **D1 schema:** additive-by-default → roll back by redeploying the prior Worker; destructive migrations ship a tested down-script (§10.4).
- **Workflows:** rely on per-phase retries; a bad workflow build is rolled back with the Worker (instances resume against the new code at their last completed `step.do`).
- **Vectorize model change:** dual-write to a new index + flip reads + drop old (§4.2 eventual-consistency posture), never an in-place mutation.

#### Gradual per-tenant onboarding (a lever multi-tenancy gives for free)
New tenants are provisioned by inserting an `orgs` + `tenant_shards` row (v1 points every tenant at the shared DB + base index, §5e). Rollout of a new capability or model can be **gated per tenant** via a `vars`-driven or `orgs.flags` allowlist, so a risky change (e.g. Phase 3.5 semantic fact dedup) ships to one design-partner tenant before fleet-wide enable — no separate deploy, no environment fork.

#### Code references

- cf-graph:/home/roboto/devel/cf-graph/apps/graph/wrangler.jsonc — Baseline binding shape: D1 DB, two Vectorize index bindings, R2 FILES, ai.binding=AI, workflows[] declarations, DO MCP_OBJECT + migrations[].new_sqlite_classes, OAUTH_KV, and the env.production block as the template for the multi-environment env{} key.
- gbrain-cf:/home/roboto/devel/gbrain-cf/wrangler.jsonc — observability.enabled, triggers.crons cron declaration, custom-domain routes[], and the documented secret list (Clerk keys, COOKIE_ENCRYPTION_KEY, ADMIN_EMAILS/TOKEN) — minus the single-tenant assumptions.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/log.ts — logMcpRequest: waitUntil/never-throw best-effort MCP request logging contract; reused verbatim, adding tenant_id.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0005_platform.sql — mcp_request_log table DDL (operation/latency_ms/status/error_message/created_at + indexes); generalized with a tenant_id column and tenant-scoped index.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/jobs.ts — Cron job runner: optimistic conditional claim (UPDATE WHERE status=? AND updated_at=?, meta.changes check), STALE_RUNNING_MS reclaim, RUNNABLE_JOB_TYPES dispatch, runEmbedJob re-embed sweep skeleton. Reduced to enumerator scheduling once Queues own message dispatch.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/server.ts — scheduled() handler wiring (re-exports scheduled from index.ts) as the template for the cron fan-out to maintenance tasks.
- gbrain-cf:/home/roboto/devel/gbrain-cf/src/sync.ts — enqueueStaleSyncs: exponential backoff (BACKOFF_BASE_MS*2**fail_count capped at BACKOFF_MAX_MS) gated on last_attempt_at + sync_fail_count — the stale-source re-enqueue cron task.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0009_sync.sql — Per-source backoff state columns (last_attempt_at, sync_fail_count) feeding the stale re-enqueue cron.
- gbrain-cf:/home/roboto/devel/gbrain-cf/migrations/0001_init.sql — FTS5 external-content + trigger-synced pattern (chunks_fts) — the correct auto-synced FTS approach the platform adopts over cf-graph's manually-populated table.
- openbrains:/home/roboto/devel/openbrains/packages/convex/tests/tenancy.test.ts — The table-driven isolation canary CONCEPT (every public surface: no-identity→error, cross-tenant→NOT_FOUND/null; add a row per new surface). Generalized from Convex fns to MCP tools + REST routes + Scoped* methods. Harness itself (bun:test/convex-test/withIdentity) does NOT port.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/memory/recall.ts — Drop-don't-error cross-tenant rule (return empty, no existence leak) — the assertion behind the Vectorize/FTS recheck isolation tests.
- openbrains:/home/roboto/devel/openbrains/packages/convex/tests/memory/recall.test.ts — Concrete cross-tenant-drop assertion (result.items === []) — the shape the workerd isolation canary reproduces.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/_lib/audit.ts — writeAudit append-only audit row written inside the same transaction/batch as the mutation — ported to D1 db.batch with tenant_id.
- openbrains:/home/roboto/devel/openbrains/packages/services/src/deps/vectorize.ts — namespace-enforcement client (ScopedVectorize) and the documented create-metadata-index command pattern (wrangler vectorize create-metadata-index <index> --property-name=<p> --type=string).
- openbrains:/home/roboto/devel/openbrains/packages/ingest/tests/fingerprint.test.ts — Existing unit test for contentFingerprint/normalizeForFingerprint — mirrored as platform-neutral unit tests.
- openbrains:/home/roboto/devel/openbrains/packages/convex/convex/thoughtsAction.ts — reembedInternal per-row re-embed contract (recompute → upsert same id → stamp embeddingModel/dims) — the per-row body of the (3) embedding-data migration.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/cli-tokens.ts — HMAC-SHA256 CLI token signing — backs the MACHINE_TOKEN_HMAC_KEY secret.
- cf-graph:/home/roboto/devel/cf-graph/apps/graph/src/api/services/api-keys.ts — API key generate/validate (SHA-256 hash stored in D1, tenant-bound) — confirms API keys live in the api_keys D1 table, not Secrets Store.

---

## Appendix: Open Questions & Residual Issues

These are the unresolved design questions carried from each section, plus document-assembly notes. Each is prefixed with its owning section.

### §1 — Vision, Goals, Personas & Scope
- **Agency "client" isolation grade (Persona C):** does a client map to a soft `scope` within one org (v1 default, shared tenant, staff move freely) or to a separate `org`/tenant for hard isolation (compliance/data-residency)? This materially changes the persona definition and which §5e sharding path applies. **Resolved-for-v1:** soft `scope` is the default, now with an *enforced* per-member `allowedScopes` grant (default `'*'` so staff move freely; a restricted grant confines a member, enforced at the D1 gate with 403-on-explicit-out-of-grant — §1.4/§7.3, tested by SC1 canary #7). The D1-per-tenant hard-isolation path (§5e) remains the offer for enterprise clients that need compliance-grade separation. The remaining open part is purely the *capability-per-scope* axis (deferred — see Role granularity below).
- **Injection at session start (Pillar 2):** what exactly is auto-injected in v1 — only `instruction`-grade memory, or also a bounded set of high-notability `evidence` facts? Needs a token budget and a selection rule before Phase 4.
- **Role granularity:** is the four-value role enum (owner|admin|member|readonly) sufficient, or do agencies need per-scope *roles* (e.g. member on client X, readonly on client Y)? **Resolved-for-v1 (data-partition axis):** per-member *scope visibility* is now enforced via `memberships.allowed_scopes` (NULL='*'=all, the default that honors "staff move freely"; a restricted list confines the member, enforced at the D1 gate + 403 on explicit out-of-grant scope — §7.3, SC1 canary #7). **Still deferred (capability axis):** a *different capability* (read vs write) per scope is not modeled in v1 — `capabilities` is tenant-wide. If an agency needs "write on X, read-only on Y," that is a richer `(membership, scope, capability)` grant table, deferred past v1.
- **Solo-user onboarding:** is an org auto-provisioned on first login (org == user), or must every user explicitly create/join an org? Affects the Persona A signup flow and the memberships bootstrap.
- **v1 tenant ceiling acceptance — RESOLVED:** v1 is **1-2 tenants only** (internal dogfood for the owner's new service company). The multi-tenant **isolation** model stays fully intact, but the horizontal **scale-out** machinery is **deferred to Phase-N**: v1 runs a **single D1 database** (no shard fan-out); the `tenant_shards` columns stay for forward-compat but resolve to one shard in v1; the Vectorize per-index ceilings (10M vectors / 50k namespaces) are **non-binding at 1-2 tenants**. D1 sharding + the shard-split-QPS threshold (§10.7) are a documented Phase-N scale-out **trigger**, not a v1 build — no sharding logic is added in v1. The **only** remaining TRUE-UNKNOWN is the exact vector/session counts (**measure during dogfood**); they are known to be SMALL.

### §2 — Layered Services Architecture
- **Session-turn R2 offload threshold:** the plan says "lean turns in D1, long turns offloaded to R2" but no byte cutoff is fixed. Need a concrete threshold (e.g. >4KB → R2 ref) so capture_turn behavior is deterministic. (Section 8 territory, but it shapes the L4 ScopedR2 call in the capture lifecycle.)
- **MCP Durable Object scoping granularity:** is there one DO instance per (tenant, slug) or per (tenant) with scope resolved per-tool-call? cf-graph is per-workspace-slug; with tenant+scope the slug→DO key mapping needs to be pinned to avoid cross-scope state bleed within a tenant.
- **resolvePrincipal membership-lookup cost:** it adds a D1 read on every request before any Scoped* handle exists. Confirm whether the membership row is cached (KV, per the openbrains session-scope-store pattern) or read fresh each request, since this is on the hot path of every lifecycle.

### §4 — Ingestion & Document Loading
- **Binary fingerprint timing:** the markdown fingerprint can only be computed after toMarkdown, so the document-level skip-unchanged gate for PDFs/DOCX runs INSIDE the Workflow (after extract), not at ingress. This means a re-uploaded-but-byte-different PDF that extracts to identical markdown still consumes the extract step before being marked 'duplicate'. Acceptable, or should we add a cheaper pre-extract raw-bytes hash check at ingress (specified as the two-phase approach in §4.2) as the default?
- **Embed-failure policy on the write path:** the spec throws inside the embed step (Workflow retries) rather than indexing un-embedded chunks with embed_error set. cf-graph throws on missing embedding; gbrain's chokepoint returns null. Confirm we want hard-retry (chunks never searchable until embedded) vs. index-now-with-embed_error-and-let-the-reembed-sweep-fix-it (chunks immediately FTS-searchable, vector arm catches up). The latter improves availability but means a chunk can be keyword-hit before it has a vector.
- **Per-document chunk ceiling:** total Workflow steps scale with chunk count (ceil(n/10)+ceil(n/50)+ceil(n/5)). A single huge document could approach the 10k soft / 25k hard step cap. Do we cap chunks-per-document (e.g. split a giant doc into multiple documents) or rely on bounded source sizes? §6 bounds items-per-run at the Enumerator but a single oversized upload bypasses that.
- **Workflow vs Queue-consumer split for KG extraction:** KG extraction is in-Workflow here (cf-graph pattern). Given the plan's Queue spine, should KG extraction instead be a separate brain-kg Queue so a slow/failing LLM doesn't hold the ingest Workflow's step budget? Currently kept in-Workflow for atomic 'indexed' status, but this is a coupling worth confirming.
- **Pre-chunked path R2 body:** for ingestChunked-style payloads with no original artifact, the spec concatenates chunks → R2 for the body. Confirm whether sessions/OB1 imports actually need a reconstructed body in R2 at all, or whether r2Key='' (cf-graph's choice) is acceptable for purely-derived content (saves an R2 write per imported item).

### §5 — Embedding, Hybrid Search, Rerank & Cited Synthesis
- **Reranker total-context budget:** bge-reranker-base has its own per-call token cap (sum of query + all contexts). With 40 candidates this can be large — should the candidate count entering rerank be dynamically reduced (e.g. by cumulative token estimate) rather than a fixed 40, or is a fixed cap + per-candidate truncation acceptable for v1?
- **Trust-grade boost values** (instruction 2.0 / evidence 1.0 / draft 0.6) are placeholders generalized from gbrain's COMPILED_TRUTH_BOOST=2.0 — these need empirical tuning against real ranking quality once data exists; should they be config-driven from day one?
- **memory_recall_traces growth AND write-throughput:** on every kept hit at think limit=12 plus query traffic, the table could grow quickly within the single-shared-D1 budget (§0) — and, because D1 is single-writer, a synchronous per-hit trace write also consumes the shard's **write throughput** on the read path. **Resolved-for-v1 (policy committed):** (a) *bytes* — a cron prunes `memory_recall_traces` older than N days (and may roll older traces up to per-(tenant, day) aggregates); the exact N is tuned once Phase-4 load is known, but the 6 GB shard trigger (§10.7) is defended on the assumption this prune is active; `memory_audit` is exported append-only to R2 before any prune so tamper-evidence survives (§7.6, SC7). (b) *write throughput (iter-3)* — trace writes are moved **off the synchronous read path** (`ctx.waitUntil`, batched to a separate trace store; Analytics Engine for the aggregate view), so a read never blocks on a single-writer trace write; audit rows stay in-batch (atomic) but are bounded by write volume. The §10.7 shard-split alert now fires on write-QPS as well as bytes.
- **Query-expansion gating:** query expansion currently runs an LLM call on the 'query'/'think' path even when the FTS+vector arms already return strong matches — should expansion be gated on a weak-result heuristic (e.g. only expand when top RRF score < threshold or candidate count < N) to save the extra LLM call/latency/spend?

### §6 — Graph Extraction & Traversal
- **doc_links endpoint node space — RESOLVED (iter-3 completeness fix):** `from_id`/`to_id` reference **`pages` only**; there is no unified pages+documents id space. A document participates in the link graph **only via its backing `pages` row** (gbrain's model — an ingested document IS a page), so the DOC_GRAPH BFS runs unambiguously with `nodeTable='pages'` and the JOIN target is single-namespace. Documents-as-first-class-graph-nodes is a deferred future phase (would add a `documents`-keyed edge table + a third BFS config). See the pinned node-space note in §6.0.
- **entity_mentions.source_kind enumeration:** plan lists chunk|document|session|page. Does an entity mention point at the chunk (fine-grained, enables evidence highlighting) or the document (coarser)? cf-graph uses source_chunk_ids on the entity; openbrains uses thoughtId. Recommend chunk-level mentions for evidence precision but confirm given D1 row-count budget.
- **Entity vector search — RESOLVED (decision): IN v1.** `search_entities` and the `brain-entities` Vectorize index (1024-dim cosine, `namespace=tenantId`) are **pulled into v1** (previously deferred to Phase 3.5). Entities are embedded (canonical name + description) on upsert with the same per-row staleness/embedding-model tracking as chunks; `search_entities` is a scoped vector search over `brain-entities` (tenant + node scope/visibility gate, D1 re-check on `entities`), optionally fused with `entity_fts`. See §3.2/§6.6/§6.7, surfaced in §9.2.2. **Cross-session semantic fact dedup REMAINS deferred to Phase 3.5** — v1 entity/fact dedup stays deterministic (key + alias union; supersede-by-session + exact-text, §8.3).
- **Phase 3.5 entity-vector *dedup* threshold (still deferred):** when **semantic dedup** lands (Phase 3.5 — distinct from the now-in-v1 vector *search* above), the cosine merge threshold (openbrains uses 0.85 for relatedThoughts) needs validation specifically for entity 'name: description' vectors, which cluster differently than free text. Flagged as a tuning task, not a v1 decision.

### §7 — Multi-Tenant Company Brain: Auth, Scoping, Trust & Audit
- **Machine-token tenancy:** machine-token claims bake in a single tenant_id. For a user who belongs to multiple tenants and uses one CLI/agent across all of them, do we mint one token per tenant, or carry tenantId as a per-request selector against an authenticated Clerk JWT? The plan implies tenant-baked tokens; confirm the multi-tenant CLI UX.
- **Requested-tenant resolution for the Clerk-JWT path:** resolvePrincipal needs to know the REQUESTED tenant (a JWT alone does not name a tenant). **Resolved-for-v1:** one pinned mechanism per surface — MCP = the signed `/mcp/<slug>` slug; REST = a validated `X-Brain-Tenant` header; dashboard = a server-side session pin (§7.2/§9.0.1 `requestedTenant`). When unspecified the resolver **errors (401), never a silent first-membership default**. Because the value is always re-checked against `memberships`, the choice is UX/ergonomics, not a trust boundary. (Caching the membership lookup in KV remains a §2 perf open question.)
- **Promotion role granularity:** the plan lists owner|admin|member|readonly. Promotion-to-instruction is gated to owner/admin here. Confirm whether 'member' should also be able to promote within their own scope, or whether promotion is strictly an admin governance action.
- **Audit append-only enforcement:** app code never UPDATE/DELETEs memory_audit, but D1 has no table-level immutability. **Resolved-for-v1:** accept app-level discipline + the ESLint/CI banned-binding control **AND** add the periodic append-only export of new `memory_audit` rows to R2 (`${tenantId}/audit/${yyyymm}.ndjson`, never rewritten) as the tamper-evidence backstop the SC7 "auditable" claim rests on (§7.6).
- **Polymorphic target_id:** memory_use_policy / provenance / review key off a single target_id across heterogeneous targets (facts, chunks, documents, sessions). Confirm a single polymorphic target_id (+ an optional target_kind column) is acceptable, versus per-target sidecars.

### §8 — Session Capture, Hot Memory & Backfill
- **Fact extraction granularity for sessions:** gbrain's extractFactsFromText runs over a single turn_text. For a full multi-turn transcript, do we extract per-turn (more LLM calls, finer source_session attribution) or over a windowed/whole transcript (cheaper, risks 24k-context overflow)? The plan implies whole-transcript in SessionPromoteWorkflow but the §4.3 token-budget guard would need to apply to the extraction prompt too.
- **Session fact dedup/supersession — RESOLVED for v1 (iter-3 completeness fix):** content_hash skip-unchanged at the session level is NOT sufficient for a genuinely-edited/re-run transcript (the hash changes, so promotion re-fires). v1 commits a **deterministic supersede-by-source rule** at fact writeback (§8.3): re-finalizing a `source_session_id` is a **clean replace, not an append** — within the `SessionPromoteWorkflow.writeback-facts` step, before inserting the freshly-extracted facts, soft-expire (set `expired_at=now()`, do not hard-delete, preserving the supersession lineage) the prior promoted fact set for that `source_session_id` (the `idx_facts_session` partial index makes this a single scan), in the **same `db.batch`** as the inserts + audit row. A secondary in-batch guard dedups the newly-extracted set on `(tenant_id, entity_slug, kind, LOWER(TRIM(fact)))` so two extractions of the same sentence within one run collapse to one row. This is NOT gbrain's cosine/classifier semantic dedup (still deferred to the Phase-3.5 entity-vector work); it is a deterministic, embedding-free rule sufficient to make re-promotion idempotent. Cross-session semantic dedup remains deferred.
- **brain_snapshots manifest contents:** facts are append-only with a validity window but the active set is time-dependent (expired_at/superseded_by). Pinning 'fact ids frozen at snapshot time' needs a precise rule — pin the exact ids active at snapshot_at, or pin a snapshot_at timestamp and resolve active facts as-of that time at read? The latter is cheaper to store but requires temporal as-of queries.
- **Idle-promotion semantic — RESOLVED (iter-3 SC6 fix):** the question of whether `ended_at` doubles as a last-activity marker is settled by introducing a **dedicated `sessions.last_activity_at` column** (NOT NULL, DEFAULT now()), refreshed on **every `capture_turn`**, with `ended_at` reserved strictly for explicit close/finalize (and therefore allowed to stay NULL forever on a missed Stop-hook). The idle sweep (`idx_sessions_open`, §8.3/§10.4) keys on `last_activity_at`, so a session that never received a Stop-hook is recovered once idle — making SC6's "missed Stop-hook recovered by idle-promotion cron" true against the schema. The only remaining tunable is the concrete `idle_minutes` window (kept open below under §10), not the column semantic.
- **Per-tenant Enumerator concurrency:** the plan caps Workflow creates at 100/s and 50k concurrent. For a large multi-tenant backfill (many tenants importing simultaneously), do we need a per-tenant fairness gate on Enumerator creation, or is the Queue's max_concurrency=10 sufficient back-pressure?

### §9 — API, MCP Server, CLI & Frontend
- **Transport scope:** ship BOTH the stateless Streamable-HTTP /mcp (gbrain) and the DO-backed McpAgent /mcp/:slug (cf-graph), or pick one? Two transports doubles the surface; the DO is needed only for stateful/SSE sessions. Recommend DO-backed as primary and stateless as a compatibility fallback, but confirm.
- **Active-tenant selection for users in multiple tenants — RESOLVED:** the per-surface pinned mechanisms stand — URL slug (MCP), `X-Brain-Tenant` header (REST), cookie (dashboard), `--tenant` flag (CLI) — and the default when unspecified is **error (401), never a first-membership default**. The resolved tenant is fed into the membership lookup, which is **scoped to that one tenant** (`WHERE user_id = ? AND tenant_id = ?`), so a user in multiple tenants never over-matches and the `Principal` is bound to exactly one tenant per request (§7.2/§9.0.1).
- **CLI distribution:** cf-graph ships a prebuilt `cfg` binary plus a Claude Code plugin/skill. Does `brain` also ship a Claude Code plugin (MCP config + skill), and is the binary bundled or npx-installed?
- **tRPC vs plain REST for the CLI:** cf-graph's CLI is a tRPC client (tightest typing) but couples the CLI build to server types. Acceptable, or does the CLI need a stable versioned REST contract instead?
- **Dashboard tenant switcher UX:** openbrains has one org per user (project switcher only). Confirm the two-level org-switcher + scope-switcher design, and whether org creation/self-serve onboarding is in scope for v1 or admin-provisioned only.
- **Snapshot tools** (get_session_context / brain_snapshots) are marked deferred in the plan — should they appear in the v1 MCP catalog as stubs or be omitted entirely until the snapshot phase?

### §10 — Deployment, Observability, Testing & Rollout
- **Vectorize isolation-test coverage:** Vectorize has no local emulator; the workerd isolation tests use an in-test fake that records the namespace argument. Is asserting 'ScopedVectorize always passes namespace=tenantId' (plus a staging integration test against a real index) sufficient coverage, or does the team want a dedicated staging-only isolation suite that hits real Vectorize before each prod deploy?
- **AI Gateway spend-rule configuration:** **Resolved-for-v1 (enforcement boundary settled):** AI Gateway spend limits price only Unified Billing / BYOK rails and do **not** cover the all-`@cf/` v1 model set, so the **enforcing** per-tenant cap is the app-level `token_spend` pre-check → 429 *before* `env.AI.run` (§5.1/§5f). Gateway `metadata.tenant_id` is attribution-only for v1. The metadata-mode spend-rule wiring (per-tenant rules vs one metadata-matching rule, the ~20-rules/gateway cap) only matters once premium **Unified-Billing** models are routed (deferred); confirm against the current AI Gateway API at that point, not before. **Platform plan (RESOLVED):** Cloudflare Workers **PAID** ($5/mo); Workers AI is billed by **Neurons** (Paid includes ~10,000 Neurons/day, then ~$0.011/1k Neurons). The documented **upgrade path** is AI Gateway (caching / retry / fallback) plus bring-your-own / OpenAI-compatible models later via the AI provider abstraction (`AI_PROVIDER=openai-compatible`, as in cf-graph `apps/graph/src/api/services/factory.ts`); locked v1 models stay bge-m3 (embed), llama-3.3-70b-instruct-fp8-fast (synthesis, 24k ctx), bge-reranker-base (rerank). The whole-platform spend cap is `MONTHLY_COST_CEILING_USD` (default 400, configurable) enforced by the app-level `token_spend` → 429 pre-check.
- **Workers AI request-RATE limits — RESOLVED-for-v1 (informed assumptions, non-binding at 1-2 tenants):** the per-model requests-per-minute ceilings are taken as **labeled conservative assumptions** — ≈300 req/min text-gen / reranker, ≈3000 req/min embeddings — explicitly **unverified-until-staging** and **non-binding at 1-2 tenants** (the dogfood fleet projection is nowhere near these). This is **no longer a launch dependency**; confirm against the live Workers AI limits during staging and file a limit-increase request only if a later phase's fleet projection approaches them. The chokepoint concurrency caps and the re-embed/backfill messages/tick pacing (§5.1, §10.7) still need concrete values once Phase-4/Phase-5 load is characterized.
- **bge-reranker-base output shape:** the `{ id, score }` field names are the *expected* shape but not pinned by the rendered doc. **Resolved-as-handled + hardened (iter-3):** the staging integration test that locks the actual output shape before the index→chunk remap is trusted is now a **hard, named, BLOCKING CI/deploy gate** (§10.6), not just "a staging test" — because a silently-wrong remap attributes the wrong chunk to a citation (a correctness bug). Defensive parsing + degrade-to-RRF limits blast radius until the gate is green; the confirmed shape is captured into §5.4 once locked. (The only residual is mechanical: capturing the exact field names after the first staging run.)
- **Long-chunk rerank truncation (iter-3 low, document-and-accept):** the reranker scores a long chunk on a **truncated prefix** (the per-candidate cap in §5.4 edge-case (b)) while synthesis uses the full `chunk_text`, so a long chunk can be mis-ranked relative to short ones. Accepted for v1 as a reasonable tradeoff; mitigated in practice by the ingest-time chunk-target (`CHUNK_TARGET≈1200`) keeping most chunks under the per-candidate cap so truncation rarely fires. Revisit only if ranking quality data shows long-chunk mis-ordering.
- **Cron cadence / pacing:** cadence is set to */5; the idle-session promotion IDLE window and the re-embed enqueue pacing (messages/tick) are not yet pinned. These need concrete values once Phase 4 load characteristics are known, to keep the single cron under its per-invocation work budget.
- **D1 down-migration policy:** the section assumes additive-by-default with redeploy-the-prior-Worker as the primary rollback. Confirm whether the team wants every migration to ship a tested down-script regardless, or accept 'irreversible, roll forward only' for additive migrations.
- **Dashboard deployment topology:** whether apps/dashboard deploys as a separate Worker (needing the services[] Service Binding shown) or is bundled into apps/api as static assets + same-Worker routes. This changes whether any Service Binding exists at all in v1.

### Confirmed decisions (this revision)
These product decisions are now RESOLVED and recorded here as the single source of truth (each also threaded into its owning section):
1. **Admin-vs-private posture — RESOLVED: FULL AUDITED + ALERTABLE BREAK-GLASS READ.** An owner/admin compliance read over another user's private content is permitted as a **break-glass** path that is **fully audited** (a `memory_audit` row, append-only, exported to R2) **and alertable** (it trips a §10.6 canary alert). Decided; see §7.6.
2. **Ingested-document default visibility — RESOLVED: `'world'` / tenant-wide.** Chunks (and the backing page) of an ingested document default to `visibility='world'` — tenant-wide is the **intended model**, not an accident: ingested company documents are shared knowledge by default. Decided; see §3.1.1/§6.1 (`visibility` default `'world'`).
3. **Org = tenant with row-scoping for intra-tenant clients — RESOLVED.** An org **is** the tenant; agency "clients" are **soft `scope` row-partitions within one tenant** (with enforced per-member `allowed_scopes`), not separate tenants. Decided; single source of truth is the §1 Persona C resolution above (the D1-per-tenant hard-isolation path stays the enterprise offer).
4. **Entity vector search — RESOLVED: IN v1.** Recorded under §6 above (`brain-entities` + `search_entities` pulled into v1; cross-session semantic fact dedup remains deferred to Phase 3.5).
5. **Scale / deployment topology — RESOLVED: 1-2 tenants, single D1, sharding deferred.** v1 is 1-2 tenants (internal dogfood). The multi-tenant **isolation** model stays fully intact; the horizontal **scale-out** machinery is **deferred to Phase-N** — single D1 (no shard fan-out), `tenant_shards` columns kept forward-compat but resolving to one shard, Vectorize 10M-vectors / 50k-namespaces ceilings **non-binding** at this scale. Recorded under §1 above. The **sole** TRUE-UNKNOWN is the exact vector/session counts (**measure during dogfood**).
6. **Platform plan — RESOLVED: Cloudflare Workers PAID.** $5/mo Paid plan; Workers AI billed by Neurons (~10,000 Neurons/day included, then ~$0.011/1k). Per-model request-rate limits are **labeled conservative assumptions** (unverified-until-staging, non-binding at 1-2 tenants). Upgrade path: AI Gateway (caching/retry/fallback) + bring-your-own / OpenAI-compatible models via `AI_PROVIDER=openai-compatible` (cf-graph `apps/graph/src/api/services/factory.ts`). Locked models stay bge-m3 / llama-3.3-70b-instruct-fp8-fast / bge-reranker-base. Recorded under §10 above.
7. **IdP — RESOLVED: Clerk.** Clerk is the OAuth 2.1 upstream IdP (matches gbrain-cf + openbrains); no "IdP TBD / TBD provider" remains.
8. **Cost ceiling — RESOLVED: `MONTHLY_COST_CEILING_USD = 400`, configurable.** Configurable via env var and per-tenant-overridable. The `token_spend` 429 enforcer trips when projected monthly spend would exceed it (§9.1.3); at 1-2 tenants this is effectively the whole-platform budget.

### Assembly notes (document-level)
- **Section-label vs master-plan numbering divergence.** Section headings (1, 2, 4–10, gap at 3) match the master plan's labels, but inline `§N` citations after §2 are the plan's own numbering and diverge from these headings (e.g. plan §5 = isolation, surfaced in §7; plan §6 = backfill, surfaced in §8; plan §4.3 = search, surfaced in §5). The `§N` refs were preserved verbatim rather than remapped — see the cross-reference convention note after the table of contents.
- **§0 inline; §3 now consolidated.** The master plan's **§0** (scale ceilings) is referenced throughout but was not provided as a standalone section to assemble; §0's numeric triggers are reproduced inline within §4–§8 where each is used. **§3** is now a full consolidated standalone data-model section that mirrors the inline DDL owned by §4/§6/§7/§8.

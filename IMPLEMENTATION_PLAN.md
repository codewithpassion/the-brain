# The Brain — v1 Implementation Plan (task DAG)

> Derived from `PRD.md` (4,508 lines) via an 11-section parallel read + architect synthesis.
> Machine-readable source: `plan/synthesis.json` (consolidated) and `plan/section-maps.json` (per-section maps).
> **Scope is locked to PRD v1** — see below. "Complete system" = the PRD's v1, a thing that *runs and can be measured*, not a broad polished platform.

## v1 scope (locked)

A runnable, measurable **single-Worker** "company brain" for **1–2 internal-dogfood tenants** on **ONE shared D1** and **two Vectorize V2 indexes** (`brain-chunks`, `brain-entities`, both bge-m3 / 1024d).

The **full multi-tenant isolation model ships** (org→team→user→scope, `Scoped*` chokepoints, mandatory D1 re-check, `namespace=tenantId`) and is **proven by a blocking isolation canary suite**. Horizontal scale-out is **deferred** (`tenant_shards` columns present but resolve to one shard; no fan-out logic).

**Delivers:** document + session ingestion (extract→chunk→embed→KG-extract→dual-index), hybrid search (FTS5 bm25 ∥ Vectorize → RRF → bge-reranker → token-budget-guarded cited synthesis via `think`), two-graph model (pages/doc_links + entities/entity_relations bridged by entity_mentions) with BFS traversal, governed memory (trust grades, append-only audit + recall traces, human-only promotion to `instruction`), Clerk OAuth 2.1 auth, and four thin surfaces (Hono REST/tRPC API, MCP server, `brain` CLI, TanStack dashboard) over a single Zod op-registry. App-level `token_spend` 429 pre-check is the enforcing cost cap (`MONTHLY_COST_CEILING_USD=400`).

**Deferred out of v1:** D1/Vectorize shard fan-out; frozen-snapshot injection (`brain_snapshots`/`get_session_context(snapshot_id)` accepted but stubbed); Phase-3.5 cross-session semantic entity dedup; DO-per-tenant working memory; BYO/openai-compatible provider routing (seam only); AI Gateway spend enforcement (attribution only).

**Definition of done:** `think` returns cited evidence over an ingested doc **AND** the isolation canary suite is green.

## Stack (from PRD §9, locked)

- **Runtime/deploy:** Cloudflare Workers Paid; single deployed Worker `apps/api` owning Hono REST + MCP DO + all Workflows + all Queue consumers + `scheduled()` cron. `compatibility_date 2026-06-01`, `nodejs_compat`.
- **Monorepo:** Turborepo + Bun workspaces (`apps/*` + `packages/*`). Biome strictest + tsc strict; `bun check` gate at every step.
- **API:** Hono (REST: webhooks, upload, OAuth, MCP transport) + tRPC (dashboard↔API + CLI) + **Zod single op-registry** generating MCP tools, tRPC procedures, and CLI commands so they cannot drift.
- **MCP:** `@modelcontextprotocol` McpAgent Durable Object at `/mcp/:slug` (stateful/SSE) + stateless Streamable-HTTP `/mcp` fallback. DO is protocol instance only, never system of record.
- **CLI:** `brain` via Commander as a tRPC client; OAuth 2.1 device flow (RFC 8628); tokens in `~/.config/brain/config.json`.
- **Frontend:** TanStack Start + shadcn on Workers, co-located in `apps/api` for v1 (no Service Binding); `createServerFn`; Clerk auth, server-side session-pinned tenant.
- **Auth:** Clerk as OAuth 2.1 / OIDC upstream IdP (`jose` jwtVerify vs Clerk JWKS, issuer-checked) + `@cloudflare/workers-oauth-provider` (KV-backed). Machine tokens `bdev_` (HMAC-SHA256) + API keys `bk_` (SHA-256 hashed).
- **Data:** D1 (single SQLite, **Drizzle** ORM + migrations, FTS5 external-content trigger-synced, `db.batch`, 100 bound-param cap) + Vectorize V2 (two 1024d cosine indexes, `namespace=tenantId`, topK ≤100) + R2 (tenant-prefixed bodies/transcripts + audit ndjson) + KV (OAUTH_KV) + DO (BrainMCP, SQLite-backed).
- **Durable execution:** Workflows (Enumerator, BatchIngest, EntityExtraction, SessionPromote) + Queues (brain-backfill, brain-reembed, each +DLQ) + Cron (`*/5`).
- **AI:** Workers AI via AI Gateway — `@cf/baai/bge-m3` (embed 1024d), `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (synthesis), `@cf/baai/bge-reranker-base` (rerank), `@cf/meta/llama-3.1-8b-instruct` (extract); all behind `embed()/gen()/rerank()` chokepoints; `AI_PROVIDER=openai-compatible` seam reserved.
- **Constants:** K=60 RRF, COSINE_FLOOR 0.5 / related 0.85, TRUST_BOOST{instruction:2.0,evidence:1.0,draft:0.6}, title boost 1.25×, top-40 candidates / top-k 8–12 (think=12), CHUNK_DB_BATCH_SIZE=10, EMBED_BATCH_SIZE=50, KG_BATCH_SIZE=5, MAX_CHUNKS_PER_DOC=4000, MAX_BODY_BYTES=8MiB, /ingest 256KB cap, SYNTHESIS_TOKEN_BUDGET~20000.

## Monorepo layout

| path | kind | depends on | purpose |
|---|---|---|---|
| `packages/shared` | library | — | Canonical `Principal`, Zod op/tool schemas, model constants, graph contracts (GraphNode/GraphPath/EdgeSpec, DOC_GRAPH/ENTITY_GRAPH), IngestionParams. |
| `packages/db` | library | shared | Drizzle D1 schema + migrations + FTS5 DDL; the **ONLY** module allowed to import raw `env.DB/Vectorize/R2`; `ScopedDB`/`ScopedVectorize`/`ScopedR2`; hybrid-search helpers; `embed()/gen()/rerank()` + AI-gateway + ops-metrics wrappers. |
| `packages/ingest` | library | shared, db | Platform-neutral Importer SDK (begin/nextBatch/finalize); fingerprint/normalize; source adapters (gmail, ob1, github, chatgpt, claude-code). |
| `apps/api` | worker-app | shared, db, ingest | The single deployed Worker: Hono + tRPC, BrainMCP DO, `/ingest`, OAuth transport, all Workflows + Queue consumers + cron. `resolvePrincipal` at the edge. |
| `apps/cli` | cli | shared | `brain` Commander program, tRPC client, OAuth device flow. |
| `apps/dashboard` | frontend | shared | TanStack Start + shadcn, co-located in `apps/api` for v1. |

## Build order (phases)

**Phase 0 — Tooling (done/in-progress):** Turborepo + Bun + Biome strict + tsc strict + `bun check` green on a smoke package. Provision wiring (wrangler.jsonc) lands in Phase 1.

**Phase 1 — FROZEN foundation (single-threaded, NOT parallelized):**
- `packages/shared`: Principal, Zod op/tool schemas, model constants, EdgeSpec/graph contracts, IngestionParams.
- `packages/db`: full Drizzle D1 schema + migrations (tenancy spine; documents/chunks/chunks_fts; pages/doc_links/entities/entity_relations/entity_mentions/entity_fts; facts/facts_fts; sessions/session_turns; memory_* sidecars; token_spend/backfill_runs/sources/ingest_log/mcp_request_log) + FTS5 trigger DDL.
- `packages/db`: `ScopedDB` (tenant_id + scopePredicate + visibilityPredicate injection, no raw-SQL passthrough), `ScopedVectorize` (hard-wired `namespace=tenantId`, foldPartitionFilter, topK cap 100), `ScopedR2` (`${tenantId}/` prefix).
- `resolvePrincipal` edge resolver chain (Clerk JWT → `bdev_` HMAC → `bk_` API key) + active-tenant selector (401 if unspecified); mint-time `allowed_scopes = intersect(request, minter)`.
- Provision Vectorize indexes + metadata indexes **before** any filtered upsert; wrangler.jsonc binding manifest; Clerk app + JWKS wiring.
- **Gates (merge preconditions, must be green at end of Phase 1):** ESLint banned-import rule (raw bindings only in `packages/db`) + reranker-output-shape gate + 15-canary isolation suite (cross-tenant read, FTS-arm leak, BFS cross-tenant hop, Vectorize re-check, cross-scope, intra-tenant visibility, break-glass).

**Phase 2 — Ingestion + hybrid search vertical slice (single-threaded):** the first measurable end-to-end path. (See vertical slice below.)

**Phases 3–6 (parallelizable after Phase 1+2 freeze):**
- **P3** Backfill spine + re-embed migration (Enumerator, brain-backfill queue+DLQ, brain-reembed + cron).
- **P4** Graph extraction + traversal + entity search (EntityExtractionWorkflow, generalized BFS over EdgeSpec, search_entities, graph MCP tools).
- **P5** Sessions + hot memory + governance (capture_turn/finalize/get_session_context, SessionPromoteWorkflow + idle cron, recall/forget_fact, governance gates, audit-export cron, ChatGPT + Claude-Code importers).
- **P6** Surfaces (full MCP catalog from op-registry, `brain` CLI commands, dashboard routes, Analytics Engine ops metrics, admin tools).

## First vertical slice (Phase 2 target)

1. **Provision:** apply D1 migrations; create `brain-chunks`+`brain-entities` Vectorize indexes + metadata indexes; create R2 bucket + KV + Queues; wire Clerk JWKS; seed one org + one membership (`allowedScopes='*'`).
2. **Authenticate:** `brain` CLI device-flow login → `resolvePrincipal` resolves Clerk JWT + active tenant → Principal bound to the tenant.
3. **Ingest:** `POST /ingest` a markdown doc → fingerprint, write body to R2 under `${tenantId}/`, insert `documents` row (pending), trigger `BatchIngestWorkflow` id `ingest-${tenantId}-${fingerprint}`.
4. **Workflow:** extract → chunk → store chunks (tenant_id/scope/visibility=world, FTS5 via triggers) → embed-batch bge-m3 (assert 1024d) → `ScopedVectorize.upsert namespace=tenantId` → KG-extract → finalize `indexed`.
5. **Search:** MCP `think` → embed(query) → FTS bm25 ∥ Vectorize (namespace=tenant) → both id sets JOIN back through `ScopedDB` + re-checked (cross-tenant/out-of-scope dropped) → RRF fuse → trust/title boost → bge-reranker → token-budget-guarded cited synthesis.
6. **Measurable result:** `think` returns `{answer, evidence[], citations[]}` citing the ingested doc's slug; one `memory_recall_trace` row per kept hit; AND the canary suite (second tenant's colliding-slug content never returned across vector/FTS/recall arms) is green.

## HARD invariants (must hold across every phase)

1. Every isolatable D1 row carries `tenant_id NOT NULL`; every vector is `namespace=tenantId` (never userId); every R2 key is `${tenantId}/`-prefixed — no single-tenant shortcuts.
2. All tenant data reached ONLY through `ScopedDB/ScopedVectorize/ScopedR2`; raw bindings importable ONLY inside `packages/db` (blocking ESLint rule).
3. Isolation does NOT rest on the Vectorize namespace. It rests on (a) un-omittable hard-wired Scoped wiring and (b) the mandatory **D1 row re-check after every vector AND FTS hit**, which silently **drops** cross-tenant/out-of-scope/deleted/out-of-visibility ids (drop-don't-error, no existence leak).
4. FTS5 external-content tables carry NO tenant_id; MATCH stays pure text and every result JOINs back to the tenant-scoped base table before any row leaves the keyword arm. MATCH-then-unscoped-read is a forbidden leak.
5. Two axes never conflated: `allowedScopes` (DATA partition) vs capabilities read/write/admin.
6. `trust_grade` is NEVER a chunks column nor a Vectorize metadata field — it lives only in the `memory_use_policy` sidecar, LEFT-JOINed at read (default `evidence`); a promotion never rewrites a chunk or re-upserts a vector.
7. `trust_grade` ∈ {instruction,evidence,draft} (behaviour) and `visibility` ∈ {private,team,world} (access) stay orthogonal.
8. `visibilityPredicate` un-omittable on every default read of a visibility-bearing row: `world OR (team AND team_id∈teamIds) OR (private AND user_id=p.userId)`; owner/admin do NOT bypass except via audited+alerted break-glass that fails closed and never bypasses tenant_id.
9. Agent writeback CANNOT set `instruction` (hard-wired `evidence`); promotion flows exclusively through a human-confirmed `memory_review` row.
10. `memory_audit` + `memory_recall_traces` are append-only; audit row written in the SAME `db.batch` as its change; recall-trace writes off the synchronous read path (`ctx.waitUntil`) — D1 is single-writer.
11. No interactive cross-await D1 transactions — atomicity via `db.batch([...])` only; respect 100 bound-param cap (CHUNK_DB_BATCH_SIZE=10).
12. bge-m3 1024d locked; dim-changing swap refused at `embed()`; foreign-dimension vectors RE-EMBEDDED never copied.
13. Bodies/transcripts live ONLY in R2; D1 holds index+lean rows + `markdown_preview` (≤2000) only.
14. `embed()/gen()/rerank()` NEVER throw on read path — degrade to keyword-only/RRF-order/evidence-without-synthesis; write-path embed failure throws to trigger Workflow retry (never index un-embedded chunks).
15. Deterministic Workflow ids make re-triggers idempotent; durable dedup rests on `(tenant_id,scope,fingerprint)` UNIQUE index.
16. `token_spend` pre-check returns 429 BEFORE `env.AI.run` (enforcing cap); AI Gateway limits attribution-only in v1.
17. No bare token below the edge: `resolvePrincipal` once at the edge, Principal threaded below; tenant from pinned mechanism, never JWT alone; 401 (never silent first-membership default) when unspecified.
18. Internal Worker↔Workflow/Queue hops use native bindings; consumers validate message `tenant_id` vs a real orgs row (fail-closed to DLQ).
19. `pages` is the ONLY doc-graph node space; KG is a separate graph; joined only via `entity_mentions`. Never one polymorphic nodes/edges table. Entities are {team,world} only.
20. Reranker index→chunk remap is a hard blocking CI/deploy gate; degrade to RRF order until green.
21. Idle-session promotion keys on `last_activity_at`, NOT `ended_at`; re-finalize is clean replace (soft-expire prior promoted facts), never append.
22. `tenant_shards` columns ship but resolve to ONE shard; CF ceilings non-binding documented Phase-N triggers, no sharding logic in v1.

## Top risks

- **Security (PRD-lowest, 71/100):** isolation rests entirely on D1 re-check + un-omittable Scoped wiring + FTS JOIN-back. Mitigation: blocking ESLint banned-import rule + 15-canary suite gating EVERY merge — green at end of Phase 1 before any parallel work.
- **Reranker output shape** unpinned by CF docs; wrong index→chunk remap mis-attributes citations. Lock by staging integration gate; degrade to RRF until green.
- **FTS5 isolation foot-gun:** copying `MATCH ... AND workspace_id=?` is a leak; mandatory JOIN re-check easy to forget on a new arm.
- **D1 single-writer + 6 GB budget:** recall-trace writes off read path; bodies in R2.
- **Workflow step caps** (1 MiB output, 10k steps): R2-staging + references-only enumeration; split oversized docs on chunk boundaries.
- **Re-embed migration** can starve interactive `think`: paced via `surface='migration'` + Queue back-pressure.
- **Cross-section contract drift:** frozen `packages/shared` + `packages/db` schema in Phase 1 must reconcile overlapping DDL/algorithm claims before parallel phases.

## Decisions (locked)

Blocking (decided by human):
- **Onboarding:** auto-provision an org on first Clerk login (org == user in v1); creates owner membership with `allowedScopes='*'`. `resolvePrincipal` creates-or-loads org on first authenticated request.
- **Machine token (`bdev_`):** one token per tenant, `tenantId` baked in at mint time; the token alone identifies the tenant (no separate selector for machine tokens).
- **Promotion to `instruction`:** a `member` MAY promote facts within their own `allowedScopes`; owner/admin promote anywhere. A human-confirmed `memory_review` row is ALWAYS required (agent writeback still hard-wired to `evidence`).

Non-blocking (defaulted):
- Custom-domain hostnames → workers.dev for v1 (deferred).
- Per-tenant cost-ceiling overrides → flat $400, no per-tenant override in v1.
- **Cloudflare account for provisioning/deploy:** `Dominik.fretz@gmail.com's Account`, account_id `a12823016aa16d0a8dd2678b258bd751` (wrangler is logged in via OAuth as dominik.fretz@gmail.com; token has workers/d1/ai/queues/kv write). Verify Vectorize is creatable under this token at provisioning; re-`wrangler login` if a scope is missing.

# Projects mined to build the-brain

The-brain's PRD (§1.1) fuses three local, in-progress projects rather than starting
from a blank slate. Each one already proved part of the "perfect memory" idea described
in the origin video ([`origin-video-transcript.md`](./origin-video-transcript.md)), but
none was the whole picture. This doc records what each one is, where it lives, and what
it contributed — for when any of them need re-checking against the PRD's citations.

## 1. cf-graph

- **Path:** `~/devel/cf-graph`
- **Upstream/origin:** own project, remote `git@github.com:codewithpassion/the-graph.git`
- **What it is:** document management + knowledge graph extraction on Cloudflare Workers.
  Monorepo: `apps/graph` (TanStack Start + Hono API) and `apps/cli` (`cfg`, Commander.js over tRPC).
  Uses D1 (documents/chunks/KG), R2 (file storage), Vectorize (semantic search), Workers AI
  (`bge-base-en-v1.5` embeddings + `llama-3.1-8b-instruct` for KG extraction), Workflows
  (durable ingestion), and Clerk for auth.
- **What it contributed to the-brain:** durable, CF-native binary ingestion and hybrid
  search — the `IngestionWorkflow`, `toMarkdown` extraction, and RRF fusion.
- **What it was missing:** isolation is metadata-filter-only (`filter:{workspaceId}`),
  which leaks the whole index if a filter is forgotten anywhere, and it has no
  team/client model.

## 2. gbrain-cf

- **Path:** `~/devel/gbrain-cf`
- **Upstream/origin:** a Cloudflare Worker port of [`garrytan/gbrain`](https://github.com/garrytan/gbrain)
  (Garry Tan's, of Y Combinator, personal "gbrain" project) — wire-compatible with the
  original `gbrain` CLI. This repo's own remote is `git@github.com:codewithpassion/gbrain-cf.git`.
- **What it is:** the gbrain server (`gbrain serve --http`) reimplemented as a CF Worker:
  D1 (relational), Vectorize (vector index), Workers AI (`bge-m3` embeddings + LLM),
  47 wire-compatible MCP operations (pages/graph, search/`think`, facts/hot memory,
  identity/health, platform/jobs).
- **What it contributed to the-brain:** the epistemic memory model and cited-synthesis
  pipeline — the `think` op with slug citations, gaps, and `no_evidence`/`llm_unavailable`
  warnings; the hybrid search engine; typed facts; resumable source sync. This is also
  the project the origin video calls out by name for its citation/source-of-truth
  approach and its "company brain" scoped-access idea.
- **What it was missing:** single-tenant by construction — its OAuth props carry no
  userId/tenant.

## 3. openbrains

- **Path:** `~/devel/openbrains`
- **Upstream/origin:** a reimplementation of [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1)
  (Nate B Jones) on Cloudflare + Convex + Clerk — an independent reimplementation, not a
  derivative (OB1 is FSL-1.1-MIT). Own remote: `git@github.com:codewithpassion/openbrain.git`.
- **What it is:** a persistent, governed AI memory system any MCP client can share.
  Workspaces: `apps/mcp` (CF Worker MCP server, OAuth via Clerk), `apps/dashboard`
  (TanStack Start + shadcn), `apps/cli` (`ob`), `packages/shared` (Zod schemas),
  `packages/ingest` (embedding pipeline + content fingerprint), `packages/convex`
  (Convex schema/functions).
- **What it contributed to the-brain:** structural multi-tenant isolation and
  governance — auth-first `requireUserId`, namespace-by-construction Vectorize, trust
  grades + audit + recall traces, and the platform-neutral importer SDK.
- **What it was missing:** its backend is Convex, which the-brain does not carry
  forward (the-brain is pure Cloudflare: D1/R2/Vectorize/Workers AI, no Convex).

## The unifying thesis (PRD §1.1)

> Take gbrain's epistemic/search depth, openbrains' isolation discipline, and cf-graph's
> durable ingestion, and re-found them on a pure Cloudflare stack (Workers + D1 + R2 +
> Vectorize V2 + Workers AI + AI Gateway + Workflows + Queues + KV + Durable Objects).
> Isolation becomes a structural property (`Scoped*` chokepoints), not a per-query
> convention; memory becomes governed (trust grades, audit, citations) rather than a
> flat vector dump; and a company's memory becomes shareable across a team and
> partitionable across clients — none of which any single source system does today.

## Frameworks referenced only in the video (not mined locally)

The origin video also names a few other memory frameworks as inspiration for its own
(unrelated) agent OS, which the-brain does not build on directly but are worth knowing
about for context:

- **Hermes** — the "frozen snapshot" injection pattern (`soul.md`/`user.md`/`memory.md`
  loaded at session start).
- **Memarch / mem search** — semantic (vector) + keyword hybrid search over chunked
  conversation history.
- **Claude Code's own `automemory`** — the baseline the video critiques as under-capturing
  and hard to search.

# The Brain — Cloudflare-native multi-tenant memory platform

A unified, multi-tenant "company brain" memory platform built entirely on Cloudflare primitives
(Workers, D1, R2, Vectorize V2, Workers AI, AI Gateway, Workflows, Queues, KV, Durable Objects —
**no Convex**). It fuses the best of three existing projects:

- **gbrain-cf** — cited synthesis (`think`), hybrid search, hot-fact memory, typed graph
- **openbrains** — multi-tenant isolation, trust grades, audit/recall traces
- **cf-graph** — durable, resumable document ingestion + knowledge-graph extraction

## Status

**v1 skeleton built** against the PRD (Turborepo + Bun monorepo). All phases land green under a
single `bun check` gate (Biome strictest + tsc strict + every test + a boundary-lint). Isolation
is proven by canary suites running in **real workerd D1** (`@cloudflare/vitest-pool-workers`):
cross-tenant reads, FTS-arm leaks, scope/visibility, break-glass, the composed `think` pipeline,
graph BFS hops, sessions/recall, and MCP sessions are each shown unable to cross a tenant boundary.

v1 is right-sized to the confirmed target: **1–2 tenants** (internal dogfood), single D1, horizontal
scale-out deferred to Phase-N, Clerk auth, Workers Paid plan, `MONTHLY_COST_CEILING_USD = 400`.

What's built (see `IMPLEMENTATION_PLAN.md` for the task DAG, invariants, and decisions):

- **`packages/shared`** — frozen contract: `Principal` (scope vs capability axes), enums, constants,
  graph `EdgeSpec`, the Zod op-registry that single-sources MCP tools / tRPC procedures / CLI commands.
- **`packages/db`** — Drizzle D1 schema (32 tables + FTS5) + migrations; the `Scoped*` isolation
  chokepoints (mandatory drop-don't-error D1 re-check; `namespace=tenantId`; tenant-prefixed R2); the
  tenant-injecting write path with audit-in-same-batch; `embed/gen/rerank` chokepoints; `resolvePrincipal`
  (Clerk JWT → `bdev_` → `bk_`); hybrid-search + cited-synthesis (`think`); graph traverse/search;
  sessions + governance; backfill; admin ops.
- **`packages/ingest`** — pure extraction/chunking + importers (ChatGPT, Claude-Code).
- **`packages/surface`** — the op-registry → MCP/tRPC/CLI generators (drift-guarded).
- **`apps/api`** — the single Worker: Hono REST + tRPC + the `BrainMCP` Durable Object MCP server +
  all Workflows + Queue consumers + cron.
- **`apps/cli`** — the `brain` CLI (Commander, typed tRPC client, `--token` + device-flow auth).
- **`apps/dashboard`** — TanStack Start + shadcn (Search/Think, Documents, Admin/Stats real).

**Measured against real Cloudflare primitives:** pending — the CI tier proves pipeline correctness with
stubbed Workers AI / Vectorize. The README's "measure real numbers" milestone (provision real
D1 + Vectorize + R2, run `think` over a real doc through real Workers AI) is the next step.

Build / verify:

```bash
bun install
bun check        # biome (strict) + tsc (strict) + all tests + boundary-lint, across the monorepo
```

### Deferred (Phase-N / follow-ups)

- D1 / Vectorize shard fan-out (`tenant_shards` columns present, resolve to one shard).
- Frozen-snapshot injection (`get_session_context(snapshotId)` accepted but stubbed).
- Dashboard Cloudflare build/co-location (`@cloudflare/vite-plugin`) + a few stubbed screens
  (graph/sessions/audit/jobs) + a `list_documents` op.
- Cross-session semantic entity dedup; BYO/openai-compatible provider routing (seam only);
  AI Gateway spend enforcement (attribution only in v1).
- v2 verification safety net (per `docs/v2-implementation-plan.md`, deferred 2026-07-02):
  GitHub Actions CI (W0.1), the scheduled real-AI gate (W0.2), and the model-deprecation
  tripwire (W0.3) — `bun check` stays a local convention until these land.

## Read this first

- **`brain-platform-PRD.html`** — the full PRD + layered architecture (rendered; open in a browser)
- **`brain-platform-review-history.html`** — the 8-round review journey, scores, and remaining items
- **`memory-systems-report.html`** — the original analysis comparing the three source projects

## Connect Obsidian (vault sync)

Sync an Obsidian vault into the Brain over a **WebDAV facade** — no S3 keys, no exposed storage
bucket. The Brain mints a per-tenant WebDAV credential; every key is forced under
`${tenantId}/vault/`, and writes trigger ingestion automatically. Design + internals:
`docs/r2-facade-plan.md`.

1. **Install Remotely Save** — in Obsidian, *Settings → Community plugins → Browse*; install and
   enable **Remotely Save** (works on desktop and iOS/Android).
2. **Generate a credential** — in the dashboard open **Vault Sync** (Admin nav) → *Generate*, and
   copy the username, password, and endpoint (the password is shown only once).
3. **Configure Remotely Save** — *Settings → Remotely Save*, choose **WebDAV** (not S3), then set:

   | Field | Value |
   |---|---|
   | Server address | the `endpoint` (ends in `/dav`) |
   | Username | the `vk_…` username |
   | Password | the generated password |

4. **Sync** — enable auto-sync, or run *Remotely Save: start sync*. The first run uploads the whole
   vault; `.md` notes are indexed (folders become path namespaces) and the entity graph fills in.

**Notes**

- Markdown is indexed for search + graph; other files (images, PDFs) are stored/synced but not indexed.
- Large attachments stream as R2 multipart uploads — no size cap.
- The reserved `Brain/` folder is write-back only (Brain → vault) and is never re-ingested (no loop).
- Revoking a credential in **Vault Sync** blocks all further syncs with that username immediately.

## Layout

```
the-brain/
  PRD.md                          assembled PRD (source of truth, markdown)
  brain-platform-PRD.html         rendered PRD
  brain-platform-review-history.html   rendered review journey
  memory-systems-report.html      original 3-project comparison
  sources/                        per-section markdown the PRD is assembled from
    s01.md … s10.md, appendix.md  the 10 sections + appendix
    coderefs.json                 per-section "code references" (cited source files)
  scripts/                        deterministic build tooling (Python, uses `markdown`)
    build.py                      sources/ + coderefs.json  ->  PRD.md
    convert.py                    PRD.md  ->  brain-platform-PRD.html
    build_journey_html.py         reviews/iter8.json  ->  brain-platform-review-history.html
  reviews/                        adversarial-review data per round (iter4–iter8.json)
  workflows/                      the multi-agent orchestration scripts that produced this
    brain-platform.workflow.js    initial analyze -> plan -> PRD -> harden
    loop4–loop8.workflow.js       the review/integration loops
```

## Regenerate

The HTML is generated from the markdown; edit `sources/*.md`, then:

```bash
cd scripts
python3 build.py          # reassemble sources/ -> PRD.md
python3 convert.py        # PRD.md -> brain-platform-PRD.html   (needs: pip install markdown)
python3 build_journey_html.py   # reviews/iter8.json -> review history
```

Paths are resolved relative to the script location, so the folder is portable.

## Source projects (cited throughout the PRD)

- `~/devel/gbrain-cf`
- `~/devel/openbrains`
- `~/devel/cf-graph`

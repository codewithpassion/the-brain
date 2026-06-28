# Obsidian ⇄ The Brain — Integration Design & Plan

> **Goal (from the brief):** "I'm using Obsidian, currently synced to R2. How could we achieve access for Obsidian to the Brain? I want to use it via computer **and native phone apps** without the **paid** Obsidian (Sync)."
>
> **Status:** Design doc. Grounded in a codebase audit (file:line citations below) + a 2026 research pass on the Obsidian/Cloudflare sync landscape.
>
> **Update (2026-06-28):** the **OKF-compatible agent-memory feature shipped** (`docs/okf-memory-plan.md`, on `main` + deployed) and it built several of this plan's "must build" items as a side effect — **YAML-frontmatter parsing, `[[wiki-link]]`/markdown-link → `doc_links` extraction, and the `pages` write surface with versioning**. So Phase 2 shrinks substantially, and there's now a **fast Phase-1 path via `okf_import`** (see §3a). Deltas are marked **✅ NOW BUILT** inline below.

---

## 0. TL;DR — the recommendation

Run a **three-layer** integration, each layer independently useful so we ship value early:

1. **Sync substrate (today, $0, no code):** keep the vault in **Cloudflare R2** via the free **Remotely Save** plugin (S3 mode → R2). It is the *only* free option that works on **desktop + iOS + Android** with the vault literally in R2. Give each device a **bucket-scoped R2 token**, not root keys.
2. **Brain ingestion (the core new work):** add an **Obsidian source/importer** so the Brain ingests the R2 vault through the *existing* backfill pipeline — every note becomes a searchable, graph-linked Brain document under a `path` namespace mirroring your folders. One-way (vault → Brain) first; deletions + write-back come next.
3. **In-editor Brain (the payoff):** a small, **mobile-compatible** Obsidian plugin that calls the Brain's REST/MCP for `think` / `search` / graph from inside the editor on phone and desktop.

A fourth, **already-true** fact: the Brain's **MCP server is phone-reachable today**. You can add it to the **Claude mobile app** as an OAuth connector and query your whole Brain from your phone right now — independent of Obsidian.

```
                    ┌──────────────────────── DESKTOP + iOS + ANDROID ────────────────────────┐
                    │                                                                          │
   ┌────────────┐   │   ┌──────────────┐      Remotely Save (S3)      ┌──────────────────┐     │
   │  Obsidian  │◀──┼──▶│  Local vault  │◀────────────────────────────│  Cloudflare R2   │     │
   │  (editor)  │   │   │ (markdown)    │  scoped per-device token     │  vault/ prefix   │     │
   └─────┬──────┘   │   └──────────────┘                              └────────┬─────────┘     │
         │          │                                                          │ (1) change    │
         │ (3)      └──────────────────────────────────────────────────────────┼───────────────┘
         │ plugin: think/search/graph                                          │ event/cron
         │ via requestUrl + OAuth                                              ▼
         │                                                       ┌───────────────────────────┐
         └──────────────────────────────────────────────────────▶│        THE BRAIN          │
                              REST / MCP (/mcp/:slug)             │  Obsidian importer →      │
                                                                  │  backfill → ingest →      │
                                                                  │  chunks · embed · graph   │
                                                                  │  (tenant = org_${userId}) │
                                                                  └───────────────────────────┘
              (2) brain writes synthesized notes back to R2 `Brain/` → Remotely Save → Obsidian
```

---

## 1. Constraints & what "done" means

| Constraint | Implication |
|---|---|
| **No paid Obsidian Sync** | Sync must ride free infra. Remotely Save (free) → R2, or Self-hosted LiveSync (CouchDB). |
| **Desktop *and* native phone apps** | Rules out Git (unusable on mobile) and iCloud (Apple-only). Plugin must be `isDesktopOnly:false`. |
| **Vault already in R2** | Favors "R2 is the substrate" over CouchDB. Reuse the existing R2 bucket. |
| **"Access for Obsidian to the Brain"** | Two directions: (a) Brain *ingests* the vault (search/graph/think over your notes); (b) Obsidian *queries* the Brain in-editor; (c) Brain *writes back* notes. |

"Done" = you edit notes on phone or laptop, they sync free via R2, the Brain ingests them (searchable + graphed + answerable), and you can ask the Brain questions and pull its answers back into Obsidian — on any device.

---

## 2. The sync-substrate decision (research)

| Option | Free? | iOS+Android? | Vault in R2? | Sync quality | Verdict |
|---|---|---|---|---|---|
| **Remotely Save → R2 (S3)** | ✅ (free tier) | ✅ | ✅ **yes** | Scheduled/manual full-vault diff, **file-level** (conflict copies on simultaneous edits) | ✅ **Chosen** |
| Self-hosted LiveSync (CouchDB) | ✅ (self-host) | ✅ | ❌ CouchDB, not object storage | Near-real-time, CRDT-ish, best concurrency | ✗ breaks "vault in R2" + you run a server |
| Obsidian Git | ✅ | ⚠️ "very unstable" on mobile (isomorphic-git; no native git) | n/a (Git host) | n/a | ✗ out for mobile |
| Official Obsidian Sync | ❌ paid | ✅ | ❌ | best | ✗ this is the thing being replaced |

**Choice: Remotely Save + R2 (S3 endpoint).** It's the only option meeting all three hard constraints at once. Trade-off to accept: its sync is **scheduled file-level diff, not real-time/CRDT** — fine for single-user sequential editing, weaker for editing the *same* note on two offline devices at once (you get a conflict copy, not a clean merge). LiveSync is technically superior on concurrency but abandons R2 and adds a server to operate.

**R2 cost for a personal markdown vault ≈ $0/mo** — free tier is 10 GB storage, 1M Class A + 10M Class B ops/mo, **egress always free**. A text vault never approaches those limits. Only watch **Class A ops** (PUTs) if a client does very frequent full-vault pushes.

> ⚠️ **The encryption tension (important).** Remotely Save offers **client-side E2E encryption** — but then R2 holds *ciphertext*, which the Brain cannot read to ingest. Resolution options:
> - **(A) Plaintext in R2** (recommended for the Brain-integrated vault): rely on **R2 server-side encryption at rest** + **least-privilege scoped tokens**. R2 is *your own* infra under your Cloudflare account, so this is a reasonable trust boundary. The Brain reads plaintext markdown and ingests it.
> - **(B) E2E vault + a separate plaintext push channel:** keep Remotely Save E2E for privacy, and have the **Brain plugin** (Phase 3) push plaintext of *selected* notes straight to the Brain's ingest API over TLS — the Brain never reads R2 for those. More moving parts, but preserves an encrypted-at-rest vault.
> - Decide this explicitly before Phase 1. Default to (A) for simplicity.

---

## 3. What the Brain already provides (codebase audit)

The Brain was **built for this** — there is a generic ingestion + sources/backfill spine, a path-namespace model, a doc-graph, and external-client auth. Citations are file:line in this repo.

### ✅ Already in place — reuse directly
- **Sources / Importer / backfill spine** — the natural home for a "vault" source.
  - `sources` table: `id, tenantId, name, kind, config(JSON), lastCommit, lastSyncAt, syncFailCount, archived` (`packages/db/src/schema/ops.ts:49`). `SourceStore` lifecycle ops + exponential backoff (`packages/db/src/backfill/sources.ts`).
  - **`Importer` interface** — `begin() / nextBatch(cursor) / finalize()` with contract safety invariants (terminal cursor `null`; no empty-batch-with-cursor) (`packages/ingest/src/sources/types.ts:50`, `contract.ts:12`).
  - **EnumeratorWorkflow** — durable, step-resumable: `begin → loop(nextBatch → stage body to R2 → enqueue lightweight ref → persist cursor) → finalize (advance anchor only on clean exit)` (`apps/api/src/backfill/enumerate.ts:81`).
  - **Backfill Queue** + message shape `{tenantId, sourceId, runId, kind:"doc"|"session", payloadRef(R2 key), fingerprint, contentType, userId}` (`apps/api/src/backfill/messages.ts:10`). **Note `kind:"doc"`** — exactly what notes are.
  - The factory that maps a source kind → importer: `apps/api/src/backfill/enumerate.ts:34` (`importerForClient`). `"obsidian"` is *already* an anticipated client value in `ImportedSession` (`packages/ingest/src/sources/types.ts:24`).
- **Ingestion pipeline** — `runBatchIngestCore` (6 steps: status→read R2→chunk→insert chunks→embed→finalize) (`packages/db/src/ingest.ts:50`). Entry points: `POST /ingest` (markdown webhook, 256 KiB) (`apps/api/src/index.ts:303`), `POST /documents` (binary→AI-extract, 8 MiB) (`:394`), and the **`ingest_document` MCP write tool** (shipped this session).
- **Fingerprint dedup** — `UNIQUE (tenant_id, scope, fingerprint)` + `UNIQUE (tenant_id, slug)`; re-ingesting an unchanged note returns `{status:"duplicate", deduped:true}` (not an error) (`packages/db/src/schema/content.ts:47`). This makes re-sync idempotent for free.
- **`path` namespace + `tags`** on documents, mirrored onto chunks; `search`/`think` can be **scoped to a path or tag** (shipped this session). Obsidian **folders → `path`** maps perfectly (e.g. `Projects/Acme/notes.md` → `path:/Projects/Acme`).
- **Doc-graph** — `pages` (graph nodes, with a `frontmatter` JSON column + `documentId` backref), `doc_links` (with an extensible `linkSource` field: "manual" | "extracted" | "obsidian" | "okf"), `tags`; graph ops `/graph/links|backlinks|traverse` wired (`packages/db/src/schema/docgraph.ts:15`).
- **✅ NOW BUILT — the `pages` WRITE surface (OKF memory).** The doc-graph was read-only when this plan was written; the OKF feature shipped the **audited write chokepoint** (`MemoryStore`, `packages/db/src/memory/store.ts`): create/update/get/list/history/forward-only-rollback/soft-delete over `pages`, with a new **`page_revisions`** history table (per-concept versioning). It reconciles **`tags` from frontmatter** and **`doc_links` from in-body `[[slug]]` + `[text](slug)` links** in one batch. Exposed as the `memory_*` + `okf_*` ops across MCP/REST/CLI.
- **✅ NOW BUILT — frontmatter + link parsing.** `parseDocument` (`packages/db/src/memory/okf.ts`) parses YAML frontmatter (**flow AND block** sequences) + splits the body; `extractLinkSlugs`/`reconcileLinks` (`store.ts`) turn `[[note]]`/`[text](slug)` into `doc_links`. These cover this plan's §3-#3 and §3-#4 — they live in the OKF/memory module today (reuse directly via `okf_import`, or lift the helpers into the document-ingest path if notes should also be searchable chunks).
- **R2 + tenant isolation** — `BODIES` bucket `the-brain-bodies` (`apps/api/wrangler.jsonc:28`); **ScopedR2 forces a `${tenantId}/` key prefix** — no caller can escape its tenant namespace (`packages/db/src/scoped/r2.ts:14`).
- **External-client auth** — **device-flow (RFC 8628)** `/device_authorization` + `/activate` + `/token` (`apps/api/src/device-flow/routes.ts:29`) **and** a working **`/cli/activate`** approval page; **`bk_` API keys** (SHA-256 hashed, capability + data scopes) with **full CRUD + an API-Keys dashboard page** (shipped this session); the **OAuth 2.1 wrapper** (PKCE-S256, discovery, dynamic registration) bridging legacy bearers on `/mcp` (`apps/api/src/index.ts:700`).
- **MCP surfaces** — stateful `/mcp/:slug` (DO-backed, slug selects tenant) + stateless `/mcp` (`apps/api/src/mcp/routes.ts:53`). Confirmed phone-reachable from the Claude mobile app.
- **Multi-tenancy** — deterministic `org_${userId}` + injective slug, auto-provisioned on first login, every table `tenant_id NOT NULL`, the D1 re-check drops cross-tenant rows (`packages/db/src/auth/principal.ts:145`). Your vault simply lives in *your* org.
- **Already shipped this session** (so they're *not* gaps, despite older notes): API-key management UI + ops, add-member-by-email, multi-org switcher, `/cli/activate`, `documents.path`/tags/filters, the `ingest_document` MCP tool, the authenticated `brain` CLI.

### ❌ Missing — must build for Obsidian
1. **No Obsidian importer** — only ChatGPT / Claude-Code importers exist. *(Phase 1)*
2. **No `documents.deletedAt`** — chunks have a soft-delete column, **documents do not**, and there's no document-delete API. **This blocks deletion sync** (deleting a note in Obsidian can't remove it from the Brain). *(Phase 2 — required for two-way)*
3. ~~**No wiki-link / `[[link]]` extraction**~~ → **✅ NOW BUILT** (OKF). `[[note]]` + `[text](slug)` parsing → `doc_links` exists in the memory module (`extractLinkSlugs`/`reconcileLinks`). Remaining work: reuse via `okf_import`, OR lift the helper into `packages/ingest/src/markdown.ts` if you also want notes as searchable **document** chunks. *(Phase 2 → mostly done)*
4. ~~**No YAML frontmatter parsing**~~ → **✅ NOW BUILT** (OKF). `parseDocument` extracts `---` frontmatter (flow + block YAML) → `pages.frontmatter` + `tags`. Same reuse note as #3. *(Phase 2 → done)*
5. **No R2 event notifications** — R2 changes don't trigger ingestion; it's request/cron-driven only. A cron diff works for v1; R2 events (GA) are the near-real-time upgrade. *(Phase 1 uses cron; Phase 4 wires events)*
6. **No vault-diff** — must detect *which* notes changed (hash compare vs `sources.lastCommit`) instead of re-enumerating the whole vault each run. *(Phase 1)*
7. **No write-back convention** — a `Brain/` folder + a writer for brain-authored notes. *(Phase 2)*

---

## 3a. NEW: an Obsidian vault ≈ an OKF bundle (a faster Phase-1 path)

An Obsidian vault is **markdown files with YAML frontmatter and `[[links]]`** — which is exactly an **OKF bundle** (Open Knowledge Format v0.1), and the Brain now speaks OKF natively. So there are **two ingestion targets**, and the choice shapes Phase 1:

| Target | Path | You get | You don't get |
|---|---|---|---|
| **Memory pages (OKF)** — `okf_import` / `memory_set` | vault files → `okf_import` | versioned `pages` + history/rollback, frontmatter, tags, `doc_links` graph, OKF round-trip — **no new parsing code** | semantic search/`think` (pages aren't chunked/embedded) |
| **Documents** — `runBatchIngestCore` (the original plan) | importer → `ingest` pipeline | chunked + embedded → `search`/`think` | versioning/graph unless the OKF helpers are lifted in |

**Recommended: do both, cheaply.** The Obsidian importer enumerates the R2 vault once and (a) feeds files to **`okf_import`** for the graph/versioning/frontmatter layer (already shipped — zero parsing work), and (b) feeds the same markdown to the **document** pipeline for searchable chunks. The slug = the note's path (folders → `path`), so the two views align on identity. This collapses most of the old Phase-2 (#2 wiki-links, #3 frontmatter) into "call `okf_import`."

---

## 4. Phased plan

### Phase 0 — Works today ($0, ~30 min of setup, no code)
- **Vault sync:** install **Remotely Save** on Obsidian (desktop + phone), S3 remote → R2 endpoint `https://<accountid>.r2.cloudflarestorage.com`, a **bucket-scoped R2 token** (Object Read & Write, that bucket only), region `auto`. (Configure bucket **CORS** if the plugin requires it — verify at setup.)
- **Query the Brain from your phone *now*:** add the Brain MCP server `https://brain-api.dominik-fretz.workers.dev/mcp/org_user_<id>` to the **Claude mobile app** as an OAuth connector (after the connector re-fetches the corrected tool schema). Or use a `bk_` key.
- **CLI:** already authenticated this session (`brain think --query …`).

### Phase 1 — Vault → Brain ingestion (read-only intelligence) · ~3–5 days
Goal: every note becomes a searchable, namespace-scoped Brain document.
1. **`createObsidianImporter()`** in `packages/ingest/src/sources/obsidian.ts` implementing `Importer`:
   - `begin()` → list the R2 vault prefix (e.g. `${tenantId}/vault/**.md`), build/restore a file→hash index as the cursor.
   - `nextBatch()` → emit **`kind:"doc"`** items: `{ slug (from path), path (folder → /Projects/Acme), tags (frontmatter), content (markdown), fingerprint, contentType:"text/markdown" }`. Honor the contract (terminal cursor `null`, no empty-batch-with-cursor).
   - `finalize()` → advance the anchor.
2. **Register** in `importerForClient()` (`apps/api/src/backfill/enumerate.ts:34`).
3. **Create the `sources` row:** `{ kind:"obsidian", config:{ bucket, prefix:"vault/" } }` (one-time, per tenant).
4. **Trigger** via the existing **5-min cron** (already enumerates sources). Diffing: store per-file hashes in `sources.lastCommit`; enqueue only changed notes (dedup also catches unchanged ones for free).
5. **Map** Obsidian folders → `path`, frontmatter `tags` → `tags`. **Result:** `think`/`search`/MCP answer questions over your vault, scoped to `/Projects/Acme` etc.

*Deliverable:* ask the Brain (CLI, MCP, dashboard, or Claude app) a question and get a cited answer drawn from your Obsidian notes.

### Phase 2 — Two-way + richer ingestion · **~3–5 days now** (was ~1–2 weeks)
1. **Deletion sync (required for two-way):** add `documents.deletedAt` (migration) + soft-delete propagation to chunks/pages + a `delete_document` op/endpoint. The importer marks notes deleted when they vanish from the vault. *(`pages`/memory already soft-delete via `memory_forget`; the **document** side is the remaining gap.)*
2. ~~**Wiki-link extraction**~~ → **✅ DONE** if Phase 1 uses `okf_import` (it reconciles `doc_links` from `[[..]]`/`[..](..)`). Only needed separately if you want links on the **document** view too — then lift `reconcileLinks` into the ingest path with `linkSource:"obsidian"`.
3. ~~**Frontmatter parsing**~~ → **✅ DONE** via `okf_import` (`parseDocument`). Same caveat as #2 for the document view.
4. **Write-back:** brain-authored notes (synthesized summaries, captured agent memory, daily digests) written to a **`Brain/` folder** in the R2 vault → Remotely Save pulls them into Obsidian on all devices. **`okf_export` already emits a ready-to-write bundle** (`index.md` + concept `.md` + `log.md`); the writer just streams those files to R2 under `Brain/`. Keep brain-owned files in a reserved folder to avoid clobbering user notes.

> ⚠️ **Phase-1 → Phase-2 slug/fingerprint collision (pre-deployment migration required for non-fresh envs).**
> Phase-1 obsidian ingestion stored docs with legacy slugs (e.g. `bf-obsidian:path:etag`) and no `source_kind`. Phase-2 uses vault-path slugs (e.g. `Projects/notes`) and `source_kind='obsidian'`. If Phase 2 is deployed to an environment that already ran Phase-1 obsidian ingestion, unchanged notes will DLQ on the fingerprint `UNIQUE (tenant_id, scope, fingerprint)` index, and edited notes will duplicate (new slug, no supersede). **Before deploying Phase 2 to any such environment, run a one-time migration** to re-slug Phase-1 obsidian docs to vault paths and stamp `source_kind='obsidian'`, or wipe and re-ingest. This migration is not yet implemented — moot on fresh deployments (no Phase-1 obsidian docs exist on the live the-brain DB).

### Phase 3 — The Brain Obsidian plugin (in-editor intelligence) · ~2–3 weeks
A community plugin, **`isDesktopOnly:false`**, mobile-compatible. Respect the mobile rules: **no Node `fs`/`crypto`/`path`/`child_process`**; use the **Vault API** for files and **`requestUrl`** for all network (also dodges CORS).
- **Auth:** device-flow (RFC 8628) via an **`obsidian://` redirect handler + PKCE**, or paste a `bk_` API key. Tenant binds to `org_${userId}`. Store tokens encrypted.
- **Commands:** "Ask the Brain" (insert a cited answer over your whole vault), "Search Brain", "Related / backlinks (graph)", "Capture this note → memory", "Pull Brain notes".
- **Distribute:** **BRAT** (install from the GitHub repo, auto-updates) during beta → community store for GA.

### Phase 4 — Real-time + sync polish (optional) · as needed
- Wire **R2 event notifications → a Queue consumer** (GA): `wrangler r2 bucket notification create the-brain-bodies --event-type object-create --event-type object-delete --queue <q>` with a `vault/` prefix filter → incremental, near-real-time ingest (replaces cron polling; at-least-once, no strict latency SLA).
- Optional **Worker-based WebDAV/S3 facade** over R2 if you ever want the Brain itself to *be* the sync endpoint (vs Remotely Save → R2 directly). Mind the Worker single-PUT size limit (~100–128 MB) for large attachments.

---

## 5. Auth & security

- **Per-device R2 credentials:** issue a **bucket-scoped** R2 S3 token (Object Read & Write) per device — ideally **short-lived/rotatable** derived from a parent token. Never put account root keys on a phone. (R2 token ID = S3 Access Key ID; secret = SHA-256 of the token value.)
- **Brain client auth:** the plugin uses **device-flow** (no secret embedded) or a **`bk_` key** scoped to `read` (or `read,write` if it writes back). Keys are revocable from the API-Keys page. Tenant is always `org_${userId}` — your vault is isolated to your org by the same invariant as everything else (D1 re-check drops cross-tenant rows).
- **MCP/OAuth hardening:** the MCP server already issues audience-bound, PKCE-S256 tokens; follow post-2025-11 remote-MCP OAuth guidance (strict redirect validation) — already aligned.
- **Encryption posture:** see §2. Default (A) = plaintext in R2 (server-side encrypted) + scoped tokens. Choose (B) only if an encrypted-at-rest vault is a hard requirement.

---

## 6. Conflict, deletion & idempotency

- **Idempotent ingest:** fingerprint dedup means re-syncing an unchanged note is a no-op (`{status:"duplicate"}`). Safe to run the importer as often as the cron fires.
- **Edits:** a changed note → new fingerprint → re-ingest → re-chunk/re-embed. (Phase 2 should supersede the prior document version by slug, not pile up duplicates — handle via the `(tenant,slug)` unique index + an update path.)
- **Deletions:** the **blocker** — needs `documents.deletedAt` (Phase 2). Until then, deletes in Obsidian won't remove notes from the Brain.
- **Simultaneous multi-device edits:** Remotely Save produces a **conflict copy** (file-level), not a merge. Acceptable for single-user; document the behavior. (LiveSync would merge, but isn't R2-backed.)
- **Write-back loop avoidance:** brain-authored files live under a reserved `Brain/` folder and are marked (frontmatter `source: brain`) so the importer doesn't treat them as user edits to re-ingest in a loop.

---

## 7. Costs

- **R2:** personal markdown vault ≈ **$0/mo** (well within free tier; egress always free). Watch Class A (PUT) ops only under very frequent full-vault pushes.
- **Workers AI (embeddings/think):** per-tenant `token_spend` ledger + a **429 pre-check** already guards a monthly ceiling (default $400) (`packages/db/src/schema/ops.ts:86`). Ingesting a vault is a one-time embed cost + deltas; bounded and observable.
- **Remotely Save / the plugin / BRAT:** free, open-source.

---

## 8. Risks & open questions

| Risk / unknown | Mitigation |
|---|---|
| **E2E vs ingestion** (R2 ciphertext unreadable by the Brain) | Decide §2 up front; default to plaintext-in-R2 + scoped tokens, or the plugin-push channel. |
| **Remotely Save CORS** on R2/S3 (historically required) | Verify + set bucket CORS at Phase 0 setup. |
| **R2 event latency** — no published SLA | Phase 1 uses cron (predictable); treat events (Phase 4) as near-real-time, at-least-once. |
| **File-level conflicts** on simultaneous edits | Document the conflict-copy behavior; single-user is fine. Consider LiveSync only if this becomes painful (drops R2). |
| **Mobile plugin suspension / battery** on large syncs | Keep the plugin read-mostly; let Remotely Save own bulk sync; batch network calls. |
| **Vault ↔ tenant key mapping** (Remotely Save writes a flat bucket; ScopedR2 forces `${tenantId}/`) | Point Remotely Save at a prefix under the tenant (`${tenantId}/vault/`), or run the importer against a dedicated vault bucket mapped to the tenant. Settle in Phase 1. |
| **Re-ingest churn** on every edit (re-embed cost) | Delta-only enqueue (hash diff) + supersede-by-slug; bounded by `token_spend`. |

---

## 9. Concrete next steps

**Decisions to make first:**
1. Encryption posture — plaintext-in-R2 (A) vs E2E + plugin-push (B). *(Recommend A.)*
2. Vault key layout — Remotely Save writes under `${tenantId}/vault/` in `the-brain-bodies`, or a separate vault bucket. *(Recommend a `vault/` prefix under the tenant.)*

**Build order (smallest shippable increments):**
1. **Phase 1 POC** — Obsidian importer + factory registration + a `sources` row + cron trigger + vault-diff. Feed enumerated vault files to **`okf_import`** (graph + frontmatter + versioning, **no new parsing**) and/or the document pipeline (search). *(~3–5 days; delivers a searchable + graphed vault.)*
2. **`documents.deletedAt` + delete path** — unblocks deletion sync on the **document** view (`pages`/memory already soft-delete). *(small migration + op.)*
3. ~~**Wiki-link + frontmatter extraction**~~ — **✅ already shipped** with OKF; reuse via `okf_import` (or lift the helpers into ingest for the document view).
4. **Write-back** (`Brain/` folder) — brain → Obsidian. **`okf_export` already produces the bundle**; just write its files to R2.
5. **The Brain plugin** (BRAT beta) — in-editor think/search/graph on phone + desktop.
6. **R2 events** — swap cron for near-real-time.

Each phase is independently useful: after Phase 1 you can already ask the Brain about your notes from your phone (Claude app / MCP) and laptop (CLI / dashboard) — for free, without Obsidian Sync.

---

*Sources: codebase audit (file:line above) + 2026 research on Remotely Save / Self-hosted LiveSync / Obsidian mobile plugin APIs / Cloudflare R2 event notifications, scoped tokens, pricing / remote-MCP-on-mobile. Research notes available on request.*

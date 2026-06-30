# Notion integration — design & plan

> **Goal:** connect a Notion workspace to the Brain "in a similar way to Obsidian" — pages flow in,
> get chunked / embedded / entity-extracted, and stay in sync, with the same per-tenant isolation and
> the same ingest pipeline. Two-way write-back optional.
>
> **Status:** Design. No code yet. Companion to `docs/r2-facade-plan.md` (the Obsidian/WebDAV path).

---

## 0. Verdict + the one fundamental difference

Connectable, and **most of it reuses what Obsidian already built**. But "similar to Obsidian" can
only mean *similar pipeline*, not similar mechanism — because the two integrations are mirror images
at the front door:

| | **Obsidian** (built) | **Notion** (this plan) |
|---|---|---|
| Where content lives | local files, synced to R2 by Remotely Save | Notion's cloud (blocks, via the Notion API) |
| Who authenticates to whom | the **client → Brain** (Brain mints a WebDAV credential) | the **Brain → Notion** (OAuth; Brain holds Notion's token) |
| How content arrives | client **pushes** (WebDAV PUT) + R2/cron | Brain **pulls** (API poll) + Notion **webhooks** |
| Content format | markdown already | Notion **blocks** → must convert to markdown |

So the front half is new (OAuth, an API client, a block→markdown converter, a webhook receiver), but
the **back half is identical** and already exists:

- the `sources` table (`packages/db/src/schema/ops.ts:49`) — add rows with `kind: "notion"`.
- `runDocIngestCore` (`apps/api/src/backfill/consume.ts:71`) — the shared chunk/embed/extract entry,
  driven by `{ slug, fingerprint, payloadRef, contentType, path, tags, sourceId, isPhase2 }`.
- the **fingerprint no-op / supersede-by-slug** gate, the soft-delete path, `ScopedDB`/`ScopedR2`
  isolation, and the entity-extraction queue — all unchanged.
- an events queue + consumer exactly like `apps/api/src/vault-events/consume.ts`.

---

## 1. Architecture

```
Notion workspace                      Brain                                  (existing pipeline)
  │  (user shares pages/dbs            ┌──────────────────────────────┐
  │   with the Brain integration)     │ OAuth bot token (per tenant,  │
  ▼                                   │   encrypted in D1)            │
 Notion API ◄───── pull (poll) ───────┤ Notion API client (throttled)│
  │                                   │  → blocks → markdown          │
  │                                   │  → stage md to R2 (notion/…)  │──► runDocIngestCore ──► chunk
  └──── push (webhook) ──────────────►│ /notion/webhook → verify →    │      (supersede-by-slug)  embed
        page.content_updated etc.     │   enqueue notion-events       │──► soft-delete on archive  extract
                                      └──────────────────────────────┘
  ▲  (optional Phase 5)                        │
  └────────── write-back ◄──── okf_export → markdown → blocks → Notion page create/update
```

Two triggers feed one ingest path (same shape as Obsidian's R2-events + cron backstop):

- **Cron poll (MVP, reliable):** every N minutes, for each `notion` source, query the Notion API for
  pages with `last_edited_time > sources.last_sync_at`; ingest the deltas; advance `last_sync_at` only
  on a clean pass (the `sources` table already models this with `last_sync_at` + `sync_fail_count`
  backoff).
- **Webhooks (real-time, Phase 3):** Notion delivers `page.content_updated` / `page.created` /
  `page.deleted` to `/notion/webhook`; the handler verifies the signature, maps `workspace_id →
  tenant`, and enqueues a `brain-notion-events` message → a consumer that mirrors `vault-events`.

---

## 2. Auth & token model (the reversed direction)

Unlike Obsidian (Brain stores *nothing* — the client holds a Brain-minted credential), here the Brain
holds **Notion's** bearer token and calls Notion as the client. That changes the security posture:

- **Connect via OAuth.** Register one Notion **public integration** (OAuth app). A dashboard
  **"Connect Notion"** page starts the OAuth flow (redirect → Notion consent → `/notion/callback`).
  The user picks which pages/databases to share with the integration *inside Notion* — that selection
  **is** the access-scope boundary (the Brain only ever sees shared content).
- **Token storage.** The callback exchanges the code for a **bot token + `workspace_id` + bot id**.
  Store it **encrypted at rest** (AES-GCM via a Worker secret, or Cloudflare Secrets Store) in a new
  `notion_connections { tenant_id, workspace_id, bot_id, token_ciphertext, created_by, created_at,
  revoked_at }` table — keyed so `workspace_id → tenant` (needed to route webhooks). NOTE: this token
  must be **decryptable** (it's used to call Notion), unlike the Obsidian credential which is only
  ever hashed. This is the main new security surface — treat the encryption key like the device-flow
  secret.
- A matching `sources` row (`kind: "notion"`, `config = { workspaceId, rootPageIds[] }`) drives the
  cron poller, mirroring the obsidian source.
- **Disconnect/revoke** clears the connection (and ideally calls Notion token revocation), stopping
  all sync — same UX affordance as revoking a vault credential.

---

## 3. Ingest mapping (onto the existing `runDocIngestCore`)

Each Notion page becomes one Brain document. Map Notion → the existing `DocIngestParams`:

| `runDocIngestCore` field | Notion source |
|---|---|
| `slug` | `notion:<pageId>` — **stable** (Notion page id never changes) → supersede-on-edit, no dupes |
| `fingerprint` | `notion:<pageId>:<last_edited_time>` — mirrors `obsidian:<path>:<etag>`; cron + webhook compute the same value and no-op each other |
| `payloadRef` | stage the converted markdown to an R2 key (e.g. `notion/<pageId>.md`); ingest reads the body from there, exactly like the vault note's R2 key |
| `contentType` | `text/markdown` |
| `path` | derived from the Notion parent chain (workspace → parent page/db → page) → a `/Parent/Child` namespace, like vault folders |
| `tags` | from Notion page **properties** (select / multi-select / status) + the database name |
| `sourceId` | the `notion` source row id |
| `isPhase2` | `true` (stable-slug supersede) |
| `ingestedVia` | `"notion-poll"` or `"notion-event"` |

**Databases:** a Notion database = a collection of pages (rows). Query the database → ingest each row
as a document; the database name becomes a path segment + tag. The database object itself isn't a doc.

**Deletes:** Notion exposes `archived` / `in_trash`. The poller (and the webhook `page.deleted`)
soft-delete the doc by slug + drop its vectors — identical to `runVaultDelete`
(`vault-events/consume.ts`).

---

## 4. Block → markdown conversion (the meaty new part)

The one genuinely new piece of real work. Notion content is a tree of typed **blocks**, fetched via
`GET /blocks/{id}/children` (paginated, recursive). Convert to markdown:

- Straightforward: headings, paragraphs, bulleted/numbered/to-do lists, quotes, code (with language),
  dividers, callouts (→ blockquote), toggles (→ heading + body).
- Structural: nested blocks (recurse children), tables (→ markdown tables), child pages (→ link, and
  ingest the child as its own doc), synced blocks, columns.
- Lossy/links-only: images/files/embeds (keep the URL + caption), database views, relations, mentions.

Options: adapt the well-trodden `notion-to-md` approach, or a focused in-house converter (fewer deps,
Workers-friendly). Fidelity here directly determines search/extraction quality, so it's worth a small
golden-file test suite (sample pages → expected markdown).

---

## 5. Triggers in detail

- **Phase 2 — cron poll (MVP).** Reuse the backfill/source cadence. For each `notion` source: call
  Notion `search` (or per-shared-db `query`) filtered/sorted by `last_edited_time`, page through
  results > `last_sync_at`, convert + stage + `runDocIngestCore`, then advance `last_sync_at` on a
  clean pass. Resumable + idempotent by construction (fingerprint gate). Respect the **~3 req/s**
  Notion limit (throttle; a big page = many child-block requests).
- **Phase 3 — webhooks (real-time).** `/notion/webhook`: (1) handle Notion's one-time
  **verification handshake**; (2) verify the request signature on every event; (3) map `workspace_id →
  tenant`; (4) enqueue a `brain-notion-events` message `{ tenantId, pageId, action }`. A consumer —
  cloned from `vault-events/consume.ts` — fetches that page, converts, stages, and ingests (or
  soft-deletes). Webhooks are the latency win; the cron poll stays as the backstop (same belt-and-
  suspenders as Obsidian's R2-events + importer).

---

## 6. Two-way write-back (optional, Phase 5)

Mirrors Obsidian's `Brain/` folder. `okf_export` already produces markdown + frontmatter; a writer
converts markdown → Notion blocks and **creates/updates a page** under a designated "Brain" parent
page (or database) in the workspace via the Notion API. Loop-avoidance: tag Brain-authored pages (a
property or the parent) and skip them on ingest, exactly like the `vault/Brain/` skip rule. Lower
priority — pull-only is a complete, useful v1.

---

## 7. Isolation

- The Notion **bot token is per-tenant** and decryptable only inside the Worker; every ingested doc
  goes through `ScopedDB`/`ScopedR2` under the tenant — same chokepoints as everything else.
- Webhook routing is by `workspace_id → tenant` from `notion_connections`; an event for an unknown
  workspace is dropped (fail-closed), mirroring `consume.ts`'s `principalFromMessage` re-validation.
- Access scope is **user-controlled in Notion** (only shared pages are visible) — a nice property the
  file path-prefix model doesn't give you.

---

## 8. Phases

1. **Connect (OAuth).** Notion public integration + dashboard **Connect Notion** page + OAuth
   callback + encrypted `notion_connections` + a `notion` `sources` row + disconnect/revoke.
2. **Pull ingest (cron MVP).** Notion API client (throttled) + block→markdown + the cron poller →
   stage to R2 → `runDocIngestCore` (slug/fingerprint/path/tags mapping) + archive→soft-delete.
   *This alone is a working, end-to-end Notion sync.*
3. **Webhooks.** `/notion/webhook` (verify + workspace→tenant) + `brain-notion-events` queue +
   consumer cloned from `vault-events`. Real-time; cron stays as backstop.
4. **Polish.** Database/property mapping, large-workspace pagination + rate-limit hardening, a
   block→markdown golden-file test suite, a dashboard "Notion" status/last-sync panel.
5. **(Optional) Two-way write-back.** `okf_export` → blocks → Notion page, with loop-avoidance.

---

## 9. Risks & honest unknowns

- **Block→markdown fidelity** — the biggest effort; drives extraction quality. Mitigate with golden
  tests against real pages.
- **Notion rate limits (~3 req/s)** — large pages/workspaces fan out into many block requests;
  needs throttling + the cron to spread load. The first full sync of a big workspace is slow.
- **Token storage** — must be reversibly **encrypted** (not hashed); new key-management surface. Plan
  for token revocation/expiry even though Notion bot tokens don't currently expire.
- **Webhook setup** — verification handshake + per-event signature + `workspace_id→tenant` mapping;
  more moving parts than R2 notifications. Cron-poll MVP de-risks this (webhooks are additive).
- **Data-model mismatch** — databases, relations, nested/linked pages, synced blocks don't map 1:1 to
  "a document." Decide scope explicitly (ingest pages + db rows; links-only for relations/embeds).
- **Two-way conflicts** — Notion edits vs Brain write-back; keep v1 **pull-only** to avoid them.

---

## 10. Bottom line

Notion reuses the entire Brain ingest spine (`sources` + `runDocIngestCore` + fingerprint supersede +
soft-delete + the events-queue/consumer pattern). The new surface is a **front door that pulls instead
of receives**: OAuth + an encrypted per-tenant token, a throttled Notion API client, a block→markdown
converter, and a webhook receiver — with a cron-poll MVP that's useful on its own before webhooks land.
Same isolation model, same dashboard onboarding shape (a "Connect Notion" page beside "Vault Sync").

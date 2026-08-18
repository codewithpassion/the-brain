# R2-compatible sync facade — design & feasibility

> **Goal:** let Obsidian (Remotely Save) sync into the Brain **without ever handing a device a
> real R2 bucket credential**. Instead, point the sync client at a Brain-owned Worker that presents
> an S3-compatible (or WebDAV) API, authenticates per-tenant, and proxies into R2 under a *forced*
> `${tenantId}/vault/` prefix.
>
> **Status:** SHIPPED — the WebDAV facade (`/dav/*`), `vault_credentials` ops, dashboard Vault Sync
> page, and inline vault-events ingest hook are all live; this header was stale until 2026-08-18.

---

## 0. Verdict — is it possible?

**Yes, and it's the correct architecture.** Three reasons it's worth building beyond "possible":

1. **Closes the multi-tenant isolation gap.** Today the `${tenantId}/vault/` boundary rests on a
   bucket-scoped R2 token on the device — a token that can read/write *every* tenant's data on the
   shared `the-brain-bodies` bucket. A facade makes the boundary **credential-enforced**: a tenant's
   key is verified by the Worker and can only ever resolve to that tenant's prefix. The real bucket
   name + Cloudflare tokens never leave the Worker.
2. **The Brain becomes the single sync endpoint** — auth, audit, governance, quotas all apply to
   vault writes.
3. **Ingestion triggers inline.** On `PutObject`/`DeleteObject` the Worker can enqueue the
   `brain-vault-events` message itself — no R2 bucket-notification wiring, no at-least-once latency,
   no per-tenant notification-rule cap.

**The one genuinely hard part is S3 SigV4 verification.** WebDAV sidesteps it entirely (HTTP Basic).
That's the load-bearing decision (§3).

Why it's tractable: Remotely Save supports a **custom S3 endpoint** *and* **WebDAV**, so we just
repoint it at our Worker; and R2's binding is already S3-shaped (`get`/`put`/`delete`/`list` +
multipart), so the Worker mostly translates and scopes — it isn't reimplementing storage.

---

## 1. Architecture

```
Obsidian + Remotely Save                 Brain Worker (the facade)               R2 (private)
  ─ S3 SigV4  ─────────────►  ┌───────────────────────────────────┐   binding   ┌──────────────┐
  (or WebDAV Basic)           │ 1. authenticate (per-tenant cred)  │  ─────────► │ the-brain-   │
  endpoint = brain-sync.…     │ 2. accessKey/user → tenantId       │             │  bodies      │
  bucket   = (logical)        │ 3. FORCE key = ${tenantId}/vault/… │             │ ${tid}/vault │
  key      = note.md          │ 4. proxy op → R2 binding           │             └──────────────┘
                              │ 5. on PUT/DELETE → enqueue ingest  │  ──► brain-vault-events queue
                              └───────────────────────────────────┘            (existing Phase-4)
```

The device credential is **not** an R2 token — it's a Brain-issued key the Worker verifies. The
device never learns the bucket name or any Cloudflare secret.

---

## 2. The S3 API subset Remotely Save actually uses

A full S3 implementation is unnecessary — implement only what the client calls:

| Op | Purpose | R2 binding |
|---|---|---|
| `GET /?list-type=2&prefix=…` (ListObjectsV2) | enumerate the vault | `bucket.list({prefix, cursor})` → XML |
| `HEAD /<key>` (HeadObject) | size/etag/mtime check | `bucket.head(key)` |
| `GET /<key>` (GetObject) | download a note | `bucket.get(key)` (stream body) |
| `PUT /<key>` (PutObject) | upload a note | `bucket.put(key, body)` → **enqueue ingest** |
| `DELETE /<key>` (DeleteObject) | delete a note | `bucket.delete(key)` → **enqueue delete** |
| `POST /?delete` (DeleteObjects) | batch delete | loop `bucket.delete` → XML |
| Multipart: `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload` | large attachments | R2 `createMultipartUpload` etc. |

All request/response bodies are **S3 XML** (ListObjectsV2 result, multipart init/complete, error
shapes). These are small, fixed schemas. `OPTIONS` + CORS headers are required for the desktop/mobile
clients.

---

## 3. DECISION — WebDAV (Basic auth). S3/SigV4 NOT needed.

**Obsidian/Remotely Save is the only client.** The single reason to take on S3 + SigV4 — general
S3-tool compatibility (rclone, aws-cli) — does not apply. So we build a **WebDAV facade** and skip
SigV4 entirely.

| | **S3 facade** (rejected) | **WebDAV facade** ✅ |
|---|---|---|
| Auth | **AWS SigV4** — recompute the signature from the canonical request + secret; exact canonicalization, payload-hash modes, chunked signing. The hard part. | **HTTP Basic** (`user:pass` → tenant + hashed-secret compare). Trivial. |
| Protocol vs R2 | 1:1, but only matters if non-Obsidian S3 tools are a goal (they aren't). | `PROPFIND` (list → multistatus XML), `GET`/`PUT`/`DELETE`, `MKCOL`, `OPTIONS`, `HEAD`. The handful Remotely Save calls. |
| Risk | SigV4 byte-exactness vs the plugin's signer. | Low — no signing crypto. |

This is **not a storage service** — it's an authenticated, tenant-scoping WebDAV front door to R2,
just for Obsidian. (An S3 surface could be added later as a parallel route if a non-Obsidian client
ever needs it; explicitly out of scope now.)

---

## 4. Auth & credential model (generated in the dashboard)

- **Generated in the frontend.** A dashboard **"Vault Sync"** page has a "Generate credential" button
  → calls `create_vault_credential` → returns a **username + password shown ONCE** (with copy
  buttons + a "you won't see this again" warning) plus the WebDAV endpoint and Remotely Save setup
  steps. The user pastes username/password/endpoint into Remotely Save (WebDAV mode).
- **Storage:** `vault_credentials { tenant_id, username, secret_hash, label?, created_at, revoked_at }`
  in D1. `username` is a generated id (e.g. `vk_<rand>`) so the org id isn't exposed in the client
  config; `secret_hash` = SHA-256 of the password (reuse `sha256Hex`/`bk_`-key machinery). Lookup is
  `username → tenant_id` (O(1)). The user can list + **revoke** credentials (sets `revoked_at`).
- **Verify (Basic):** decode `Authorization: Basic` → `username` + password → look up the
  credential → SHA-256 the password → constant-time compare to `secret_hash` → resolve `tenant_id`.
- **Scope, always:** the verified credential maps to exactly ONE `tenant_id`. The Worker prepends
  `${tenantId}/vault/` to every key and rejects/normalizes `..`, leading `/`, and absolute keys —
  identical discipline to `ScopedR2`. A forged path can never escape the tenant; the device never
  learns the bucket name or any Cloudflare token.

---

## 5. Ingestion hook (the bonus that drops R2-events)

Because writes now flow *through* the Worker, side effects run in-request:

- `PutObject` / `CompleteMultipartUpload` under `vault/` (not `vault/Brain/`) → enqueue the existing
  `brain-vault-events` create message (or call `runDocIngestCore` for tiny notes). Reliable +
  synchronous; no R2 notification, no event-latency SLA, no per-tenant rule cap.
- `DeleteObject` → enqueue the Phase-2 delete message.
- Skip `vault/Brain/` (write-back loop avoidance) and non-`.md` (attachments stored but not ingested).

This **replaces** Phase 4's `wrangler r2 bucket notification create` step — strictly simpler and more
reliable.

---

## 6. Hard parts & risks (be honest)

- **SigV4 byte-exactness** (S3 path only). Canonicalization must match Remotely Save's signer
  exactly. *Mitigation:* test against the real plugin from day one; capture a real signed request and
  unit-test the verifier against it. WebDAV avoids this risk entirely.
- **Multipart / large attachments.** Markdown is single-PUT, but vault images/PDFs may exceed the
  Worker request-body limit and need multipart (R2 binding supports it). v1 can cap file size and
  reject multipart (notes still sync); add multipart in a follow-up.
- **Streaming bodies.** Stream PUT bodies straight to R2 (`bucket.put(key, request.body)`) to avoid
  buffering large files in the Worker.
- **ETag / conflict semantics.** Remotely Save compares mtime/etag to detect changes; return R2's
  etag + a stable `Last-Modified`. Simultaneous multi-device edits still produce a conflict copy
  (file-level), same as direct-R2 today.
- **CORS / mobile.** Set permissive-but-scoped CORS; verify Remotely Save's preflight on iOS/Android.
- **Latency / cost.** One extra Worker hop per file op + Worker invocations. Negligible for a text
  vault; watch Class-A (PUT) volume on very frequent full-vault pushes.
- **Custom domain.** Front it on e.g. `https://brain-sync.<domain>/` (or a route on `brain-api`) so
  Remotely Save's endpoint config is clean.

---

## 7. Build (this is the whole thing — no optional S3)

Mounted as a `/dav/*` route family on **brain-api** (reuses its D1, the `the-brain-bodies` R2 binding,
and the `brain-vault-events` queue) — exempted from the Clerk/bearer principal middleware since it
does its own Basic auth. Endpoint: `https://brain-api.…/dav`.

1. **Credentials:** `vault_credentials` migration + `create_vault_credential` / `list_vault_credentials`
   / `revoke_vault_credential` ops (Basic-auth secrets, hashed). Dashboard **Vault Sync** page to
   generate (show-once) / list / revoke + setup instructions.
2. **WebDAV verbs** under `/dav/*`: `OPTIONS`, `PROPFIND` (Depth 0/1 → multistatus XML), `GET`, `HEAD`,
   `PUT`, `DELETE`, `MKCOL` — Basic auth → tenant → force `${tenantId}/vault/<relpath>` → R2 binding.
3. **Inline ingest hook:** `PUT`/`DELETE` outside `vault/Brain/` enqueue the existing Phase-4
   `brain-vault-events` message → **retires the `wrangler r2 bucket notification` step.**
4. **E2E:** generate a credential in the dashboard (Chrome) → WebDAV `PUT`/`PROPFIND`/`GET`/`DELETE`
   with that Basic cred → confirm the note ingests (shows up in `/documents`) and is tenant-scoped.

Attachments: markdown is single-PUT; v1 caps file size (notes always sync). Multipart for large
binaries is a later add, not needed for the core.

---

## 8. Bottom line

A small, security-critical `/dav/*` front door on brain-api: Basic auth against dashboard-generated
per-tenant credentials, every path forced under `${tenantId}/vault/`, proxying R2, and enqueuing
ingest on write. It gives real per-tenant isolation with **no exposed bucket and no R2-event wiring** —
and the credential is minted from the dashboard so connecting Obsidian is copy-paste.

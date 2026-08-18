# The Brain — gap analysis: docs vs implementation (2026-08-18)

> Sources compared: all plans in `docs/` (v2/v3 implementation + execution plans, editor decision,
> W6 collab design, OKF/R2-facade/Notion/Obsidian/dashboard-memory plans), `IMPLEMENTATION_PLAN.md`,
> and the codebase at `b54c0e8`. Successor to `docs/gap-analysis.md` (2026-07-02).

## Verdict (TL;DR)

**The docs are fulfilled almost completely — and in places exceeded.** v1 was already complete at
the last gap analysis. Since then, the entire v2 plan (dream engine D1–D5, snapshots + hook kit,
add_thought, voice upload, **Notion integration — despite its plan doc still saying "no code yet"**,
and the W4 retrieval/graph polish including the mutating graph ops) and v3 W1–W5 (first-class
pages, entity/idea pages, backing-document search, view + edit modes with TipTap, quick-switcher,
indexes, OKF bundles, CLI wiki import) are all implemented, with the canary/test culture intact
(~90 test files, drift-guarded surfaces, isolation canaries).

**Committed-but-unbuilt items:**

| Gap | Spec source | Status |
|---|---|---|
| **G1 — Wiki image upload** | v3 W4.3 / execution Phase 5: "image upload (R2 via the existing body store)" | **Not built anywhere** — no editor upload, no media API route, no MCP tool. The spec also never designed the serving/auth half. → **being implemented now** |
| **G2 — W6 realtime collab** | v3 W6 + `v3-w6-collab-design.md` | Not built (zero Yjs/WS/DO-room code). Design doc is ready; gated on the TanStack-Start WS passthrough spike + security review. **Deliberately excluded from this run.** |
| **G3 — CI + real-AI gates** | v2 W0.1–W0.3 (deferred 2026-07-02) | Still deferred; no `.github/`, 3 `test.todo` real-AI gates remain. |
| **G4 — Gmail/GitHub importers** | v2 W3.4 ("later, do last") | Not built. Notion, ChatGPT, Claude-Code, Obsidian importers exist. |

Everything else the docs mark deferred/out-of-scope (shard fan-out, S3 facade, Notion write-back,
comments/reactions/share links, y-indexeddb, multi-author attribution, …) remains deferred by design.

**Stale doc headers** (fix opportunistically): `r2-facade-plan.md` and `notion-integration-plan.md`
both say "no code yet" — both are fully shipped.

## UX defects reported 2026-08-18 (this run's scope)

1. **Deep links don't expand the sidebar tree.** `WikiSidebar.tsx:75` uses uncontrolled
   `<details open={depth < 1}>` — no route awareness, no expansion state at all. Ancestors of the
   active page stay collapsed. → controlled expansion seeded from the route splat.
2. **Tree node design makes sub-pages easy to miss.** 12px/level indent, text `▸` chevron,
   no folder/page icons, no indent guides, leaves lack the chevron spacer so labels misalign,
   namespaces never get an active state. → redesign.
3. **Folder click → "page not found".** Fixed on main by `b54c0e8` (namespace landing view in the
   route loader — covers deep links too), but the deployed dashboard is likely stale (bare
   `wrangler deploy` ships stale `dist/`; must `bun run deploy`). Residual gaps being fixed:
   slug-less namespace nodes aren't navigable; drafts lack badges in the landing view.
4. **Image upload (G1)** — dashboard editor (paste/drop/slash) **and** MCP (`wiki_upload_image`).

### Image pipeline design (v1 decisions)

- Bytes at `wiki/media/<uuid>.<ext>` under `ScopedR2` in `BODIES`; contentType in httpMetadata;
  `MAX_BODY_BYTES` cap; **no D1 media table** (list/GC deferred, matches vault-lane precedent).
- API: `POST /wiki/media` (raw bytes + `x-filename`, image/* whitelist) and bearer-authed
  `GET /wiki/media/:id`. New tenant-boundary surface → ships with an isolation canary.
- Stored markdown carries stable root-relative `/wiki-media/<id>` (react-markdown default
  urlTransform permits root-relative; never bake API-origin or expiring URLs into bodies).
- Dashboard serves `/wiki-media/<id>` via a server route: Clerk cookie → `resolveBrainAuth` →
  `BRAIN_API` binding → stream. If TanStack Start server routes can't stream on Workers
  (unverified — spike first), fallback: `img` override in `Markdown.tsx` fetching base64 via a
  server fn.
- ACL simplification (v1): media is tenant-member-scoped, **not** page-visibility-scoped.
- MCP: `wiki_upload_image` op (base64 + filename + alt → `![alt](/wiki-media/<id>)` snippet),
  surfaces mcp+rest; MCP guide updated.

### Known limitations carried forward (not this run)

- Sidebar + namespace landing truncate at the 500-row listing cap.
- Media has no listing/GC/orphan-sweep and no page-visibility ACL.
- W6, CI (W0.1–0.3), Gmail/GitHub importers — see G2–G4.

### Implementation outcome (G1 shipped 2026-08-18)

- **Serving path chosen: TanStack Start server route** (NOT the AuthImage fallback). The installed
  `@tanstack/react-start` (1.168) DOES support server routes via `createFileRoute(...)({ server: {
  handlers: { GET } } })` returning a streamed `Response`; a handler-only route is pruned from the
  client bundle (`pruneServerOnlySubtrees`), so `apps/dashboard/src/routes/wiki-media.$id.tsx` keeps
  its `cloudflare:workers` + Clerk imports server-only. It authenticates via the same `resolveBrainAuth`
  machinery and streams `GET /wiki/media/:id` over the `BRAIN_API` binding. This serves the same
  `/wiki-media/<id>` URL in BOTH the react-markdown view and the TipTap editor `<img>`, so
  `Markdown.tsx` needed no `img` override.
- **Upload rides the op only.** `wiki_upload_image` (mcp+rest) is the single write path (base64 in);
  there is no hand-written `POST /wiki/media` — only the hand-written bearer-authed `GET`. R2-only, so
  (like `vault_writeback`) it takes no in-batch D1 audit.
- **Editor:** `@tiptap/extension-image` (which round-trips `![alt](src)` natively) + paste/drop
  handlers + a slash-menu "Image" command, uploading via the `wikiUploadImage` server fn.

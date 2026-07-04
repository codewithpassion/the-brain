# W6 — realtime collaborative wiki (Yjs on a WikiRoom DO): recon map + design notes

Last v3 phase. Security-sensitive (WS/DO auth, room isolation). DESIGN THIS FRESH — not deep in a long
session. HEAD at recon = 367ae5c. Peer implementer: wiki-w1.

## ⚠️ DO THIS FIRST — the spike that gates the whole architecture
The recommended design (below) assumes **TanStack Start's server-entry preserves the Cloudflare
`webSocket` property on a passthrough 101 Response** (dashboard forwards the WS upgrade to the api
worker over the `BRAIN_API` service binding). This is UNVALIDATED. Before pinning/briefing anything:
- Spike: a TanStack server route (`apps/dashboard/src/routes/ws.wiki.$.ts`) that returns
  `env.BRAIN_API.fetch(upgradeRequest)`; a trivial `/ws/...` handler in apps/api that does
  `new WebSocketPair()` + `ctx.acceptWebSocket`/`server.accept()` and echoes. Connect a browser WS to
  the dashboard origin and confirm the 101 + frames survive the passthrough.
- If the `webSocket` property is STRIPPED → the design changes: replace the dashboard `main`
  (`@tanstack/react-start/server-entry`, wrangler.jsonc:10) with a small custom worker entry that
  intercepts `/ws/wiki/*` and delegates everything else to the react-start entry. Don't design around
  the guess — get the fact first.

## Architecture (recommended, pending the spike)
- **WikiRoom DO lives in `apps/api`** (sole owner of DO infra + migrations + resolvePrincipal). Class
  `apps/api/src/wiki-room/room.ts`; `export { WikiRoom }` from apps/api/src/index.ts (mirror :895);
  binding `{name:"WIKI_ROOM", class_name:"WikiRoom"}` + DO migration tag
  `{tag:"v2", new_sqlite_classes:["WikiRoom"]}` at apps/api/wrangler.jsonc:181,183. Purpose-built
  HIBERNATION DO (`this.ctx.acceptWebSocket(server)` + webSocketMessage/webSocketClose) so idle rooms
  don't bill wall-clock. NO Drizzle migration (DO-internal SQLite is runtime; highest D1 migration is
  still 0013 and unrelated).
- **Token transport — dashboard-forward (the ONLY path that reuses Clerk auth unchanged).**
  `resolvePrincipal` (packages/db/src/auth/resolve.ts:82,88) is `Authorization: Bearer`-ONLY, and a
  browser can't set that header on a WS handshake. So: browser opens SAME-ORIGIN WS to the dashboard
  `/ws/wiki/:slug` → dashboard `resolveBrainAuth()` (apps/dashboard/src/server/brain.ts:78) resolves
  Clerk from the cookie → **runs the visibility check** → forwards the upgrade to
  `env.BRAIN_API.fetch(req)` INJECTING `Authorization: Bearer <token>` + `X-Brain-Tenant` (exactly as
  `authFetch`, brain.ts:47-60). `resolvePrincipal` in api then works unchanged; the DO gets the
  resolved Principal as edge-injected `props` (BrainMCP discipline, agent.ts:52-89). Direct
  browser→api WS is the FALLBACK only (needs a subprotocol/query-param token shim + a resolvePrincipal
  change, and leaks the raw JWT to browser JS — avoid).

## Isolation spine (the triad — this is the security crux)
1. **Fail-closed gate BEFORE `acceptWebSocket`.** New Hono route in apps/api (sibling to `mountMcp`,
   apps/api/src/mcp/routes.ts pattern): resolvePrincipal → visibility check → refuse (403, socket never
   accepted) when the page isn't visible. Reuse `WikiStore.getPage(slug)` (store.ts:382, returns null
   when not visible) OR expose `WikiStore.assertCanEdit` (store.ts:153, currently PRIVATE — make
   public / add `canEdit(slug)`). EDITING additionally requires `!principal.readOnly` + the
   wiki-provenance guard (store.ts:144). **Multi-user discipline (the recurring lesson): the room is
   SHARED across principals — every joiner gets an INDEPENDENT visibility gate; BrainMCP's
   "isolation rests on per-call D1 re-check" does NOT transfer to a shared room.**
2. **DO id keyed by `(tenantId, slug)`** so cross-tenant rooms can never collide.
3. **Flush through PageStore**, which force-stamps `tenant_id` (pages/store.ts:493,539).

## Flush (DO hot cache → PageStore revisions; PageStore stays source of truth)
- Reuse `WikiStore.savePage` → `PageStore.upsert` (store.ts:170 / pages/store.ts:455) on an
  alarm + on-idle trigger in the DO, so link/tag reconcile + audit + backing-doc stay identical.
- `upsert` THROWS on `principal.readOnly` (store.ts:456) and hard-codes ONE author per revision
  (`authorUserId = this.p.userId`, store.ts:493/569). → flush under a dedicated non-readonly
  system/collab principal (or attribute to the flush-triggering editor).
- **FORWARD FLAG — do NOT build multi-author attribution (scope creep).** The recon calls per-editor
  credit a "hard fork" (revisions have no multi-author field). v1 acceptance is "one flushed revision
  WITH attribution" — attribute to the flusher / last-editor; record the participant set in the
  revision `reason` if cheap. Defer true multi-author.
- Search re-index rides existing `backgroundSync`→`syncBackingDoc` (catalog.ts:452-468); the
  tier-salted skip-unchanged fingerprint (backing-doc.ts:83) makes an unchanged flush a no-op → bounds
  re-ingest churn from frequent flushes.
- **Anti-loop: NO new loop.** `wiki` is deliberately absent from AGENT_PAGE_PROVENANCE
  (predicates.ts:139) — collab-authored wiki revisions are legit human input, exactly like today's
  human saves. Only new pressure is flush CADENCE → re-ingest frequency (already gated by fingerprint).

## Editor (client, lazy)
- Replace `content: markdown` in apps/dashboard/src/components/editor/Editor.tsx:33 with a shared
  `Y.Doc` + y-prosemirror (`Collaboration` + `CollaborationCursor`); keep the lazy/client-only chunk
  (never in SSR). WikiEditor's per-save `wikiSavePage` gives way to the room + periodic flush.
- New deps (client): `yjs`, `y-prosemirror`, `@tiptap/extension-collaboration(-cursor)`. None present
  today (confirmed). Watch the client bundle (W4a measured it; editor is already code-split).

## Acceptance (plan Phase 7)
Two Clerk users of one tenant edit one page → live cursors, converged body, ONE flushed revision in
history with attribution; a user lacking page visibility is REFUSED the room (fail-closed); DO restart
loses no committed revision. Review: full + SECURITY (WS/DO auth, room isolation) + isolation.

## Build order (after the spike passes)
1. Spike the TanStack WS passthrough (above) — decides worker-entry shape.
2. WikiRoom DO (hibernation, Yjs update-log/snapshot in DO SQLite) + binding + migration tag.
3. Pre-upgrade auth+visibility gate (api Hono route) — fail-closed; expose assertCanEdit.
4. Dashboard WS forward route (auth on dashboard, inject Bearer, forward to BRAIN_API).
5. Flush (alarm + on-idle → WikiStore.savePage as a system/collab principal).
6. Editor y-prosemirror + cursors/presence.
7. Single-editor optimistic-lock as the DEGRADED mode when the DO/WS is unreachable.
Canaries: room isolation (cross-tenant/cross-visibility refusal), no-revision-loss on DO restart,
flush idempotency. Security review before deploy/commit.

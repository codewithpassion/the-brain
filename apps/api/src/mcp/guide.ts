/**
 * Agent-facing documentation for the Brain MCP server.
 *
 * `BRAIN_INSTRUCTIONS` is returned in the MCP `initialize` response (`ServerOptions.instructions`)
 * and injected into the connecting agent's context — the always-on operating manual. Keep it tight.
 *
 * `BRAIN_GUIDE` is the full manual, served on demand as the `brain://guide` resource so a curious
 * agent can fetch depth without paying for it every turn.
 */

/** Always-on operating manual (MCP `initialize.instructions`). Keep dense + actionable. */
export const BRAIN_INSTRUCTIONS = `The Brain is your persistent memory. Every tool is tenant-scoped automatically — you only ever see your own data, and writes are confined to your tenant.

FIVE MEMORY LAYERS, addressed differently:
• Content (semantic) — ingest_document stores docs/notes; search returns matching passages; think returns a synthesized, cited answer. Use for "what do the documents say?".
• Facts (hot memory) — discrete things known about the user/world, newest-first with confidence. recall to read ("what do I know about X?"); forget_fact to retract. Mostly captured automatically from sessions.
• Agent memory (addressable) — memory_set/get/list: durable items you write deliberately and re-read VERBATIM by a slug path (e.g. agent/planner/prefs). Versioned (memory_history + forward-only memory_rollback); memory_forget soft-deletes. Use for preferences, decisions, standing instructions.
• Graph (relations) — entities + typed links. traverse_graph / get_links / get_backlinks to explore how things connect.
• Sessions (episodic) — capture_turn records a turn; get_session_context returns recent turns + visible facts + memory to start work.

CHOOSING A TOOL:
- Remember a preference/decision/instruction verbatim → memory_set (NOT ingest_document).
- Store reference content to find later → ingest_document.
- Quick one-liner capture (a passing thought, no title/path) → add_thought.
- "What do I know about X?" → recall and/or traverse_graph.
- "What do the documents say about X?" → think (answer) or search (passages).
- Beginning a task → get_session_context.

CONVENTIONS:
- slug = a stable path id; slashes allowed (agent/<area>/<topic>); it is the key across versions.
- memory items need a non-empty type (OKF): preference | decision | note | ...
- visibility: world (whole tenant) | team | private (you only).
- read results include a \`url\` deep link into the dashboard; share it when a human will want to open the item.
- memory_set no-ops when unchanged and appends a version on change; forget_* is a soft delete; memory_rollback takes the revisionId from memory_history (not the version number).

For the full manual read the brain://guide resource; for the tool catalog grouped by purpose read brain://ops.`

/** Full manual served as the `brain://guide` resource (text/markdown). */
export const BRAIN_GUIDE = `# The Brain — agent guide

The Brain is a persistent, multi-tenant memory platform. You reach it over MCP; every tool runs
**tenant-scoped** — you cannot see or write another tenant's data, and you never pass a tenant id.

## The five layers (and how you address each)

| Layer | Read with | Write with | Use when |
|---|---|---|---|
| **Content** (semantic) | \`search\` (passages), \`think\` (cited answer) | \`ingest_document\` | you want what *the documents* say |
| **Facts** (hot memory) | \`recall\` | (auto from sessions), \`forget_fact\` to retract | "what do I know about X / the user" |
| **Agent memory** (addressable) | \`memory_get\`, \`memory_list\` | \`memory_set\`, \`memory_rollback\`, \`memory_forget\` | a preference/decision/instruction to recall verbatim |
| **Wiki** (linked knowledge) | \`wiki_get_page\` (start at \`index\`), \`wiki_list_pages\`, \`get_backlinks\` | \`wiki_save_page\` | durable, explained knowledge you \`[[link]]\` and browse |
| **Graph** (relations) | \`traverse_graph\`, \`get_links\`, \`get_backlinks\` | (derived from ingest) | how entities connect |
| **Sessions** (episodic) | \`get_session_context\` | \`capture_turn\`, \`finalize_session\` | start/record a conversation |

The distinction that matters most: **memory vs content vs facts.**
- **memory_set** = something you wrote on purpose and will re-read *exactly* (it is markdown + frontmatter, addressed by slug). It is **not** searched semantically — you load it by path.
- **ingest_document** = reference content you'll later find by *meaning* (chunked + embedded → search/think).
- **facts** = small, time-stamped things learned in passing; you *recall* them, you don't address them.

## Agent memory in depth

- **Identity:** a memory item is keyed by its \`slug\`, a stable path like \`agent/planner/prefs\`
  (slashes allowed). The slug never changes across edits.
- **Shape:** \`type\` (required, OKF — e.g. \`preference\`, \`decision\`, \`note\`), optional \`title\`/\`tags\`,
  and a markdown \`body\`. \`visibility\`: \`world\` | \`team\` | \`private\`.
- **Versioning:** \`memory_set\` appends a new version on change and **no-ops when unchanged**.
  \`memory_history\` lists versions (each has a \`revisionId\`); \`memory_rollback\` takes that
  \`revisionId\` (NOT the version number) and appends the old content as a new version (forward-only —
  history is never rewritten). \`memory_forget\` soft-deletes; the history is retained.
- **Bulk interchange:** \`okf_export\` / \`okf_import\` round-trip the whole memory as an OKF bundle.

## The wiki (durable, linked knowledge)

The wiki is the same \`pages\` layer as memory, but browsable and interlinked — entities and ideas
each get a real page, connected by \`[[wikilinks]]\` + backlinks. Read: \`wiki_get_page\`,
\`wiki_list_pages\`, \`get_backlinks\`. Write: \`wiki_save_page\`.

- **Save durable learnings as pages.** When you work something out that is reusable beyond this
  conversation — how a system fits together, a decision and its rationale, a concept worth a
  canonical explanation — \`wiki_save_page\` it and \`[[link]]\` the related concepts. (Verbatim
  preferences/instructions still go to \`memory_set\`; the wiki is for explained, linked knowledge.)
- **Progressive disclosure — don't list everything.** Auto-maintained \`index\` pages give you two
  layers: \`wiki_get_page('index')\` is the root (namespaces + top-level pages); each \`<ns>/index\`
  lists that section. Read the index, then drill into the pages you need — cheaper than
  \`wiki_list_pages\` over a large wiki.
- **Entity/idea pages are agent-maintained.** The dream engine keeps \`entities/<kind>/<name>\` pages
  and idea pages current; you can read and extend them like any page.
- **Images:** \`wiki_upload_image\` (png/jpeg/gif/webp, base64) stores an image and returns a
  \`![alt](/wiki-media/<id>)\` snippet — embed that returned markdown in a \`wiki_save_page\` body to
  display the image on the page.
- **Sharing:** \`wiki_export_bundle\` packages a namespace as an OKF bundle (zip); \`wiki_import_bundle\`
  ingests one under \`imported/<namespace>/…\` as **private drafts, kept out of search** until a human
  reviews + publishes them (imported content is untrusted).

## Facts & sessions

- **recall** reads facts newest-first; filter by \`entitySlug\`, \`since\`, \`sessionId\`, or
  \`grep\`/\`query\`. Use it for "what do I know about X?".
- **forget_fact** soft-expires a fact by \`factId\` (lineage preserved).
- At the start of a task, **get_session_context** returns recent turns + visible facts + the tenant's
  auto-refreshed **session-context snapshot** (\`contextSnapshot\`: standing instructions + latest
  digest + notable facts) (+ optional memory by path) so you resume with the right context.
  \`get_context_snapshot\` returns just that snapshot markdown (what the SessionStart hook injects).

## Conventions & gotchas

- You never pass a tenant — isolation is automatic.
- \`visibility\` defaults to **private** (you only). Set \`world\` to share across the tenant.
- Writes that fail validation return a structured error naming the field — fix and retry.
- Read tools are always available; write/admin tools appear only when your credential holds the
  capability.
- External sources sync IN automatically: an Obsidian vault (WebDAV) and a connected Notion
  workspace (\`connect_notion\`) flow their pages through the same ingest pipeline — you \`search\`/
  \`think\` over them like any other content; no per-source tool needed.

## A typical flow

1. \`get_session_context\` → orient.
2. \`recall\` / \`think\` / \`traverse_graph\` → gather what's known.
3. Do the work; \`capture_turn\` records the conversation.
4. \`memory_set\` to persist a durable preference/decision; \`ingest_document\` to store new content.

See **brain://ops** for every tool grouped by purpose.`

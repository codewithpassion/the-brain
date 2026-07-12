/**
 * CLI command grouping — PRESENTATION ONLY (PRD §9 "group by surface"). Commands are generated flat
 * (one per `"cli"` op, command name === op name) so the drift proof is a trivial set-equality and a
 * command can never become unreachable; this map only decides which `--help` heading a command
 * appears under. The `groups.test` asserts every `"cli"` spec has a group here, so a NEW op surfaces
 * as a (loud) test failure rather than silently landing in a catch-all.
 *
 * `doc` / `source` / `backfill` are intentionally absent: those are REST-only surfaces (chunked
 * upload, backfill runs) with NO op-registry entry, so they emit no generated command (documented
 * deferral — they are not tRPC procedures).
 */

/** Help-section order (only sections with at least one generated command are rendered). */
export const GROUP_ORDER = ["search", "graph", "wiki", "session", "facts", "key", "admin"] as const

export type Group = (typeof GROUP_ORDER)[number]

const GROUP_BY_OP: Record<string, Group> = {
  // search / content
  search: "search",
  query: "search",
  think: "search",
  list_documents: "search",
  ingest_document: "search",
  add_thought: "search",
  get_document: "search",
  update_document: "search",
  delete_document: "search",
  reprocess_document: "search",
  propose_corrections: "search",
  apply_corrections: "search",
  // graph
  traverse_graph: "graph",
  get_links: "graph",
  get_backlinks: "graph",
  get_tags: "graph",
  get_timeline: "graph",
  list_entities: "graph",
  list_entity_edges: "graph",
  find_orphans: "graph",
  search_entities: "graph",
  add_link: "graph",
  add_tag: "graph",
  add_timeline_entry: "graph",
  // wiki (first-class pages)
  wiki_save_page: "wiki",
  wiki_get_page: "wiki",
  wiki_page_history: "wiki",
  wiki_list_pages: "wiki",
  wiki_export_bundle: "wiki",
  wiki_import_bundle: "wiki",
  wiki_move_page: "wiki",
  wiki_delete_page: "wiki",
  // session
  capture_turn: "session",
  finalize_session: "session",
  get_session_context: "session",
  list_sessions: "session",
  create_snapshot: "session",
  list_snapshots: "session",
  get_context_snapshot: "session",
  // facts / governed memory
  recall: "facts",
  forget_fact: "facts",
  revive_fact: "facts",
  memory_review: "facts",
  list_pending_reviews: "facts",
  resolve_contradiction: "facts",
  memory_set: "facts",
  memory_get: "facts",
  memory_list: "facts",
  memory_history: "facts",
  memory_rollback: "facts",
  memory_forget: "facts",
  okf_export: "facts",
  okf_import: "facts",
  // key (API-key minting)
  mint_api_key: "key",
  // admin / governance
  get_token_spend: "admin",
  memberships: "admin",
  break_glass_read: "admin",
  audit_export: "admin",
  list_audit: "admin",
  list_backfill_runs: "admin",
  dream_now: "admin",
  list_dream_runs: "admin",
  get_stats: "admin",
  vault_writeback: "admin",
  create_vault_credential: "admin",
  list_vault_credentials: "admin",
  revoke_vault_credential: "admin",
  connect_notion: "admin",
  confirm_notion_connection: "admin",
  list_notion_connections: "admin",
  disconnect_notion: "admin",
}

/** The help group an op belongs to, or `undefined` if unmapped (a new op — caught by the test). */
export const groupForOp = (name: string): Group | undefined => GROUP_BY_OP[name]

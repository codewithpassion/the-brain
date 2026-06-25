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
export const GROUP_ORDER = ["search", "graph", "session", "facts", "key", "admin"] as const

export type Group = (typeof GROUP_ORDER)[number]

const GROUP_BY_OP: Record<string, Group> = {
  // search / content
  search: "search",
  query: "search",
  think: "search",
  list_documents: "search",
  // graph
  traverse_graph: "graph",
  get_links: "graph",
  get_backlinks: "graph",
  get_tags: "graph",
  get_timeline: "graph",
  list_entities: "graph",
  find_orphans: "graph",
  search_entities: "graph",
  // session
  capture_turn: "session",
  finalize_session: "session",
  get_session_context: "session",
  list_sessions: "session",
  // facts / governed memory
  recall: "facts",
  forget_fact: "facts",
  memory_review: "facts",
  // key (API-key minting)
  mint_api_key: "key",
  // admin / governance
  get_token_spend: "admin",
  memberships: "admin",
  break_glass_read: "admin",
  audit_export: "admin",
  list_audit: "admin",
  list_backfill_runs: "admin",
  get_stats: "admin",
}

/** The help group an op belongs to, or `undefined` if unmapped (a new op — caught by the test). */
export const groupForOp = (name: string): Group | undefined => GROUP_BY_OP[name]

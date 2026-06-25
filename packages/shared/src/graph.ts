/**
 * Graph contracts for The Brain's TWO-graph model (PRD §6).
 *
 * There is no single polymorphic nodes/edges table: a document/page link graph
 * (`pages` / `doc_links`) and an extracted knowledge graph (`entities` /
 * `entity_relations`) are joined only by an `entity_mentions` bridge. The ONE
 * generalization made is an edge-table-agnostic BFS parameterized by an
 * `EdgeSpec`, so a single traversal engine walks both graphs.
 */

/** What the BFS yields, regardless of which graph (PRD §6). */
export interface GraphNode {
  id: string
  /** `pages.title` | `entities.canonical_name`. */
  label: string
  /** `pages.type` | `entities.kind`. */
  type: string
  depth: number
  links: { to_id: string; link_type: string }[]
}

/** A single traversal edge with provenance (PRD §6). */
export interface GraphPath {
  from_id: string
  to_id: string
  link_type: string
  context: string
  confidence?: number
  depth: number
}

/**
 * The parameterization that makes one BFS serve both graphs (PRD §6.4).
 *
 * The gate columns describe the intra-tenant access tier carried on the NODE
 * rows (§6.0 / §7.5): when present, `traverse()` ANDs `scopePredicate` +
 * `visibilityPredicate` onto both JOIN endpoints, generically. Both node tables
 * carry scope/visibility/team; only `pages` carries `user_id` (the private
 * tier), and only `pages` is soft-deletable — so `userCol`/`softDeleteCol` are
 * doc-graph-only and OMITTED (never set to `undefined`) for the entity graph.
 */
export interface EdgeSpec {
  nodeTable: "pages" | "entities"
  edgeTable: "doc_links" | "entity_relations"
  /** `'from_id'` | `'from_entity_id'`. */
  fromCol: string
  /** `'to_id'` | `'to_entity_id'`. */
  toCol: string
  /** `'title'` | `'canonical_name'`. */
  labelCol: string
  /** `'type'` | `'kind'`. */
  typeCol: string
  /** `'deleted_at'` — pages only. */
  softDeleteCol?: string
  /** `'scope'` — both node tables. */
  scopeCol?: string
  /** `'visibility'` — both node tables. */
  visibilityCol?: string
  /** `'team_id'` — both node tables. */
  teamCol?: string
  /** `'user_id'` — pages only (private tier). */
  userCol?: string
}

/** Document/page link graph: `pages` nodes over `doc_links` edges (PRD §6.1). */
export const DOC_GRAPH = {
  nodeTable: "pages",
  edgeTable: "doc_links",
  fromCol: "from_id",
  toCol: "to_id",
  labelCol: "title",
  typeCol: "type",
  softDeleteCol: "deleted_at",
  scopeCol: "scope",
  visibilityCol: "visibility",
  teamCol: "team_id",
  userCol: "user_id",
} as const satisfies EdgeSpec

/**
 * Knowledge graph: `entities` nodes over `entity_relations` edges (PRD §6.1).
 * `scopeCol` IS set (entities are partitioned by scope in the dedup key). No
 * `userCol` (the KG node space is `{world, team}` only) and no `softDeleteCol`.
 */
export const ENTITY_GRAPH = {
  nodeTable: "entities",
  edgeTable: "entity_relations",
  fromCol: "from_entity_id",
  toCol: "to_entity_id",
  labelCol: "canonical_name",
  typeCol: "kind",
  scopeCol: "scope",
  visibilityCol: "visibility",
  teamCol: "team_id",
} as const satisfies EdgeSpec

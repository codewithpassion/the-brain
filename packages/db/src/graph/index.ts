/**
 * `@brain/db` graph sub-barrel (Phase 4) — generalized BFS traversal, entity vector/keyword
 * search, the typed-link/tag/timeline/orphan reads, and the op registry. Re-exported once
 * from the package root barrel (`src/index.ts`).
 */
export type {
  EntityHit,
  EntitySearchDeps,
  EntitySearchOptions,
} from "./entities"
export { searchEntities } from "./entities"
export type { BoundOp as GraphBoundOp, GraphOpContext, GraphOpDeps } from "./ops"
export {
  FIND_ORPHANS_OP,
  GET_BACKLINKS_OP,
  GET_LINKS_OP,
  GET_TAGS_OP,
  GET_TIMELINE_OP,
  GRAPH_OPS,
  LIST_ENTITIES_OP,
  registerGraphOps,
  SEARCH_ENTITIES_OP,
  TRAVERSE_OP,
} from "./ops"
export type {
  DocLinkRow,
  EntityRow,
  EntityTier,
  ExtractedEntityInput,
  ExtractedRelationInput,
  ExtractionChunk,
  OrphanReport,
  TimelineRow,
  TraverseOptions,
} from "./scoped-graph"
export { mergeVisibility, ScopedGraph } from "./scoped-graph"

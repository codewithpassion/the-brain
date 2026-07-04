/**
 * `@brain/db` wiki sub-barrel (v3/W1) — first-class wiki pages on the shared `pages` layer:
 * the `WikiStore` chokepoint, the `wiki_*` op contracts + their coordination fns.
 */

export type {
  EntityForPage,
  EntityRelationSection,
  EntitySections,
  MintOrUpdateResult,
} from "./entity-pages"
export { EntityPageStore, entityPageSlug } from "./entity-pages"
export { mintInsightPage } from "./insight-pages"
export {
  deleteWikiPage,
  exportWikiBundle,
  getWikiPage,
  getWikiPageHistory,
  listWikiPages,
  moveWikiPage,
  registerWikiOps,
  saveWikiPage,
  WIKI_DELETE_PAGE_OP,
  WIKI_EXPORT_BUNDLE_OP,
  WIKI_GET_PAGE_OP,
  WIKI_LIST_PAGES_OP,
  WIKI_MOVE_PAGE_OP,
  WIKI_OPS,
  WIKI_PAGE_HISTORY_OP,
  WIKI_SAVE_PAGE_OP,
} from "./ops"
export type {
  WikiListEntry,
  WikiMoveResult,
  WikiPageDetail,
  WikiPageHistory,
  WikiSavePageInput,
  WikiSavePageResult,
} from "./store"
export { WikiStore } from "./store"

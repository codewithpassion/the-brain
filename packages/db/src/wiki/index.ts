/**
 * `@brain/db` wiki sub-barrel (v3/W1) — first-class wiki pages on the shared `pages` layer:
 * the `WikiStore` chokepoint, the `wiki_*` op contracts + their coordination fns.
 */
export {
  deleteWikiPage,
  getWikiPage,
  listWikiPages,
  moveWikiPage,
  registerWikiOps,
  saveWikiPage,
  WIKI_DELETE_PAGE_OP,
  WIKI_GET_PAGE_OP,
  WIKI_LIST_PAGES_OP,
  WIKI_MOVE_PAGE_OP,
  WIKI_OPS,
  WIKI_SAVE_PAGE_OP,
} from "./ops"
export type {
  WikiListEntry,
  WikiMoveResult,
  WikiPageDetail,
  WikiSavePageInput,
  WikiSavePageResult,
} from "./store"
export { WikiStore } from "./store"

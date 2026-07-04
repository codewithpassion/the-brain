/**
 * `@brain/db` pages sub-barrel (v3/W1) — the shared page-CRUD core (`PageStore`) that both
 * agent memory (`MemoryStore`) and the wiki (`WikiStore`) drive, plus the pure helpers
 * (`contentHash`/`parseFrontmatter`/`extractLinkSlugs`) reused across the page layer.
 */
export type {
  ExistingPageRow,
  PageRevisionSummary,
  PageRow,
  PageUpsertInput,
  PageUpsertResult,
} from "./store"
export { contentHash, PageStore, parseFrontmatter } from "./store"

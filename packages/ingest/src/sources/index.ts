/**
 * Session-export importers (PRD §4.7/§4.7.1) — net-new ChatGPT + Claude-Code adapters on the
 * platform-neutral `Importer` contract. Parse untrusted exports defensively (per-field guards,
 * skip-record on drift) and drop all foreign embeddings (`embeddingModel:'pending'`).
 *
 * Also exports the Obsidian vault importer (Phase 1) and its `VaultR2` structural interface.
 */
export { createChatGptImporter } from "./chatgpt"
export { createClaudeCodeImporter } from "./claude-code"
export { runImporterContract } from "./contract"
export {
  createNotionImporter,
  type NotionClient,
  type NotionDoc,
  type NotionPageContent,
  type NotionPageRef,
  notionFingerprint,
  notionPageToDoc,
  notionPath,
  notionSlug,
} from "./notion"
export {
  blocksToMarkdown,
  extractPageTags,
  type NotionAnnotations,
  type NotionBlock,
  type NotionRichText,
  pageTitle,
  richTextToMarkdown,
} from "./notion-blocks"
export { createObsidianImporter, extractTags, pathParts, type VaultR2 } from "./obsidian"
export type {
  ImportBatch,
  ImportedSession,
  ImportedTurn,
  Importer,
} from "./types"
export {
  asArray,
  asIsoTime,
  asNumber,
  asRecord,
  asRole,
  asString,
} from "./types"

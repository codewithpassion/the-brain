/**
 * `@brain/db/notion` — Notion connection store + op contracts (docs/notion-integration-plan.md).
 * The reversed-direction sibling of `vault`: the Brain holds Notion's OAuth bot token (AES-GCM
 * encrypted at rest via `NOTION_TOKEN_ENC_KEY`) and calls Notion as the client. Tokens are never
 * logged or returned from any op; `getActiveConnectionByWorkspaceCore` is the one cross-tenant
 * read (webhook `workspace_id → tenant` routing).
 */

export {
  completeNotionConnection,
  getNotionAccessTokenFromEnv,
  notionSourceId,
  resolveNotionWorkspaceFromEnv,
} from "./connect"
export { decryptToken, encryptToken } from "./crypto"
export type { PendingNotionGrant } from "./oauth"
export {
  buildNotionAuthorizeUrl,
  consumeNotionOAuthNonce,
  deleteNotionPendingGrant,
  NOTION_REDIRECT_URI,
  NOTION_TOKEN_URL,
  peekNotionPendingGrant,
  storeNotionOAuthNonce,
  storeNotionPendingGrant,
  storeNotionWebhookToken,
} from "./oauth"
export type { NotionBoundOp, NotionOpContext } from "./ops"
export {
  CONFIRM_NOTION_CONNECTION_OP,
  CONNECT_NOTION_OP,
  confirmNotionConnectionOp,
  connectNotionOp,
  DISCONNECT_NOTION_OP,
  disconnectNotionOp,
  LIST_NOTION_CONNECTIONS_OP,
  listNotionConnectionsOp,
  NOTION_OPS,
  registerNotionOps,
} from "./ops"
export type {
  NotionConnectionInput,
  NotionConnectionRow,
  ResolvedNotionConnection,
} from "./store"
export {
  createNotionConnectionCore,
  getActiveConnectionByWorkspaceCore,
  getDecryptedAccessTokenCore,
  listNotionConnectionsCore,
  NotionWorkspaceConflictError,
  revokeNotionConnectionCore,
} from "./store"
export type { ParsedNotionEvent } from "./webhook"
export { notionHandshakeToken, parseNotionEvent, verifyNotionSignature } from "./webhook"

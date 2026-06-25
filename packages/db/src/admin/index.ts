/**
 * `@brain/db/admin` (PRD §7.1/§9.2.2) — the admin op contracts + bound handlers: `mint_api_key`,
 * `get_token_spend`, `memberships`. Registered into the shared op-registry like every other op
 * family so the MCP/tRPC/CLI catalog cannot drift; the handlers fail CLOSED on a non-admin caller.
 */
export type {
  AdminBoundOp,
  AdminOpContext,
  MembershipOpRow,
  MintApiKeyOpInput,
  TokenSpendOpOutput,
} from "./ops"
export {
  ADMIN_OPS,
  GET_TOKEN_SPEND_OP,
  getTokenSpendCore,
  getTokenSpendOp,
  MEMBERSHIPS_OP,
  MINT_API_KEY_OP,
  membershipsCore,
  membershipsOp,
  mintApiKeyCore,
  mintApiKeyOp,
  registerAdminOps,
} from "./ops"

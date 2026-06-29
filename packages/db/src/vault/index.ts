/**
 * `@brain/db/vault` — vault credential store + op contracts for the WebDAV sync facade
 * (docs/r2-facade-plan.md §4). Credentials are per-tenant; `secret_hash = SHA-256(password)`
 * is the only stored form. `resolveVaultCredentialFromEnv` is the pre-auth gate for the
 * WebDAV route — it is the ONLY place the raw `env.DB` binding is touched outside `scoped/`.
 */

export type { VaultBoundOp, VaultOpContext } from "./ops"
export {
  CREATE_VAULT_CREDENTIAL_OP,
  LIST_VAULT_CREDENTIALS_OP,
  REVOKE_VAULT_CREDENTIAL_OP,
  registerVaultOps,
  VAULT_OPS,
} from "./ops"
export type { CreatedVaultCredential, VaultCredentialRow } from "./store"
export {
  createVaultCredentialCore,
  listVaultCredentialsCore,
  resolveVaultCredential,
  resolveVaultCredentialFromEnv,
  revokeVaultCredentialCore,
} from "./store"

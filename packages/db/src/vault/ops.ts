/**
 * Vault credential op CONTRACTS + bound handlers (docs/r2-facade-plan.md §4).
 *
 * Three `capability: "admin"` ops gate the vault WebDAV credential lifecycle:
 *   - `create_vault_credential` — generate username + password (shown ONCE), store hash.
 *   - `list_vault_credentials`  — list tenant credentials (no secret).
 *   - `revoke_vault_credential` — soft-revoke by username.
 *
 * All three surface on MCP + tRPC + CLI (default surfaces). Handlers are `AdminBoundOp`-shaped
 * (`{ env, principal }` context) so the surface catalog can project them via `adminSurfaceOp`
 * alongside the existing admin family.
 */
import {
  type AnyOpDef,
  defineOp,
  type OpRegistry,
  type Principal,
  scopeSatisfied,
} from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"
import { AuthError } from "../auth/errors"
import type { BrainBindings } from "../env"
import {
  createVaultCredentialCore,
  listVaultCredentialsCore,
  revokeVaultCredentialCore,
} from "./store"

/** The endpoint clients configure in Remotely Save. */
const DAV_ENDPOINT = "https://brain-api.dominik-fretz.workers.dev/dav"

// ── Capability guard ──────────────────────────────────────────────────────────

/** Fail CLOSED with 403 when the principal lacks admin capability. */
const assertAdmin = (principal: Principal): void => {
  if (!scopeSatisfied("admin", principal)) {
    throw new AuthError(403, "admin capability required for vault credential management")
  }
}

// ── Op contracts ──────────────────────────────────────────────────────────────

/** `create_vault_credential` — mint a `vk_` credential pair (password shown ONCE). */
export const CREATE_VAULT_CREDENTIAL_OP = defineOp({
  name: "create_vault_credential",
  description:
    "Generate a vault WebDAV credential (username + password). The password is shown ONCE — " +
    "store it immediately. Returns the Remotely Save WebDAV endpoint.",
  capability: "admin",
  readOnly: false,
  input: z.object({ label: z.string().optional() }),
  output: z.object({ username: z.string(), password: z.string(), endpoint: z.string() }),
})

/** `list_vault_credentials` — list tenant credentials without the secret hash. */
export const LIST_VAULT_CREDENTIALS_OP = defineOp({
  name: "list_vault_credentials",
  description:
    "List this tenant's vault WebDAV credentials (no secret returned). Shows revoked credentials too.",
  capability: "admin",
  readOnly: true,
  input: z.object({}),
  output: z.object({
    credentials: z.array(
      z.object({
        username: z.string(),
        label: z.string().nullable(),
        createdAt: z.string(),
        revokedAt: z.string().nullable(),
      }),
    ),
  }),
})

/** `revoke_vault_credential` — soft-revoke a credential by username. */
export const REVOKE_VAULT_CREDENTIAL_OP = defineOp({
  name: "revoke_vault_credential",
  description:
    "Revoke a vault WebDAV credential by username (no-op if not in this tenant or already revoked).",
  capability: "admin",
  readOnly: false,
  input: z.object({ username: z.string() }),
  output: z.object({ revoked: z.boolean() }),
})

// ── Op context (same shape as AdminOpContext) ─────────────────────────────────

export interface VaultOpContext {
  env: BrainBindings
  principal: Principal
}

// ── Bound handlers ────────────────────────────────────────────────────────────

export interface VaultBoundOp<I, O> {
  def: AnyOpDef
  handler: (ctx: VaultOpContext, input: I) => Promise<O>
}

export const createVaultCredentialOp: VaultBoundOp<
  { label?: string },
  { username: string; password: string; endpoint: string }
> = {
  def: CREATE_VAULT_CREDENTIAL_OP,
  handler: async (ctx, input) => {
    assertAdmin(ctx.principal)
    const db = drizzle(ctx.env.DB)
    const { username, password } = await createVaultCredentialCore(db, ctx.principal, input.label)
    return { username, password, endpoint: DAV_ENDPOINT }
  },
}

export const listVaultCredentialsOp: VaultBoundOp<
  Record<string, never>,
  {
    credentials: {
      username: string
      label: string | null
      createdAt: string
      revokedAt: string | null
    }[]
  }
> = {
  def: LIST_VAULT_CREDENTIALS_OP,
  handler: async (ctx, _input) => {
    assertAdmin(ctx.principal)
    const db = drizzle(ctx.env.DB)
    const credentials = await listVaultCredentialsCore(db, ctx.principal)
    return { credentials }
  },
}

export const revokeVaultCredentialOp: VaultBoundOp<{ username: string }, { revoked: boolean }> = {
  def: REVOKE_VAULT_CREDENTIAL_OP,
  handler: async (ctx, input) => {
    assertAdmin(ctx.principal)
    const db = drizzle(ctx.env.DB)
    const revoked = await revokeVaultCredentialCore(db, ctx.principal, input.username)
    return { revoked }
  },
}

/** Every vault op as a bound pair (def + handler). */
export const VAULT_OPS = [
  createVaultCredentialOp,
  listVaultCredentialsOp,
  revokeVaultCredentialOp,
] as const

/** Register the vault op contracts into a shared `OpRegistry`. */
export const registerVaultOps = (registry: OpRegistry): OpRegistry => {
  for (const op of VAULT_OPS) registry.register(op.def)
  return registry
}

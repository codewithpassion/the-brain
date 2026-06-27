/**
 * `~/.config/brain/config.json` — the CLI's local credential + preference store (PRD §9, invariant
 * 17 hygiene). One file, multiple named profiles; each profile pins an `apiUrl`, the active
 * `tenant`, and ONE of the two credential families:
 *   - `token`  — a `bk_…` API key (v1 primary path, `brain login --token` / `$BRAIN_TOKEN`).
 *   - `accessToken` (+ `refreshToken` + `expiresAt`) — the OAuth 2.1 device-flow grant (RFC 8628).
 *
 * The file is written 0600 (dir 0700): a bearer credential lives here, so it is never group/world
 * readable. NOTHING in this module ever prints a raw token — `redactToken`/`redactProfile` are the
 * ONLY way credentials reach a terminal (invariant 17: no bare token below the edge, and none on a
 * screen either).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** The default API base URL — overridable per profile (`--api`) or via `$BRAIN_API`. */
export const DEFAULT_API_URL = "https://brain-api.dominik-fretz.workers.dev"

/** The default profile name when `--profile` / `$BRAIN_PROFILE` is unset. */
export const DEFAULT_PROFILE = "default"

/** One named credential + preference set. */
export interface Profile {
  apiUrl: string
  tenant?: string
  /** `bk_…` API key (v1 primary). Mutually exclusive in practice with the device-flow trio. */
  token?: string
  /** OAuth 2.1 device-flow access token (bearer). */
  accessToken?: string
  /** OAuth 2.1 refresh token (used to auto-refresh `accessToken` on 401). */
  refreshToken?: string
  /** Epoch-ms expiry of `accessToken`. */
  expiresAt?: number
}

/** The on-disk config shape. */
export interface BrainConfig {
  activeProfile: string
  profiles: Record<string, Profile>
}

/** A profile with its credentials reduced to non-reversible hints — safe to print. */
export interface RedactedProfile {
  apiUrl: string
  tenant: string | null
  token: string | null
  accessToken: string | null
  refreshToken: boolean
  expiresAt: string | null
}

const emptyConfig = (): BrainConfig => ({
  activeProfile: DEFAULT_PROFILE,
  profiles: {},
})

/** Resolve the config file path: `$BRAIN_CONFIG_PATH` › `$XDG_CONFIG_HOME/brain` › `~/.config/brain`. */
export const configPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = env.BRAIN_CONFIG_PATH?.trim()
  if (explicit) return explicit
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return join(base, "brain", "config.json")
}

/** Load the config, or an empty config when the file is absent/unreadable/corrupt. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): BrainConfig => {
  try {
    const raw = readFileSync(configPath(env), "utf8")
    const parsed = JSON.parse(raw) as Partial<BrainConfig>
    return {
      activeProfile: parsed.activeProfile ?? DEFAULT_PROFILE,
      profiles: parsed.profiles ?? {},
    }
  } catch {
    return emptyConfig()
  }
}

/** Persist the config, creating the dir 0700 and writing the file 0600 (credential hygiene). */
export const saveConfig = (config: BrainConfig, env: NodeJS.ProcessEnv = process.env): void => {
  const path = configPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // `writeFileSync` mode is a CREATE-time hint; chmod makes the perms deterministic on overwrite too.
  chmodSync(path, 0o600)
}

/** Get a profile by name (falling back to the active profile), seeded with defaults if absent. */
export const getProfile = (config: BrainConfig, name = config.activeProfile): Profile =>
  config.profiles[name] ?? { apiUrl: DEFAULT_API_URL }

/** Return a NEW config with `name`'s profile replaced and marked active (pure; caller saves). */
export const withProfile = (config: BrainConfig, name: string, profile: Profile): BrainConfig => ({
  activeProfile: name,
  profiles: { ...config.profiles, [name]: profile },
})

/**
 * Reduce a token to a non-reversible hint: keep any `xx_` family prefix + the last 4 chars
 * (`bk_…a1b2`), enough to recognise which credential is active without ever exposing it. A token
 * too short to safely hint is fully masked.
 */
export const redactToken = (token: string | undefined): string | null => {
  if (!token) return null
  if (token.length <= 8) return "****"
  const underscore = token.indexOf("_")
  const prefix = underscore > 0 && underscore <= 6 ? token.slice(0, underscore + 1) : ""
  return `${prefix}…${token.slice(-4)}`
}

/** Reduce a profile to its printable (credential-free) form — the ONLY shape that reaches a screen. */
export const redactProfile = (profile: Profile): RedactedProfile => ({
  apiUrl: profile.apiUrl,
  tenant: profile.tenant ?? null,
  token: redactToken(profile.token),
  accessToken: redactToken(profile.accessToken),
  refreshToken: profile.refreshToken !== undefined,
  expiresAt: profile.expiresAt !== undefined ? new Date(profile.expiresAt).toISOString() : null,
})

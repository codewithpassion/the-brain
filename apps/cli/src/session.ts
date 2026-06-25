/**
 * Resolve the per-invocation request session from (global flags › env › active profile): the API
 * URL, the bearer token, and the active tenant (sent as `X-Brain-Tenant`). When the active profile
 * holds a device-flow refresh token, a `refresh` closure is wired so the client can transparently
 * refresh the bearer on a 401 and persist the new grant. A missing credential is a clear, actionable
 * error — never a silent unauthenticated request (invariant 17).
 */
import { type DeviceFlowDeps, refreshGrant } from "./auth/device"
import { type BrainConfig, getProfile, loadConfig, saveConfig, withProfile } from "./config"

/** Global flags shared by every command (program-level). */
export interface GlobalFlags {
  api?: string
  tenant?: string
  json?: boolean
  profile?: string
}

/** The resolved request session handed to `createBrainClient`. */
export interface ResolvedSession {
  apiUrl: string
  token: string
  tenant?: string
  refresh?: () => Promise<string | null>
}

const resolveProfileName = (
  config: BrainConfig,
  flags: GlobalFlags,
  env: NodeJS.ProcessEnv,
): string => flags.profile ?? env.BRAIN_PROFILE?.trim() ?? config.activeProfile

/**
 * Build the refresh closure for a profile that has a device-flow refresh token: exchange it, persist
 * the new grant under the same profile, and hand the fresh access token back to the client. Re-reads
 * + re-writes config through `loadConfig`/`saveConfig` so a concurrent profile switch is respected.
 */
const makeRefresh = (
  profileName: string,
  refreshToken: string,
  apiUrl: string,
  deviceDeps: DeviceFlowDeps,
  env: NodeJS.ProcessEnv,
): (() => Promise<string | null>) => {
  return async () => {
    const grant = await refreshGrant(deviceDeps, { apiUrl, refreshToken })
    const current = loadConfig(env)
    const profile = getProfile(current, profileName)
    saveConfig(
      withProfile(current, profileName, {
        ...profile,
        accessToken: grant.accessToken,
        ...(grant.refreshToken !== undefined ? { refreshToken: grant.refreshToken } : {}),
        expiresAt: grant.expiresAt,
      }),
      env,
    )
    return grant.accessToken
  }
}

/** Resolve the active session, or throw a clear "not authenticated" error. */
export const resolveSession = (
  config: BrainConfig,
  flags: GlobalFlags,
  env: NodeJS.ProcessEnv,
  deviceDeps: DeviceFlowDeps,
): ResolvedSession => {
  const profileName = resolveProfileName(config, flags, env)
  const profile = getProfile(config, profileName)
  const apiUrl = flags.api?.trim() || env.BRAIN_API?.trim() || profile.apiUrl
  const token = env.BRAIN_TOKEN?.trim() || profile.token || profile.accessToken
  if (!token) {
    throw new Error(
      "not authenticated — run `brain login --token <bk_…>` (or `brain auth login` for device flow)",
    )
  }
  const tenant = flags.tenant?.trim() || profile.tenant
  return {
    apiUrl,
    token,
    ...(tenant !== undefined ? { tenant } : {}),
    ...(profile.refreshToken !== undefined
      ? { refresh: makeRefresh(profileName, profile.refreshToken, apiUrl, deviceDeps, env) }
      : {}),
  }
}

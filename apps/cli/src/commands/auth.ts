/**
 * Auth + tenant + config commands — the NON-generated, CLI-local surface (no op-registry entry):
 *
 *   - `brain login --token <bk_…>`  v1 PRIMARY: store an API key (or `$BRAIN_TOKEN`) in the profile.
 *   - `brain logout`                clear the active profile's credentials.
 *   - `brain whoami`                show the active profile, credentials REDACTED (invariant 17).
 *   - `brain tenant use <slug>`     pin the active tenant (sent as `X-Brain-Tenant`).
 *   - `brain auth login`            OAuth 2.1 device flow (RFC 8628); 404 ⇒ clear "pending" message.
 *
 * NOTHING here prints a raw token: success is reported via `redactProfile`. The device-flow SERVER
 * endpoints are an orchestrator follow-up — until they exist, `auth login` reports it cleanly and
 * `login --token` remains the working path.
 */
import type { Command } from "commander"
import {
  pollForToken,
  requestDeviceAuthorization,
  ServerEndpointPendingError,
} from "../auth/device"
import { type BrainConfig, getProfile, type Profile, redactProfile, withProfile } from "../config"
import type { CliDeps } from "../deps"
import { addGlobalFlags } from "../flags"
import { createPrinter } from "../render"
import type { GlobalFlags } from "../session"

const profileName = (config: BrainConfig, globals: GlobalFlags, env: NodeJS.ProcessEnv): string =>
  globals.profile ?? env.BRAIN_PROFILE?.trim() ?? config.activeProfile

/** Apply `--api`/`--tenant` globals onto a profile (without clobbering with empty flags). */
const applyGlobals = (profile: Profile, globals: GlobalFlags): Profile => ({
  ...profile,
  ...(globals.api?.trim() ? { apiUrl: globals.api.trim() } : {}),
  ...(globals.tenant?.trim() ? { tenant: globals.tenant.trim() } : {}),
})

const globalsOf = (command: Command): GlobalFlags => command.optsWithGlobals() as GlobalFlags

/** `login --token` — store a `bk_…` API key (or `$BRAIN_TOKEN`) in the active profile. */
const handleTokenLogin = async (deps: CliDeps, command: Command, token?: string): Promise<void> => {
  const globals = globalsOf(command)
  const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
  const key = token?.trim() || deps.env.BRAIN_TOKEN?.trim()
  if (!key) {
    printer.error("provide a token: `brain login --token <bk_…>` or set $BRAIN_TOKEN")
    process.exitCode = 1
    return
  }
  const config = deps.loadConfig()
  const name = profileName(config, globals, deps.env)
  const profile = applyGlobals(getProfile(config, name), globals)
  deps.saveConfig(withProfile(config, name, { ...profile, token: key }))
  printer.print({ loggedIn: true, profile: name, ...redactProfile({ ...profile, token: key }) })
}

/** `logout` — clear all credentials from the active profile (keep apiUrl/tenant). */
const handleLogout = (deps: CliDeps, command: Command): void => {
  const globals = globalsOf(command)
  const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
  const config = deps.loadConfig()
  const name = profileName(config, globals, deps.env)
  const profile = getProfile(config, name)
  deps.saveConfig(
    withProfile(config, name, {
      apiUrl: profile.apiUrl,
      ...(profile.tenant !== undefined ? { tenant: profile.tenant } : {}),
    }),
  )
  printer.print({ loggedOut: true, profile: name })
}

/** `whoami` — the active profile with credentials reduced to hints (never the raw token). */
const handleWhoami = (deps: CliDeps, command: Command): void => {
  const globals = globalsOf(command)
  const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
  const config = deps.loadConfig()
  const name = profileName(config, globals, deps.env)
  const profile = getProfile(config, name)
  const authed = Boolean(profile.token || profile.accessToken)
  printer.print({ profile: name, authenticated: authed, ...redactProfile(profile) })
}

/** `auth login` — the OAuth 2.1 device-authorization grant (RFC 8628). */
const handleDeviceLogin = async (deps: CliDeps, command: Command): Promise<void> => {
  const globals = globalsOf(command)
  const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
  const config = deps.loadConfig()
  const name = profileName(config, globals, deps.env)
  const profile = applyGlobals(getProfile(config, name), globals)
  const apiUrl = profile.apiUrl
  try {
    const authorization = await requestDeviceAuthorization(deps.deviceDeps, { apiUrl })
    deps.out(
      `To authorize, open ${authorization.verificationUriComplete ?? authorization.verificationUri}`,
    )
    deps.out(`and enter code: ${authorization.userCode}`)
    const grant = await pollForToken(deps.deviceDeps, {
      apiUrl,
      deviceCode: authorization.deviceCode,
      interval: authorization.interval,
      expiresIn: authorization.expiresIn,
    })
    const next: Profile = {
      ...profile,
      accessToken: grant.accessToken,
      ...(grant.refreshToken !== undefined ? { refreshToken: grant.refreshToken } : {}),
      expiresAt: grant.expiresAt,
    }
    deps.saveConfig(withProfile(config, name, next))
    printer.print({ loggedIn: true, profile: name, ...redactProfile(next) })
  } catch (error) {
    if (error instanceof ServerEndpointPendingError) {
      printer.error(error.message)
    } else {
      printer.error(error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
  }
}

/** `tenant use <slug>` — pin the active tenant in the profile. */
const handleTenantUse = (deps: CliDeps, command: Command, slug: string): void => {
  const globals = globalsOf(command)
  const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
  const config = deps.loadConfig()
  const name = profileName(config, globals, deps.env)
  const profile = getProfile(config, name)
  deps.saveConfig(withProfile(config, name, { ...profile, tenant: slug }))
  printer.print({ profile: name, tenant: slug })
}

/** `tenant current` — show the pinned active tenant. */
const handleTenantCurrent = (deps: CliDeps, command: Command): void => {
  const globals = globalsOf(command)
  const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
  const config = deps.loadConfig()
  const name = profileName(config, globals, deps.env)
  printer.print({ profile: name, tenant: getProfile(config, name).tenant ?? null })
}

/** Register the auth/tenant/config commands onto `program`. */
export const registerAuthCommands = (program: Command, deps: CliDeps): void => {
  addGlobalFlags(
    program
      .command("login")
      .description("Authenticate with a bk_ API key ($BRAIN_TOKEN if --token omitted)")
      .helpGroup("auth commands")
      .option("--token <token>", "API key (bk_…)"),
  ).action((options: { token?: string }, self: Command) =>
    handleTokenLogin(deps, self, options.token),
  )

  addGlobalFlags(
    program
      .command("logout")
      .description("Clear the active profile's stored credentials")
      .helpGroup("auth commands"),
  ).action((_options: unknown, self: Command) => handleLogout(deps, self))

  addGlobalFlags(
    program
      .command("whoami")
      .description("Show the active profile (credentials redacted)")
      .helpGroup("auth commands"),
  ).action((_options: unknown, self: Command) => handleWhoami(deps, self))

  const auth = program
    .command("auth")
    .description("OAuth 2.1 device-flow auth")
    .helpGroup("auth commands")
  addGlobalFlags(
    auth.command("login").description("Log in via the OAuth 2.1 device flow (RFC 8628)"),
  ).action((_options: unknown, self: Command) => handleDeviceLogin(deps, self))
  addGlobalFlags(
    auth.command("logout").description("Clear the active profile's stored credentials"),
  ).action((_options: unknown, self: Command) => handleLogout(deps, self))
  addGlobalFlags(
    auth.command("status").description("Show the active profile (credentials redacted)"),
  ).action((_options: unknown, self: Command) => handleWhoami(deps, self))

  const tenant = program
    .command("tenant")
    .description("Active-tenant selector")
    .helpGroup("auth commands")
  addGlobalFlags(
    tenant.command("use <slug>").description("Pin the active tenant (sent as X-Brain-Tenant)"),
  ).action((slug: string, _options: unknown, self: Command) => handleTenantUse(deps, self, slug))
  addGlobalFlags(tenant.command("current").description("Show the pinned active tenant")).action(
    (_options: unknown, self: Command) => handleTenantCurrent(deps, self),
  )
}

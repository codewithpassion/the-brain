import { describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BrainConfig,
  loadConfig,
  redactProfile,
  redactToken,
  saveConfig,
  withProfile,
} from "../src/config"

/** A throwaway `$BRAIN_CONFIG_PATH` env so each test reads/writes an isolated temp file. */
const tempEnv = (): NodeJS.ProcessEnv => ({
  BRAIN_CONFIG_PATH: join(mkdtempSync(join(tmpdir(), "brain-cli-")), "config.json"),
})

describe("config read/write", () => {
  test("save → load round-trips the config", () => {
    const env = tempEnv()
    const config: BrainConfig = {
      activeProfile: "work",
      profiles: { work: { apiUrl: "https://api.test", tenant: "org_x", token: "bk_abc_1234" } },
    }
    saveConfig(config, env)
    expect(loadConfig(env)).toEqual(config)
  })

  test("the config file is written 0600 (credential hygiene)", () => {
    const env = tempEnv()
    saveConfig({ activeProfile: "default", profiles: { default: { apiUrl: "x" } } }, env)
    const mode = statSync(env.BRAIN_CONFIG_PATH as string).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("a missing config loads as empty (not a throw)", () => {
    expect(loadConfig({ BRAIN_CONFIG_PATH: "/nonexistent/brain/config.json" })).toEqual({
      activeProfile: "default",
      profiles: {},
    })
  })

  test("withProfile is pure and marks the profile active", () => {
    const base: BrainConfig = { activeProfile: "a", profiles: { a: { apiUrl: "x" } } }
    const next = withProfile(base, "b", { apiUrl: "y" })
    expect(next).toEqual({
      activeProfile: "b",
      profiles: { a: { apiUrl: "x" }, b: { apiUrl: "y" } },
    })
    // original untouched
    expect(base.profiles.b).toBeUndefined()
  })
})

describe("token redaction (invariant 17)", () => {
  test("keeps the family prefix + last 4, never the body", () => {
    expect(redactToken("bk_supersecret_abcd1234")).toBe("bk_…1234")
    expect(redactToken(undefined)).toBeNull()
    expect(redactToken("short")).toBe("****")
  })

  test("redactProfile never carries a raw token and exposes refresh-presence only", () => {
    const redacted = redactProfile({
      apiUrl: "https://api.test",
      tenant: "org_x",
      token: "bk_supersecret_abcd1234",
      refreshToken: "rt_topsecret_value",
      accessToken: "eyJ.header.body.sig.value",
      expiresAt: 0,
    })
    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain("supersecret")
    expect(serialized).not.toContain("topsecret")
    expect(redacted.refreshToken).toBe(true)
    expect(redacted.token).toBe("bk_…1234")
  })
})

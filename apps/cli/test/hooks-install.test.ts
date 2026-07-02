import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliDeps } from "../src/deps"
import { buildProgram } from "../src/program"

/**
 * Integration coverage for the `brain hooks install` ACTION (not just the pure `mergeClaudeSettings`):
 * the local-vs-shared target-selection ternary lives ONLY in the action, and the malformed-refusal
 * guard is at the fs layer — both invisible to the pure-function tests.
 */

let out: string[] = []
let err: string[] = []
const deps = (): CliDeps => ({
  env: {},
  loadConfig: () => ({ activeProfile: "default", profiles: { default: { apiUrl: "https://x" } } }),
  saveConfig: () => {},
  createClient: () => ({ call: async () => ({}) }),
  deviceDeps: { fetch: async () => new Response("{}"), sleep: async () => {}, now: () => 0 },
  out: (l) => out.push(l),
  err: (l) => err.push(l),
})

const run = (args: string[]) => buildProgram(deps()).parseAsync(["node", "brain", ...args])

let dir: string
beforeEach(() => {
  out = []
  err = []
  process.exitCode = 0
  dir = mkdtempSync(join(tmpdir(), "brain-hooks-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  process.exitCode = 0 // don't leak the malformed-refusal exit code to the test runner
})

describe("brain hooks install (action) — target selection + malformed refusal", () => {
  test("default target is .claude/settings.local.json (personal), NOT settings.json", async () => {
    await run(["hooks", "install", "--path", dir])
    expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(true)
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false)
  })

  test("--shared writes .claude/settings.json (committed) and warns", async () => {
    await run(["hooks", "install", "--path", dir, "--shared"])
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true)
    expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(false)
    expect(err.join("\n")).toMatch(/teammates need the brain CLI/)
  })

  test("--dry-run prints JSON and writes NOTHING", async () => {
    await run(["hooks", "install", "--path", dir, "--dry-run"])
    expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(false)
    expect(out.join("\n")).toContain("SessionStart")
    expect(out.join("\n")).toContain("brain context --snapshot")
  })

  test("a MALFORMED existing settings file is REFUSED — non-zero exit, bytes unchanged", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true })
    const path = join(dir, ".claude", "settings.local.json")
    const garbage = "{ not valid json"
    writeFileSync(path, garbage)
    await run(["hooks", "install", "--path", dir])
    expect(process.exitCode).toBe(1)
    expect(readFileSync(path, "utf8")).toBe(garbage) // never overwritten
    expect(err.join("\n")).toMatch(/not valid JSON/)
  })
})

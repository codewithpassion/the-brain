import { afterEach, describe, expect, test } from "bun:test"
import { buildCliCommandSpecs, buildRegistry } from "@brain/surface"
import type { Command } from "commander"
import type { CliDeps } from "../src/deps"
import { groupForOp } from "../src/groups"
import { coerceArg } from "../src/input"
import { buildProgram } from "../src/program"

// Commands signal failure via `process.exitCode = 1` (consumed by the real entry
// in src/index.ts). Error-path tests below exercise that, so reset it after each
// test to avoid leaking a non-zero exit code into the test runner's own exit.
afterEach(() => {
  process.exitCode = 0
})

/** Fully-faked deps — no filesystem, network, or clock; overridable per test. */
const fakeDeps = (over: Partial<CliDeps> = {}): CliDeps => ({
  env: {},
  loadConfig: () => ({
    activeProfile: "default",
    profiles: { default: { apiUrl: "https://api.test" } },
  }),
  saveConfig: () => {},
  createClient: () => ({ call: async () => ({}) }),
  deviceDeps: { fetch: async () => new Response("{}"), sleep: async () => {}, now: () => 0 },
  out: () => {},
  err: () => {},
  ...over,
})

/** The CLI-local (non-generated) command names. */
const LOCAL = new Set(["login", "logout", "whoami", "auth", "tenant"])

const generatedNames = (program: Command): string[] =>
  program.commands
    .map((command) => command.name())
    .filter((name) => !LOCAL.has(name))
    .sort()

describe("generated commands ↔ op-registry (cannot drift)", () => {
  test("every cli spec produces exactly one command, and vice versa (drift parity)", () => {
    const program = buildProgram(fakeDeps())
    const specNames = buildCliCommandSpecs()
      .map((spec) => spec.name)
      .sort()
    expect(generatedNames(program)).toEqual(specNames)
  })

  test("the generated set equals registry.bySurface('cli')", () => {
    const program = buildProgram(fakeDeps())
    const cliOps = buildRegistry()
      .bySurface("cli")
      .map((op) => op.name)
      .sort()
    expect(generatedNames(program)).toEqual(cliOps)
  })

  test("every cli op maps to a help group (a NEW op fails loudly here)", () => {
    for (const spec of buildCliCommandSpecs()) {
      expect(groupForOp(spec.name)).toBeDefined()
    }
  })

  test("a representative op's flags are derived from its Zod input", () => {
    const program = buildProgram(fakeDeps())
    const think = program.commands.find((command) => command.name() === "think")
    expect(think).toBeDefined()
    const flags = think?.options.map((option) => option.long)
    expect(flags).toContain("--query")
    expect(flags).toContain("--topK")
    expect(flags).toContain("--scope")
    // `query` (no default) is mandatory; `topK` (defaulted) is optional.
    const query = think?.options.find((option) => option.long === "--query")
    const topK = think?.options.find((option) => option.long === "--topK")
    expect(query?.mandatory).toBe(true)
    expect(topK?.mandatory).toBe(false)
  })

  test("an enum arg becomes a choice-constrained option", () => {
    const program = buildProgram(fakeDeps())
    const capture = program.commands.find((command) => command.name() === "capture_turn")
    const role = capture?.options.find((option) => option.long === "--role")
    expect(role?.argChoices).toEqual(["user", "assistant", "system", "tool"])
  })
})

describe("input coercion (string flags → typed op input)", () => {
  test("integer/number flags coerce, and a non-number throws", () => {
    expect(
      coerceArg({ name: "topK", type: "integer", required: false, description: "" }, "12"),
    ).toBe(12)
    expect(() =>
      coerceArg({ name: "topK", type: "integer", required: false, description: "" }, "abc"),
    ).toThrow("must be a number")
  })

  test("boolean flag presence coerces to true; array splits on comma", () => {
    expect(
      coerceArg({ name: "readOnly", type: "boolean", required: false, description: "" }, true),
    ).toBe(true)
    expect(
      coerceArg({ name: "ids", type: "array", required: false, description: "" }, "a, b ,c"),
    ).toEqual(["a", "b", "c"])
  })
})

describe("end-to-end dispatch (opts → coerce → validate → client.call)", () => {
  test('--topK "5" reaches the wire as the number 5, routed as a readOnly query', async () => {
    let captured: { name: string; readOnly: boolean; input: unknown } | undefined
    const program = buildProgram(
      fakeDeps({
        env: { BRAIN_TOKEN: "bk_x" },
        createClient: () => ({
          call: async (name, readOnly, input) => {
            captured = { name, readOnly, input }
            return {}
          },
        }),
      }),
    )
    await program.parseAsync(["node", "brain", "think", "--query", "hi", "--topK", "5"])
    expect(captured).toEqual({ name: "think", readOnly: true, input: { query: "hi", topK: 5 } })
  })

  test("a mutation routes as a write (readOnly false)", async () => {
    let captured: { name: string; readOnly: boolean } | undefined
    const program = buildProgram(
      fakeDeps({
        env: { BRAIN_TOKEN: "bk_x" },
        createClient: () => ({
          call: async (name, readOnly) => {
            captured = { name, readOnly }
            return {}
          },
        }),
      }),
    )
    await program.parseAsync([
      "node",
      "brain",
      "capture_turn",
      "--sessionId",
      "s1",
      "--role",
      "user",
      "--content",
      "hi",
      "--client",
      "cli",
    ])
    expect(captured).toEqual({ name: "capture_turn", readOnly: false })
  })
})

describe("output hygiene (invariant 17)", () => {
  test("an error on the request path prints a message, never the token", async () => {
    const lines: string[] = []
    const program = buildProgram(
      fakeDeps({
        env: { BRAIN_TOKEN: "bk_supersecret_zzzz" },
        createClient: () => ({ call: async () => Promise.reject(new Error("upstream 401")) }),
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      }),
    )
    await program.parseAsync(["node", "brain", "think", "--query", "hi"])
    const output = lines.join("\n")
    expect(output).toContain("error:")
    expect(output).toContain("upstream 401")
    expect(output).not.toContain("supersecret")
  })
})

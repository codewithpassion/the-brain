import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

/** The CLI-local (non-generated) command names — auth + the W2 hand-written hook kit. */
const LOCAL = new Set([
  "login",
  "logout",
  "whoami",
  "auth",
  "tenant",
  "context",
  "capture",
  "hooks",
  "wiki", // hand-written `wiki import <path>` (reads a bundle client-side; not an op-registry command)
  "dream", // hand-written `dream [kind]` alias for the generated `dream_now` op
])

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

  test("array args with object items parse each value as JSON", () => {
    const spec = {
      name: "changes",
      type: "array",
      required: true,
      description: "",
      itemType: "object",
    }
    expect(coerceArg(spec, ['{"before":"a","after":"b"}', '{"before":"c","after":"d"}'])).toEqual([
      { before: "a", after: "b" },
      { before: "c", after: "d" },
    ])
    expect(() => coerceArg(spec, ["not json"])).toThrow(/must be a JSON object/)
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

/**
 * The CLI-only `--<arg>-file <path>` companion. Linux caps one argv string at 128 KiB, so a long
 * document can only arrive by path — but the op input is unchanged, so these assert the value lands
 * on the wire exactly as if it had been typed, and that the two flags refuse to be combined.
 */
describe("--<arg>-file (client-side file marshalling)", () => {
  const capture = (): { seen?: { input: unknown }; deps: CliDeps } => {
    const box: { seen?: { input: unknown }; deps: CliDeps } = {
      deps: fakeDeps({
        env: { BRAIN_TOKEN: "bk_x" },
        createClient: () => ({
          call: async (_name, _readOnly, input) => {
            box.seen = { input }
            return {}
          },
        }),
      }),
    }
    return box
  }

  test("every free-form string arg gains a --<arg>-file; other arg types do not", () => {
    const program = buildProgram(fakeDeps())
    const ingest = program.commands.find((command) => command.name() === "ingest_document")
    const flags = ingest?.options.map((option) => option.long)
    expect(flags).toContain("--content-file") // content: string
    expect(flags).toContain("--title-file") // title: string
    expect(flags).not.toContain("--tags-file") // tags: array
  })

  test("an ENUM string arg gets no file companion (a fixed token never needs one)", () => {
    const program = buildProgram(fakeDeps())
    const save = program.commands.find((command) => command.name() === "wiki_save_page")
    const flags = save?.options.map((option) => option.long)
    expect(flags).toContain("--body-file") // body: free-form string
    expect(flags).not.toContain("--visibility-file") // visibility: enum
    // The enum arg itself is untouched — still choice-constrained.
    const visibility = save?.options.find((option) => option.long === "--visibility")
    expect(visibility?.argChoices).toBeDefined()
  })

  test("two args asking for stdin is refused before either is read (no silent empty value)", async () => {
    const lines: string[] = []
    const program = buildProgram(
      fakeDeps({ env: { BRAIN_TOKEN: "bk_x" }, err: (line) => lines.push(line) }),
    )
    await program.parseAsync([
      "node",
      "brain",
      "wiki_save_page",
      "--slug",
      "notes/x",
      "--type",
      "note",
      "--body-file",
      "-",
      "--title-file",
      "-",
    ])
    expect(lines.join("\n")).toContain(
      "--body-file and --title-file each read stdin — '-' works for one arg only",
    )
    expect(process.exitCode).toBe(1)
  })

  test("--content-file satisfies the MANDATORY --content and passes the file's text through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-file-arg-"))
    const path = join(dir, "transcript.txt")
    const text = "x".repeat(300_000) // far past the 128 KiB argv ceiling
    writeFileSync(path, text)
    const box = capture()
    await buildProgram(box.deps).parseAsync([
      "node",
      "brain",
      "ingest_document",
      "--content-file",
      path,
      "--title",
      "transcript",
    ])
    expect(box.seen?.input).toMatchObject({ content: text, title: "transcript" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("--<arg>-file works for a non-mandatory arg too (wiki_save_page --body-file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-file-arg-"))
    const path = join(dir, "page.md")
    writeFileSync(path, "# hello\n")
    const box = capture()
    await buildProgram(box.deps).parseAsync([
      "node",
      "brain",
      "wiki_save_page",
      "--slug",
      "notes/hello",
      "--type",
      "note",
      "--body-file",
      path,
    ])
    expect(box.seen?.input).toMatchObject({ slug: "notes/hello", body: "# hello\n" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("passing BOTH --content and --content-file is a user error naming both flags", async () => {
    const lines: string[] = []
    const program = buildProgram(
      fakeDeps({ env: { BRAIN_TOKEN: "bk_x" }, err: (l) => lines.push(l) }),
    )
    await program.parseAsync([
      "node",
      "brain",
      "ingest_document",
      "--content",
      "typed",
      "--content-file",
      "/tmp/whatever",
    ])
    expect(lines.join("\n")).toContain("--content and --content-file are mutually exclusive")
    expect(process.exitCode).toBe(1)
  })

  test("both flags are caught in EITHER order (--content-file first)", async () => {
    const lines: string[] = []
    const program = buildProgram(
      fakeDeps({ env: { BRAIN_TOKEN: "bk_x" }, err: (l) => lines.push(l) }),
    )
    await program.parseAsync([
      "node",
      "brain",
      "ingest_document",
      "--content-file",
      "/tmp/whatever",
      "--content",
      "typed",
    ])
    expect(lines.join("\n")).toContain("--content and --content-file are mutually exclusive")
    expect(process.exitCode).toBe(1)
  })

  test("an unreadable path prints ENOENT through the printer (not an unhandled rejection)", async () => {
    const lines: string[] = []
    const program = buildProgram(
      fakeDeps({ env: { BRAIN_TOKEN: "bk_x" }, err: (l) => lines.push(l) }),
    )
    await program.parseAsync([
      "node",
      "brain",
      "ingest_document",
      "--content-file",
      join(tmpdir(), "brain-no-such-file-1a2b3c"),
    ])
    const output = lines.join("\n")
    expect(output).toContain("error:")
    expect(output).toContain("ENOENT")
    expect(process.exitCode).toBe(1)
  })
})

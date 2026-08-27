/**
 * Generate the `brain` op commands from `buildCliCommandSpecs(registry)` — ONE Commander command
 * per `"cli"` op (command name === op name), so the CLI surface CANNOT drift from MCP/tRPC (PRD
 * §9.0.2; the drift test asserts the generated command set === `registry.bySurface("cli")`). Each
 * op's Zod input becomes the command's flag set; on invocation the flags are coerced + validated
 * against that SAME schema, then dispatched through the typed tRPC client as a query (readOnly) or
 * mutation. Commands are flat (trivial parity) and only GROUPED for `--help` via `helpGroup`.
 *
 * Every free-form string arg additionally gets a CLI-ONLY `--<arg>-file <path>` companion. It is
 * pure client-side marshalling — the op input is untouched and still goes through `validateInput` —
 * exactly like the hand-written `brain wiki import <path>`, so it adds no drift and no trust surface.
 */

import { readFileSync } from "node:fs"
import {
  buildCliCommandSpecs,
  buildRegistry,
  type CliArgSpec,
  type CliCommandSpec,
} from "@brain/surface"
import { Command, Option } from "commander"
import type { z } from "zod"
import type { CliDeps } from "../deps"
import { addGlobalFlags } from "../flags"
import { groupForOp } from "../groups"
import { buildRawInput, validateInput } from "../input"
import { createPrinter } from "../render"
import { resolveSession } from "../session"

/** The suffix that turns a string arg's flag into its file companion (`--content` → `--content-file`). */
const FILE_SUFFIX = "-file"

/** Commander camel-cases on `-`, so `--content-file` lands on the opts key `contentFile`. */
const fileKey = (name: string): string => `${name}File`

/** Build the Commander option for one derived arg (flag shape + enum choices + required marker). */
const optionFor = (arg: CliArgSpec): Option => {
  const flag =
    arg.type === "boolean"
      ? `--${arg.name}`
      : arg.type === "array"
        ? `--${arg.name} <values...>`
        : `--${arg.name} <value>`
  const option = new Option(flag, arg.description || `${arg.name} (${arg.type})`)
  if (arg.enumValues) option.choices(arg.enumValues)
  if (arg.required) option.makeOptionMandatory()
  return option
}

/**
 * The file companion for a string arg. Linux caps ONE argv string at 128 KiB, so a long document
 * (a 5-hour transcript is ~390 KB) can never reach `--content` — it dies as E2BIG in the shell,
 * before `brain` even starts. This flag is the way in, and `-` means stdin so a pipe needs no
 * temp file. Free-form strings only: nothing else gets near the limit, and an ENUM value is a fixed
 * short token, so `--visibility-file` could only ever end in a rejection — no flag is kinder.
 */
const fileOptionFor = (arg: CliArgSpec): Option =>
  new Option(
    `--${arg.name}${FILE_SUFFIX} <path>`,
    `read --${arg.name} from a file instead of argv ('-' reads stdin)`,
  )

/**
 * Park the PATH on the arg's OWN option at parse time, tagged with the custom source `"file"`.
 * Commander checks mandatory options (`_checkForMissingMandatoryOptions`) before any action or hook
 * runs, so a required `--content` would reject a lone `--content-file` — the placeholder satisfies
 * that check and the action swaps it for the file's contents. An explicit `--content` always wins
 * the slot, which is precisely what makes "both flags given" detectable later: the source is `"file"`
 * if and only if the file flag was the sole provider.
 */
const parkFilePath = (command: Command, arg: CliArgSpec): void => {
  command.on(`option:${arg.name}${FILE_SUFFIX}`, (path: string) => {
    if (command.getOptionValueSource(arg.name) === "cli") return
    command.setOptionValueWithSource(arg.name, path, "file")
  })
}

/**
 * Swap each parked path for the file's bytes. Called INSIDE the action's try/catch so an unreadable
 * path surfaces through the same printer as every other error (ENOENT from `readFileSync`, matching
 * `wiki import`), and returns a copy so the command's own option values stay as parsed.
 *
 * Stdin drains, so it can fill exactly ONE arg: a second `-` would silently hand that arg an empty
 * string, which is data loss you only notice once it is already saved. Refused UP FRONT, before any
 * read, so the diagnosis never depends on which arg the spec happened to order first.
 */
const resolveFileArgs = (
  args: readonly CliArgSpec[],
  command: Command,
): Record<string, unknown> => {
  const opts: Record<string, unknown> = { ...command.opts() }
  const fromStdin = args.filter((arg) => opts[fileKey(arg.name)] === "-")
  if (fromStdin.length > 1)
    throw new Error(
      `${fromStdin.map((arg) => `--${arg.name}${FILE_SUFFIX}`).join(" and ")} each read stdin — '-' works for one arg only`,
    )
  for (const arg of args) {
    const path = opts[fileKey(arg.name)]
    if (typeof path !== "string") continue
    if (command.getOptionValueSource(arg.name) !== "file")
      throw new Error(
        `--${arg.name} and --${arg.name}${FILE_SUFFIX} are mutually exclusive — pass one, not both`,
      )
    opts[arg.name] = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8")
  }
  return opts
}

/** Build one generated command from its spec + the op's Zod input schema. */
export const buildGeneratedCommand = (
  spec: CliCommandSpec,
  schema: z.ZodTypeAny,
  deps: CliDeps,
): Command => {
  const command = new Command(spec.name).description(spec.description)
  const group = groupForOp(spec.name)
  if (group) command.helpGroup(`${group} commands`)
  addGlobalFlags(command)
  for (const arg of spec.args) {
    command.addOption(optionFor(arg))
    if (arg.type !== "string" || arg.enumValues) continue
    command.addOption(fileOptionFor(arg))
    parkFilePath(command, arg)
  }

  command.action(async (_options: Record<string, unknown>, self: Command) => {
    const globals = self.optsWithGlobals()
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    try {
      const input = validateInput(
        schema,
        buildRawInput(spec.args, resolveFileArgs(spec.args, self)),
      )
      const session = resolveSession(deps.loadConfig(), globals, deps.env, deps.deviceDeps)
      const client = deps.createClient(session)
      printer.print(await client.call(spec.name, spec.readOnly, input))
    } catch (error) {
      printer.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
  return command
}

/** Register every generated op command onto `program` (sorted by help group, then op name). */
export const registerGeneratedCommands = (program: Command, deps: CliDeps): void => {
  const registry = buildRegistry()
  const specs = [...buildCliCommandSpecs()].sort((a, b) => a.name.localeCompare(b.name))
  for (const spec of specs) {
    const op = registry.get(spec.name)
    if (!op) throw new Error(`spec ${spec.name} has no registry op (drift)`)
    program.addCommand(buildGeneratedCommand(spec, op.input, deps))
  }
}

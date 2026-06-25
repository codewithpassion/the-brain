/**
 * Generate the `brain` op commands from `buildCliCommandSpecs(registry)` — ONE Commander command
 * per `"cli"` op (command name === op name), so the CLI surface CANNOT drift from MCP/tRPC (PRD
 * §9.0.2; the drift test asserts the generated command set === `registry.bySurface("cli")`). Each
 * op's Zod input becomes the command's flag set; on invocation the flags are coerced + validated
 * against that SAME schema, then dispatched through the typed tRPC client as a query (readOnly) or
 * mutation. Commands are flat (trivial parity) and only GROUPED for `--help` via `helpGroup`.
 */
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
  for (const arg of spec.args) command.addOption(optionFor(arg))

  command.action(async (_options: Record<string, unknown>, self: Command) => {
    const globals = self.optsWithGlobals()
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    try {
      const input = validateInput(schema, buildRawInput(spec.args, self.opts()))
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

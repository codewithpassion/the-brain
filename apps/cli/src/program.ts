/**
 * Assemble the `brain` Commander program from injected `CliDeps` (pure — no side effects until an
 * action runs, so `buildProgram(fakeDeps)` is fully unit-testable). Auth/tenant/config commands are
 * hand-written (no op-registry entry); every OTHER command is GENERATED from the op-registry so the
 * CLI cannot drift from the MCP + tRPC surfaces.
 */
import { Command } from "commander"
import { registerAuthCommands } from "./commands/auth"
import { registerGeneratedCommands } from "./commands/generated"
import { registerHookCommands } from "./commands/hooks"
import type { CliDeps } from "./deps"
import { addGlobalFlags } from "./flags"

export const buildProgram = (deps: CliDeps): Command => {
  const program = new Command("brain")
  program
    .description("The Brain CLI — a typed tRPC client over the single Zod op-registry")
    .enablePositionalOptions()
  addGlobalFlags(program)
  registerAuthCommands(program, deps)
  registerHookCommands(program, deps) // hand-written hook kit (context / capture / hooks install)
  registerGeneratedCommands(program, deps)
  return program
}

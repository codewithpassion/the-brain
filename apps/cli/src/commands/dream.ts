/**
 * `brain dream [kind]` — an ergonomic wrapper over the generated `dream_now` op (admin). Triggers a
 * Dream sweep for the active tenant; `kind` defaults to `all`. The server op zod-validates `kind`
 * against `DREAM_KINDS` (@brain/db); the list here is a client-side convenience for `--help` and
 * early rejection, so it adds no trust surface.
 */
import type { Command } from "commander"
import type { CliDeps } from "../deps"
import { addGlobalFlags } from "../flags"
import { createPrinter } from "../render"
import { resolveSession } from "../session"

const DREAM_KINDS = [
  "all",
  "consolidation",
  "reflection",
  "hygiene",
  "dedup",
  "entitypages",
  "indexes",
] as const

/** Register `brain dream [kind]` (hand-written; the generated `dream_now` command still coexists). */
export const registerDreamCommands = (program: Command, deps: CliDeps): void => {
  addGlobalFlags(
    program
      .command("dream [kind]")
      .description(
        `Trigger a Dream sweep — kind is one of: ${DREAM_KINDS.join(", ")} (default: all)`,
      )
      .helpGroup("admin commands"),
  ).action(async (kind: string | undefined, _options: unknown, self: Command) => {
    const globals = self.optsWithGlobals()
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    const chosen = kind ?? "all"
    if (!(DREAM_KINDS as readonly string[]).includes(chosen)) {
      printer.error(`invalid kind '${chosen}' — expected one of: ${DREAM_KINDS.join(", ")}`)
      process.exitCode = 1
      return
    }
    try {
      const session = resolveSession(deps.loadConfig(), globals, deps.env, deps.deviceDeps)
      const client = deps.createClient(session)
      printer.print(await client.call("dream_now", false, { kind: chosen }))
    } catch (error) {
      printer.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
}

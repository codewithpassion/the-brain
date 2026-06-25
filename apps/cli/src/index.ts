#!/usr/bin/env bun
/**
 * `brain` CLI entry — wire the real `CliDeps` and hand argv to Commander. Async actions are awaited
 * via `parseAsync`; a thrown error is printed (message only — never a token/header dump, invariant
 * 17) and the process exits non-zero.
 */
import { defaultDeps } from "./deps"
import { buildProgram } from "./program"

const main = async (): Promise<void> => {
  const program = buildProgram(defaultDeps())
  await program.parseAsync(process.argv)
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

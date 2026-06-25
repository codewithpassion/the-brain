/**
 * The global flags, declared on the root AND on every leaf command so they work in either position
 * (`brain --json think …` and `brain think … --json`). Commander keeps same-named options at
 * different levels independent; `optsWithGlobals()` merges them (leaf wins), so reading is uniform.
 * None of the op inputs use these names, so there is no collision with a generated flag.
 */
import type { Command } from "commander"

export const addGlobalFlags = (command: Command): Command =>
  command
    .option("-t, --tenant <slug>", "active tenant (sent as the X-Brain-Tenant header)")
    .option("--api <url>", "API base URL (overrides the profile)")
    .option("--json", "emit raw JSON instead of the human view")
    .option("--profile <name>", "config profile to use")

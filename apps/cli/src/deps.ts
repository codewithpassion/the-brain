/**
 * The injectable runtime seam for the CLI. Every side-effecting capability (config I/O, the tRPC
 * client factory, device-flow I/O, stdout/stderr, the process env) is funnelled through `CliDeps`
 * so `buildProgram(deps)` is pure and fully unit-testable with fakes — no real filesystem, network,
 * or clock in tests. `defaultDeps()` wires the real implementations.
 */

import type { DeviceFlowDeps } from "./auth/device"
import { type BrainClient, type BrainClientOptions, createBrainClient } from "./client"
import { type BrainConfig, loadConfig, saveConfig } from "./config"

export interface CliDeps {
  env: NodeJS.ProcessEnv
  loadConfig: () => BrainConfig
  saveConfig: (config: BrainConfig) => void
  createClient: (options: BrainClientOptions) => BrainClient
  deviceDeps: DeviceFlowDeps
  out: (line: string) => void
  err: (line: string) => void
}

/** The real wiring: filesystem config, the tRPC client, global fetch, real clock, process streams. */
export const defaultDeps = (): CliDeps => ({
  env: process.env,
  loadConfig: () => loadConfig(),
  saveConfig: (config) => saveConfig(config),
  createClient: createBrainClient,
  deviceDeps: {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  },
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
})

/**
 * Placeholder smoke package. Exists solely to prove the root `bun check` gate
 * (Biome + strict TypeScript) is green. Safe to remove once real packages land.
 */

export interface Greeting {
  readonly name: string
  readonly message: string
}

export function greet(name: string): Greeting {
  return {
    name,
    message: `Hello, ${name}!`,
  }
}

/**
 * Typed reader for the Vite-exposed (browser-visible) env vars the dashboard needs at import time.
 * Server-only secrets (`CLERK_SECRET_KEY`) are read directly from `process.env` inside server
 * functions and are NOT included here — Vite would otherwise bundle them into the client.
 */

interface DashboardClientEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string
}

interface ImportMetaWithEnv {
  readonly env: Record<string, string | undefined>
}

function readRequired(
  env: Record<string, string | undefined>,
  key: keyof DashboardClientEnv,
): string {
  const value = env[key]
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var ${key}`)
  }
  return value
}

export function getClientEnv(): DashboardClientEnv {
  const env = (import.meta as unknown as ImportMetaWithEnv).env
  return {
    VITE_CLERK_PUBLISHABLE_KEY: readRequired(env, "VITE_CLERK_PUBLISHABLE_KEY"),
  }
}

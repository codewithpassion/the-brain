import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Dashboard build config (TanStack Start + React 19 + Tailwind v4).
 *
 * v1 targets the DEFAULT (Nitro/node) Start output so `vite build` is deterministic and the
 * `bun check` gate (biome + tsc + bun test, NO vite) stays green regardless of the deploy adapter.
 * The remaining deploy step (co-location in apps/api OR a standalone Worker) is to add
 * `@cloudflare/vite-plugin` here + the `wrangler.jsonc` `main: "@tanstack/react-start/server-entry"`
 * (see ./wrangler.jsonc) — documented, not wired, to keep the build off the heavy Workers adapter.
 */
export default defineConfig({
  server: { port: 3001 },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})

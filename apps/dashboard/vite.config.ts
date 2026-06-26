import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Dashboard build config (TanStack Start + React 19 + Tailwind v4).
 *
 * Deploy target: Cloudflare Workers. `@cloudflare/vite-plugin` runs the SSR worker in the Workers
 * runtime and emits the deployable Worker (entry: `@tanstack/react-start/server-entry` — see
 * ./wrangler.jsonc) plus the client bundle, so `vite build` produces the artifact `wrangler deploy`
 * ships. The plugin is assigned to the `ssr` environment per the TanStack Start + Cloudflare guide.
 */
export default defineConfig({
  server: { port: 3001 },
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-router"],
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

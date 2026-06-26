/**
 * `getRouter` — the contract TanStack Start's server/client entries call to obtain a router instance
 * (one per request on the server). File-based routing: the route tree is GENERATED from `src/routes`
 * into `./routeTree.gen.ts` by the `tanstackStart()` vite plugin (via `@tanstack/router-plugin`) at
 * dev/build time.
 */
import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultPreload: "intent" })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

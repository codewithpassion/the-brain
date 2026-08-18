/**
 * `/wiki-media/<id>` — the browser-facing image URL baked into wiki page bodies (`![alt](/wiki-media/<id>)`).
 *
 * A SERVER-ONLY route (only `server.handlers` — the TanStack Start plugin prunes it from the client
 * route tree, so this module's server-only imports never reach the browser bundle). It reuses the SAME
 * `resolveBrainAuth` machinery as the server fns (Clerk cookie → JWT + tenant pin), then streams the
 * bytes from `apps/api`'s bearer-authed `GET /wiki/media/:id` over the `BRAIN_API` service binding —
 * so a signed-out request 401s and a cross-tenant id 404s (the API is authoritative on tenant access).
 * Serving via a real GET route (not a base64 server fn) means the same URL renders in BOTH the
 * react-markdown view and the TipTap editor's <img>.
 */
import { env } from "cloudflare:workers"
import { createFileRoute } from "@tanstack/react-router"
import { resolveBrainAuth } from "../server/brain"

const apiBase = (): string =>
  (process.env.BRAIN_API_URL ?? "http://localhost:8787").replace(/\/$/, "")

export const Route = createFileRoute("/wiki-media/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        let auth: Awaited<ReturnType<typeof resolveBrainAuth>>
        try {
          auth = await resolveBrainAuth()
        } catch {
          return new Response("unauthorized", { status: 401 })
        }
        const upstream = await env.BRAIN_API.fetch(
          `${apiBase()}/wiki/media/${encodeURIComponent(params.id)}`,
          {
            headers: {
              authorization: `Bearer ${auth.token}`,
              "x-brain-tenant": auth.tenant,
            },
          },
        )
        if (!upstream.ok) return new Response(null, { status: upstream.status })
        // Stream the body through, propagating the content-type + immutable cache headers.
        const headers = new Headers()
        const ct = upstream.headers.get("content-type")
        if (ct !== null) headers.set("content-type", ct)
        const cc = upstream.headers.get("cache-control")
        if (cc !== null) headers.set("cache-control", cc)
        return new Response(upstream.body, { status: 200, headers })
      },
    },
  },
})

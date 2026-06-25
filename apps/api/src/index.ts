/**
 * `@brain/api` — the SINGLE deployed Worker (PRD §9, IMPLEMENTATION_PLAN Stack).
 *
 * Phase 1e shell only: a minimal `fetch` handler so the wrangler + pool-workers harness
 * boots against real workerd. The real surfaces (Hono REST + tRPC, BrainMCP DO, `/ingest`,
 * OAuth transport, Workflows, Queue consumers, `scheduled()`) land in Phase 2.
 *
 * The handler is typed against the frozen shared ENV interface (`BrainBindings`), the only
 * sanctioned name for the raw bindings (invariant 2).
 */
import type { BrainBindings } from "@brain/db"

const handler: ExportedHandler<BrainBindings> = {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" })
    }
    return new Response("not found", { status: 404 })
  },
}

export default handler

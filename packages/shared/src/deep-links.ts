/**
 * Dashboard deep-link builders — turn a retrievable thing's identity into a URL into the frontend,
 * so an MCP/read-op result can point a human straight at the item. Pure + client-safe (no env, no
 * I/O): the caller passes the dashboard origin (`ctx.env.DASHBOARD_URL` at the surface layer).
 *
 * Every builder returns `undefined` when `base` is empty/undefined (local dev without DASHBOARD_URL)
 * so a decorated output stays byte-identical to the undecorated one — the `url` key is simply omitted,
 * never emitted as `url: undefined`. The routes mirror the dashboard's file-routes:
 *   /wiki/<slug>   /documents/<id>   /memory/<slug>   /sessions/<id>
 * Slugs may contain `/` (namespaces, `entities/<kind>/<name>`); they are already url-safe (slugify)
 * and the dashboard splat routes want the raw slash-joined path, so we do NOT encode them.
 */
import { entityPageSlug } from "./slug"

export interface BrainDeepLinks {
  wikiPage(slug: string): string | undefined
  document(id: string): string | undefined
  memory(slug: string): string | undefined
  session(id: string): string | undefined
  entity(kind: string, canonicalName: string): string | undefined
}

export const brainDeepLinks = (base: string | undefined): BrainDeepLinks => {
  const root = (base ?? "").replace(/\/+$/, "")
  const link = (path: string): string | undefined => (root === "" ? undefined : `${root}${path}`)
  return {
    wikiPage: (slug) => link(`/wiki/${slug}`),
    document: (id) => link(`/documents/${id}`),
    memory: (slug) => link(`/memory/${slug}`),
    session: (id) => link(`/sessions/${id}`),
    entity: (kind, canonicalName) => link(`/wiki/${entityPageSlug(kind, canonicalName)}`),
  }
}

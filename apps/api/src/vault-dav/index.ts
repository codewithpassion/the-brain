/**
 * WebDAV sync facade — `/dav` + `/dav/*` (docs/r2-facade-plan.md §7).
 *
 * SECURITY BOUNDARY: this module is the ONLY place that authenticates vault WebDAV
 * requests. It MUST be exempted from the main principal-resolution middleware and it
 * MUST resolve its own tenant via `resolveVaultCredentialFromEnv` before touching any
 * tenant data. Every R2 key is forced under `${tenantId}/vault/` via `ScopedR2`.
 *
 * Auth:    HTTP Basic → username:password → resolveVaultCredentialFromEnv → tenantId | null.
 * Prefix:  R2 key is always `vault/<sanitized relpath>`; ScopedR2 prepends `${tenantId}/`.
 * Ingest:  PUT/DELETE outside `vault/Brain/` → `VAULT_EVENTS_QUEUE.send` (fire-and-forget).
 */
import { resolveVaultCredentialFromEnv, ScopedR2 } from "@brain/db"
import type { Principal } from "@brain/shared"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"

// ── Path sanitization (the isolation invariant) ───────────────────────────────

/**
 * Reject paths that could escape the `vault/<relpath>` prefix. Returns the sanitized
 * relative path (no leading/trailing slashes, canonical separators) or `null` if any
 * dangerous segment is detected.
 *
 * Rejected: `..` and `.` segments, leading/trailing `/`, backslashes, null bytes, and
 * empty (double-slash) segments.
 */
export const sanitizeRelpath = (raw: string): string | null => {
  // Reject null bytes (C-string injection) and backslashes (Windows path confusion).
  if (raw.includes("\0") || raw.includes("\\")) return null
  // Strip leading slashes — the route param is already after /dav/, but be defensive.
  const stripped = raw.replace(/^\/+/, "").replace(/\/+$/, "")
  if (stripped === "") return "" // root — valid (vault collection)
  const segments = stripped.split("/")
  for (const seg of segments) {
    if (seg === "" || seg === ".." || seg === ".") return null
  }
  return stripped
}

// ── RFC1123 date formatter ────────────────────────────────────────────────────

const toRfc1123 = (d: Date): string => d.toUTCString()

// ── WebDAV XML builders ───────────────────────────────────────────────────────

interface PropEntry {
  href: string
  contentLength?: number
  lastModified?: Date
  etag?: string
  isCollection: boolean
}

/** Render one `<D:response>` block for the 207 multistatus body. */
const xmlResponse = (e: PropEntry): string => {
  const encodedHref = e.href
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
  const resourceType = e.isCollection
    ? "<D:resourcetype><D:collection/></D:resourcetype>"
    : "<D:resourcetype/>"
  const contentLength =
    e.contentLength !== undefined
      ? `<D:getcontentlength>${e.contentLength}</D:getcontentlength>`
      : ""
  const lastModified =
    e.lastModified !== undefined
      ? `<D:getlastmodified>${toRfc1123(e.lastModified)}</D:getlastmodified>`
      : ""
  const etag = e.etag !== undefined ? `<D:getetag>"${e.etag}"</D:getetag>` : ""
  return `<D:response><D:href>${encodedHref}</D:href><D:propstat><D:prop>${resourceType}${contentLength}${lastModified}${etag}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

/** Wrap a set of `<D:response>` elements in a `207 Multi-Status` body. */
const multiStatus = (responses: string[]): string =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`

// ── CORS + DAV capability headers ─────────────────────────────────────────────

const DAV_HEADERS = {
  DAV: "1,2",
  Allow: "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Depth, Destination",
  "Access-Control-Expose-Headers": "DAV, ETag, Last-Modified, Content-Length",
}

// ── Ingest event shape (matches R2EventMessage from vault-events/consume.ts) ──

interface VaultEventMsg {
  account: string
  action: string
  bucket: string
  object: { key: string; size?: number; eTag?: string }
  eventTime: string
}

// ── Mount helper ──────────────────────────────────────────────────────────────

// AppEnv must match the one in apps/api/src/index.ts so the Hono type param is compatible.
type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

/**
 * Mount the WebDAV facade on the Hono `app`. Routes:
 *   OPTIONS /dav, /dav/*    → capability response (no auth required for OPTIONS)
 *   PROPFIND /dav, /dav/*   → 207 Multi-Status listing (depth 0 or 1)
 *   GET /dav/*              → stream R2 object body
 *   HEAD /dav/*             → metadata only
 *   PUT /dav/*              → write to R2 + enqueue ingest
 *   DELETE /dav/*           → delete from R2 + enqueue delete event
 *   MKCOL /dav/*            → 201 no-op (dirs are virtual in R2)
 *
 * MUST be called AFTER the main auth middleware is exempted for `/dav` paths.
 */
export const mountVaultDav = (app: Hono<AppEnv>): void => {
  const METHODS: string[] = ["OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "DELETE", "MKCOL"]

  app.on(METHODS, ["/dav", "/dav/*"], async (c) => {
    const env = c.env

    // ── CORS preflight (no auth required) ────────────────────────────────────
    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: DAV_HEADERS })
    }

    // ── Basic auth resolution (the security gate) ─────────────────────────────
    const authHeader = c.req.header("authorization") ?? ""
    if (!authHeader.startsWith("Basic ")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { ...DAV_HEADERS, "WWW-Authenticate": 'Basic realm="brain-vault"' },
      })
    }
    let decoded: string
    try {
      decoded = atob(authHeader.slice("Basic ".length))
    } catch {
      // Malformed (non-base64) Basic credentials → 401, not an unhandled 500.
      return new Response("Unauthorized", {
        status: 401,
        headers: { ...DAV_HEADERS, "WWW-Authenticate": 'Basic realm="brain-vault"' },
      })
    }
    const colonIdx = decoded.indexOf(":")
    if (colonIdx < 0) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { ...DAV_HEADERS, "WWW-Authenticate": 'Basic realm="brain-vault"' },
      })
    }
    const username = decoded.slice(0, colonIdx)
    const password = decoded.slice(colonIdx + 1)

    const tenantId = await resolveVaultCredentialFromEnv(env, username, password)
    if (tenantId === null) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { ...DAV_HEADERS, "WWW-Authenticate": 'Basic realm="brain-vault"' },
      })
    }

    // ── Build ScopedR2 with a minimal vault-dav Principal ────────────────────
    const vaultPrincipal: Principal = {
      tenantId,
      userId: "vault-dav",
      teamIds: [],
      role: "member",
      allowedScopes: "*",
      capabilities: ["read", "write"],
      readOnly: false,
    }
    const r2 = new ScopedR2(env.BODIES, vaultPrincipal)

    // ── Extract and sanitize the vault-relative path ──────────────────────────
    // `c.req.path` is ALREADY URL-decoded by Hono. Decoding again would corrupt note
    // names containing a literal `%` (→ 500) and double-decode `%252e…` traversal. We
    // sanitize the once-decoded path directly; even an exotic literal key is contained
    // by ScopedR2's forced `${tenantId}/` prefix over an opaque keyspace.
    const rawPath = c.req.path
    const afterDav = rawPath.startsWith("/dav/") ? rawPath.slice("/dav/".length) : ""
    const relpath = sanitizeRelpath(afterDav)
    if (relpath === null) {
      return new Response("Forbidden", { status: 403, headers: DAV_HEADERS })
    }

    // The R2 key (relative to the tenant prefix — ScopedR2 adds `${tenantId}/`).
    const vaultKey = relpath === "" ? "vault" : `vault/${relpath}`
    // The full bucket key (for ingest messages).
    const fullKey = `${tenantId}/${vaultKey}`

    // ── Dispatch by method ────────────────────────────────────────────────────
    const method = c.req.method

    // ── PROPFIND ─────────────────────────────────────────────────────────────
    if (method === "PROPFIND") {
      const depth = (c.req.header("depth") ?? "0").trim()
      const davHref = relpath === "" ? "/dav/" : `/dav/${relpath}`

      if (depth === "0") {
        // Depth 0: return properties of the addressed resource.
        if (relpath === "") {
          // Root collection.
          return new Response(multiStatus([xmlResponse({ href: "/dav/", isCollection: true })]), {
            status: 207,
            headers: { ...DAV_HEADERS, "Content-Type": "application/xml; charset=utf-8" },
          })
        }
        // Try file first.
        const obj = await r2.head(vaultKey)
        if (obj !== null) {
          return new Response(
            multiStatus([
              xmlResponse({
                href: davHref,
                contentLength: obj.size,
                lastModified: obj.uploaded,
                etag: obj.etag,
                isCollection: false,
              }),
            ]),
            {
              status: 207,
              headers: { ...DAV_HEADERS, "Content-Type": "application/xml; charset=utf-8" },
            },
          )
        }
        // Check if it's a virtual collection.
        const listing = await r2.list({ prefix: `${vaultKey}/`, limit: 1 })
        if (listing.objects.length > 0 || listing.delimitedPrefixes.length > 0) {
          return new Response(
            multiStatus([xmlResponse({ href: `${davHref}/`, isCollection: true })]),
            {
              status: 207,
              headers: { ...DAV_HEADERS, "Content-Type": "application/xml; charset=utf-8" },
            },
          )
        }
        return new Response("Not Found", { status: 404, headers: DAV_HEADERS })
      }

      // Depth 1: list the collection's direct children.
      const listPrefix = relpath === "" ? "vault/" : `${vaultKey}/`
      const listing = await r2.list({ prefix: listPrefix, delimiter: "/" })

      // The tenant prefix length for stripping from R2 keys.
      const stripPrefix = `${tenantId}/vault/`

      const entries: PropEntry[] = []
      // Include the collection itself first.
      entries.push({ href: relpath === "" ? "/dav/" : `${davHref}/`, isCollection: true })

      // Direct child files.
      for (const obj of listing.objects) {
        const vaultRelPath = obj.key.startsWith(stripPrefix)
          ? obj.key.slice(stripPrefix.length)
          : obj.key
        if (vaultRelPath === "") continue
        entries.push({
          href: `/dav/${vaultRelPath}`,
          contentLength: obj.size,
          lastModified: obj.uploaded,
          etag: obj.etag,
          isCollection: false,
        })
      }

      // Virtual subdirectories (from delimited prefixes).
      for (const prefix of listing.delimitedPrefixes) {
        const vaultRelPath = prefix.startsWith(stripPrefix)
          ? prefix.slice(stripPrefix.length)
          : prefix
        if (vaultRelPath === "") continue
        entries.push({ href: `/dav/${vaultRelPath}`, isCollection: true })
      }

      return new Response(multiStatus(entries.map(xmlResponse)), {
        status: 207,
        headers: { ...DAV_HEADERS, "Content-Type": "application/xml; charset=utf-8" },
      })
    }

    // ── GET ───────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const obj = await r2.get(vaultKey)
      if (obj === null) return new Response("Not Found", { status: 404, headers: DAV_HEADERS })
      const headers: Record<string, string> = {
        ...DAV_HEADERS,
        "Content-Length": String(obj.size),
        "Last-Modified": toRfc1123(obj.uploaded),
        ETag: `"${obj.etag}"`,
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      }
      return new Response(obj.body, { status: 200, headers })
    }

    // ── HEAD ──────────────────────────────────────────────────────────────────
    if (method === "HEAD") {
      const obj = await r2.head(vaultKey)
      if (obj === null) return new Response(null, { status: 404, headers: DAV_HEADERS })
      return new Response(null, {
        status: 200,
        headers: {
          ...DAV_HEADERS,
          "Content-Length": String(obj.size),
          "Last-Modified": toRfc1123(obj.uploaded),
          ETag: `"${obj.etag}"`,
        },
      })
    }

    // ── PUT ───────────────────────────────────────────────────────────────────
    if (method === "PUT") {
      if (relpath === "")
        return new Response("Method Not Allowed", { status: 405, headers: DAV_HEADERS })
      const obj = await r2.put(vaultKey, c.req.raw.body)
      const isCreate = obj !== null
      const status = isCreate ? 201 : 204

      // Enqueue ingest event — skip Brain/ (loop-avoidance: same rule as consume.ts isVaultNote).
      const isBrainAuthored = relpath === "Brain" || relpath.startsWith("Brain/")
      if (env.VAULT_EVENTS_QUEUE && !isBrainAuthored) {
        const msgObj: VaultEventMsg["object"] = { key: fullKey }
        if (obj?.size !== undefined) msgObj.size = obj.size
        if (obj?.etag !== undefined) msgObj.eTag = obj.etag
        const msg: VaultEventMsg = {
          account: "",
          action: "PutObject",
          bucket: "the-brain-bodies",
          object: msgObj,
          eventTime: new Date().toISOString(),
        }
        c.executionCtx.waitUntil(env.VAULT_EVENTS_QUEUE.send(msg as unknown))
      }

      return new Response(null, { status, headers: DAV_HEADERS })
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      if (relpath === "")
        return new Response("Method Not Allowed", { status: 405, headers: DAV_HEADERS })
      await r2.delete(vaultKey)

      // Enqueue delete event — skip Brain/ (loop-avoidance, mirrors consume.ts isVaultNote).
      const isBrainAuthored = relpath === "Brain" || relpath.startsWith("Brain/")
      if (env.VAULT_EVENTS_QUEUE && !isBrainAuthored) {
        const msg: VaultEventMsg = {
          account: "",
          action: "DeleteObject",
          bucket: "the-brain-bodies",
          object: { key: fullKey },
          eventTime: new Date().toISOString(),
        }
        c.executionCtx.waitUntil(env.VAULT_EVENTS_QUEUE.send(msg as unknown))
      }

      return new Response(null, { status: 204, headers: DAV_HEADERS })
    }

    // ── MKCOL — virtual dirs in R2, always 201 ────────────────────────────────
    if (method === "MKCOL") {
      return new Response(null, { status: 201, headers: DAV_HEADERS })
    }

    return new Response("Method Not Allowed", { status: 405, headers: DAV_HEADERS })
  })
}

/**
 * `POST /ingest/meet` — receiver for gdrive-watcher dispatches (meeting notes / transcripts).
 *
 * SECURITY BOUNDARY: exempt from the Clerk principal middleware. A static bearer secret
 * (`MEET_INGEST_TOKEN`) is the authorization and `MEET_INGEST_TENANT_ID` fixes the tenant, so the
 * caller can never pick one. The Brain holds no Google credentials, so the watcher attaches the
 * Drive file text as `content`. Without it the dispatch is parked as a `skipped` stub tagged
 * `pending-content` (no migration needed; the status column already allows `skipped`).
 */
import { normalizePath, type ScopedServices } from "@brain/db"
import { fingerprint } from "@brain/ingest"
import { MAX_BODY_BYTES, type Principal } from "@brain/shared"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"
import { HttpError } from "../http"

type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

const PATH = "/ingest/meet"
const DOC_TYPES = ["document", "mp4", "txt"] as const
type DocType = (typeof DOC_TYPES)[number]

/** True for the path that must bypass the global auth middleware. */
export const isMeetPath = (path: string): boolean => path === PATH

/** Runs the shared ingest tail (inline or durable Workflow); supplied by `createApp`. */
export type MeetIngest = (
  env: ApiBindings,
  services: ScopedServices,
  principal: Principal,
  params: { documentId: string; r2Key: string; path: string | null },
  fp: string,
) => Promise<Record<string, unknown>>

export interface MeetDeps {
  makeServices: (env: ApiBindings, principal: Principal) => ScopedServices
  ingest: MeetIngest
}

interface MeetDispatch {
  activityId: string
  time: string
  actor?: string
  owner?: string
  fileId?: string
  fileTitle?: string
  docType?: DocType
  content?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Validate the dispatch body; throws a 400 naming the first bad field. */
const parseDispatch = (raw: unknown): MeetDispatch => {
  if (!isRecord(raw)) throw new HttpError(400, "body must be a JSON object")
  const str = (key: string, required: boolean, max: number): string | undefined => {
    const v = raw[key]
    if (v === undefined || v === null) {
      if (required) throw new HttpError(400, `${key} is required`)
      return undefined
    }
    if (typeof v !== "string" || v.length > max || (required && v.trim() === "")) {
      throw new HttpError(400, `${key} must be a string of at most ${max} chars`)
    }
    return v
  }
  const activityId = str("activityId", true, 200) as string
  const time = str("time", true, 64) as string
  const docType = str("docType", false, 16)
  if (docType !== undefined && !(DOC_TYPES as readonly string[]).includes(docType)) {
    throw new HttpError(400, `docType must be one of ${DOC_TYPES.join(", ")}`)
  }
  const actor = str("actor", false, 320)
  const owner = str("owner", false, 320)
  const fileId = str("fileId", false, 200)
  const fileTitle = str("fileTitle", false, 500)
  const content = str("content", false, MAX_BODY_BYTES)
  return {
    activityId,
    time,
    ...(actor !== undefined ? { actor } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(fileId !== undefined ? { fileId } : {}),
    ...(fileTitle !== undefined ? { fileTitle } : {}),
    ...(docType !== undefined ? { docType: docType as DocType } : {}),
    ...(content !== undefined ? { content } : {}),
  }
}

/** Constant-time bearer check: compare SHA-256 digests so lengths always match. */
const bearerMatches = async (header: string | undefined, secret: string): Promise<boolean> => {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : ""
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/** `YYYY-MM-DD` from the dispatch time, or `undated` when it does not parse. */
const dateOf = (time: string): string => {
  const d = new Date(time)
  return Number.isNaN(d.getTime()) ? "undated" : d.toISOString().slice(0, 10)
}

export const mountMeet = (app: Hono<AppEnv>, deps: MeetDeps): void => {
  app.post(PATH, async (c) => {
    const secret = c.env.MEET_INGEST_TOKEN
    const tenantId = c.env.MEET_INGEST_TENANT_ID
    if (!(secret && tenantId)) throw new HttpError(503, "meet ingest is not configured")
    if (!(await bearerMatches(c.req.header("authorization"), secret))) {
      throw new HttpError(401, "invalid bearer token")
    }

    const declared = Number(c.req.header("content-length"))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new HttpError(413, `body exceeds the ${MAX_BODY_BYTES}-byte cap`)
    }
    let json: unknown
    try {
      json = await c.req.json()
    } catch {
      throw new HttpError(400, "body must be valid JSON")
    }
    const d = parseDispatch(json)

    // Service principal: tenant is fixed by env, never by the caller.
    const principal: Principal = {
      tenantId,
      userId: "meet-ingest",
      teamIds: [],
      role: "member",
      allowedScopes: "*",
      capabilities: ["read", "write"],
      readOnly: false,
    }
    const services = deps.makeServices(c.env, principal)

    const title = d.fileTitle?.trim() || d.activityId
    const hasContent = d.content !== undefined && d.content.trim() !== ""
    const tags = [
      "meet",
      ...(d.docType ? [d.docType] : []),
      ...(hasContent ? [] : ["pending-content"]),
    ]
    const path = normalizePath(`meetings/${dateOf(d.time)}/${title.replace(/\//g, "-")}`)

    // Pending stubs use their own slug so a later dispatch with content still ingests.
    const slug = hasContent ? `meet/${d.activityId}` : `meet-pending/${d.activityId}`
    const body = hasContent
      ? (d.content as string)
      : `# ${title}\n\nPending content.\n\n\`\`\`json\n${JSON.stringify({ ...d, content: undefined }, null, 2)}\n\`\`\`\n`
    const fp = await fingerprint(body)
    const documentId = crypto.randomUUID()
    const r2Key = `documents/${documentId}`

    let docId: string
    try {
      docId = await services.db.insertDocument({
        id: documentId,
        slug,
        fingerprint: fp,
        title,
        contentType: "text/markdown",
        bodyR2Key: r2Key,
        status: hasContent ? "pending" : "skipped",
        ...(d.fileId !== undefined ? { sourceUri: d.fileId } : {}),
        sourceKind: "gdrive-meet",
        tags,
        ...(path !== null ? { path } : {}),
      })
    } catch {
      const existing = (await services.db.listDocuments()).find(
        (doc) => doc.slug === slug || doc.fingerprint === fp,
      )
      return c.json({ status: "duplicate" as const, documentId: existing?.id ?? null, slug })
    }

    await services.blobs.put(r2Key, body)
    if (!hasContent) {
      return c.json({ status: "stored-pending-content" as const, documentId: docId, slug }, 202)
    }
    const result = await deps.ingest(
      c.env,
      services,
      principal,
      { documentId: docId, r2Key, path },
      fp,
    )
    return c.json({ ...result, documentId: docId, slug })
  })
}

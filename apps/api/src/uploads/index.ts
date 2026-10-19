/**
 * `PUT /uploads/:token` — the upload half of `request_upload` / `complete_ingest`.
 *
 * SECURITY BOUNDARY: this route is exempt from the main principal middleware (the caller is a bare
 * `curl` with no credentials); the signed, short-lived token IS the authorization. It can only do one
 * thing: write one blob at `uploads/<uploadId>` under the token's tenant. The content type comes from
 * the token, never from the request. Nothing is indexed until `complete_ingest` runs.
 */
import { createScopedBlobs, nowSeconds, stagedUploadKey, verifyUploadToken } from "@brain/db"
import { MAX_BODY_BYTES, type Principal } from "@brain/shared"
import type { Hono } from "hono"
import type { ApiBindings } from "../bindings"

// Must match the AppEnv in apps/api/src/index.ts so the Hono type param is compatible.
type AppEnv = { Bindings: ApiBindings; Variables: { principal: Principal } }

const PREFIX = "/uploads/"

/** True for paths that must bypass the global auth middleware. */
export const isUploadPath = (path: string): boolean => path.startsWith(PREFIX)

export const mountUploads = (app: Hono<AppEnv>): void => {
  app.put(`${PREFIX}:token`, async (c) => {
    const claims = await verifyUploadToken(
      c.env.DEVICE_FLOW_SECRET,
      c.req.param("token"),
      nowSeconds(),
    )
    if (claims === null) return c.text("invalid or expired upload url", 401)

    // Reject on the declared length before buffering; the post-buffer check backstops chunked bodies.
    const declared = Number(c.req.header("content-length"))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.text(`body exceeds the ${MAX_BODY_BYTES}-byte upload cap`, 413)
    }
    const body = await c.req.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES) {
      return c.text(`body exceeds the ${MAX_BODY_BYTES}-byte upload cap`, 413)
    }
    if (body.byteLength === 0) return c.text("empty body", 400)

    // ScopedR2 reads only `tenantId`; the rest of this Principal is a placeholder, never used for authz.
    const principal: Principal = {
      tenantId: claims.tenantId,
      userId: claims.userId,
      teamIds: [],
      role: "member",
      allowedScopes: [],
      capabilities: ["write"],
      readOnly: false,
    }
    await createScopedBlobs(c.env, principal).put(stagedUploadKey(claims.uploadId), body, {
      httpMetadata: { contentType: claims.contentType },
    })
    return c.json({ uploadId: claims.uploadId, bytes: body.byteLength, next: "complete_ingest" })
  })
}

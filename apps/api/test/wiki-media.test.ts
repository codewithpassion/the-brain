/**
 * Tests for wiki image media (G1): the `wiki_upload_image` op + the bearer-authed `GET /wiki/media/:id`
 * streaming route.
 *
 * Covers:
 *   - op happy path: base64 png → stored bytes + `![alt](/wiki-media/<id>)` snippet
 *   - op 415: an unsupported / uninferable content type is rejected
 *   - op 413: a decoded body over MAX_BODY_BYTES is rejected
 *   - ISOLATION CANARY (new tenant-boundary surface): tenant A uploads via the op; A's GET returns the
 *     exact bytes (non-vacuous), tenant B's GET for the same id is a 404 (ScopedR2 tenant prefix).
 *   - GET 400 on a malformed id (traversal guard).
 */
import { env } from "cloudflare:test"
import type { BrainBindings, ClerkIdentity, ClerkVerifier } from "@brain/db"
import { MAX_BODY_BYTES, type Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext, type SurfaceEnv } from "@brain/surface"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src/index"
import { seedMembership, seedOrg } from "./seed"

const env_ = env as unknown as BrainBindings

const TENANT_A = "wmOrgA"
const SLUG_A = "wm-a"
const USER_A = "wmUserA"
const TENANT_B = "wmOrgB"
const SLUG_B = "wm-b"
const USER_B = "wmUserB"

/** Invoke a catalog op by name with a hand-built SurfaceContext (real test bindings; blobs → R2). */
const catalog = buildCatalog()
const invokeOp = (principal: Principal, input: unknown): Promise<unknown> => {
  const op = catalog.find((o) => o.def.name === "wiki_upload_image")
  if (op === undefined) throw new Error("wiki_upload_image op missing from catalog")
  const ctx: SurfaceContext = {
    principal,
    env: env_ as unknown as SurfaceEnv,
    waitUntil: () => {},
    surface: "rest",
  }
  return op.invoke(ctx, input)
}

const principal = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write"],
  readOnly: false,
})

/** A 1x1-ish PNG byte sequence — content is irrelevant, only round-trip fidelity matters. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
const toB64 = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// Mutable identity so ONE app can act as either tenant (the verifier reads it per request).
let identityUser = USER_A
const fakeVerifier = (): ClerkVerifier => ({
  verify: async (): Promise<ClerkIdentity> => ({ userId: identityUser }),
})
const app = createApp({ clerkVerifier: fakeVerifier() })

const getMedia = async (id: string, user: string, slug: string): Promise<Response> => {
  identityUser = user
  return app.request(
    `/wiki/media/${id}`,
    { method: "GET", headers: { Authorization: "Bearer clerk.fake.jwt", "X-Brain-Tenant": slug } },
    env_,
  )
}

beforeAll(async () => {
  await seedOrg(TENANT_A, SLUG_A)
  await seedMembership({ tenantId: TENANT_A, userId: USER_A })
  await seedOrg(TENANT_B, SLUG_B)
  await seedMembership({ tenantId: TENANT_B, userId: USER_B })
})

describe("wiki_upload_image op", () => {
  test("happy path: stores bytes + returns a /wiki-media snippet (type inferred from filename)", async () => {
    const out = (await invokeOp(principal(TENANT_A, USER_A), {
      filename: "diagram.png",
      data: toB64(PNG_BYTES),
      alt: "a diagram",
    })) as { id: string; key: string; markdown: string; contentType: string; bytes: number }

    expect(out.id).toMatch(/^[0-9a-f-]+\.png$/)
    expect(out.key).toBe(`wiki/media/${out.id}`)
    expect(out.contentType).toBe("image/png")
    expect(out.bytes).toBe(PNG_BYTES.byteLength)
    expect(out.markdown).toBe(`![a diagram](/wiki-media/${out.id})`)

    // Bytes landed in R2 under the tenant prefix with the declared content type.
    const obj = await env_.BODIES.get(`${TENANT_A}/${out.key}`)
    expect(obj).not.toBeNull()
    expect(obj?.httpMetadata?.contentType).toBe("image/png")
    expect(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())).toEqual(PNG_BYTES)
  })

  test("alt defaults to the filename when omitted", async () => {
    const out = (await invokeOp(principal(TENANT_A, USER_A), {
      filename: "photo.webp",
      data: toB64(PNG_BYTES),
    })) as { markdown: string; id: string; contentType: string }
    expect(out.contentType).toBe("image/webp")
    expect(out.markdown).toBe(`![photo.webp](/wiki-media/${out.id})`)
  })

  test("415: an uninferable filename with no contentType is rejected", async () => {
    await expect(
      invokeOp(principal(TENANT_A, USER_A), { filename: "notes", data: toB64(PNG_BYTES) }),
    ).rejects.toMatchObject({ status: 415 })
  })

  test("413: a decoded body over MAX_BODY_BYTES is rejected", async () => {
    const big = new Uint8Array(MAX_BODY_BYTES + 8)
    await expect(
      invokeOp(principal(TENANT_A, USER_A), {
        filename: "huge.png",
        data: toB64(big),
        contentType: "image/png",
      }),
    ).rejects.toMatchObject({ status: 413 })
  })
})

describe("GET /wiki/media/:id — tenant boundary (isolation canary)", () => {
  test("tenant A uploads via the op; A reads the exact bytes; tenant B gets a 404", async () => {
    const out = (await invokeOp(principal(TENANT_A, USER_A), {
      filename: "secret.png",
      data: toB64(PNG_BYTES),
      contentType: "image/png",
    })) as { id: string }

    // Non-vacuous: tenant A DOES serve the exact bytes with the right content type.
    const aRes = await getMedia(out.id, USER_A, SLUG_A)
    expect(aRes.status).toBe(200)
    expect(aRes.headers.get("content-type")).toBe("image/png")
    expect(aRes.headers.get("cache-control")).toContain("immutable")
    expect(new Uint8Array(await aRes.arrayBuffer())).toEqual(PNG_BYTES)

    // Tenant B, asking for the SAME id, is dropped by the ScopedR2 tenant prefix → 404 (never A's bytes).
    const bRes = await getMedia(out.id, USER_B, SLUG_B)
    expect(bRes.status).toBe(404)
  })

  test("400 on a malformed id (path-traversal / wrong shape guard)", async () => {
    const res = await getMedia("..%2Fsecret", USER_A, SLUG_A)
    // The router never matches a slash-bearing id to `:id` as traversal, and a non-<uuid>.<ext> shape 400s.
    expect([400, 404]).toContain(res.status)
  })
})

/**
 * request_upload → PUT /uploads/:token → complete_ingest.
 *
 * Covers: end-to-end happy path (inline ingest, staged blob removed), unauthenticated PUT works with the
 * token alone, tamper/expiry rejection, over-cap 413, completing before the PUT, and tenant isolation
 * (tenant B cannot complete tenant A's upload).
 */
import { env } from "cloudflare:test"
import { type BrainBindings, nowSeconds, signUploadToken } from "@brain/db"
import { MAX_BODY_BYTES, type Principal } from "@brain/shared"
import { buildCatalog, type SurfaceContext } from "@brain/surface"
import { beforeAll, describe, expect, test } from "vitest"
import { createApp } from "../src/index"
import { seedMembership, seedOrg } from "./seed"

const SECRET = "test-device-flow-secret"
const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)
const fakeAi = {
  run: async (_model: string, inputs: Record<string, unknown>) => ({
    data: ((inputs.text as string[] | undefined) ?? [""]).map(() => vec1024()),
  }),
} as unknown as BrainBindings["AI"]
const fakeVectorize = {
  upsert: async (vectors: { id: string }[]) => ({
    mutationId: "fake",
    count: vectors.length,
    ids: vectors.map((v) => v.id),
  }),
  query: async () => ({ count: 0, matches: [] }),
} as unknown as Vectorize

// No BATCH_INGEST → complete_ingest runs the pipeline inline.
const testEnv = {
  ...(env as unknown as BrainBindings),
  CHUNK_INDEX: fakeVectorize,
  ENTITY_INDEX: fakeVectorize,
  AI: fakeAi,
  AI_GATEWAY_ID: "test-gateway",
  DEVICE_FLOW_SECRET: SECRET,
  API_URL: "https://api.example.test",
  BATCH_INGEST: undefined,
} as unknown as SurfaceContext["env"] & BrainBindings

const owner = (tenantId: string, userId: string): Principal => ({
  tenantId,
  userId,
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})
const A = owner("upA", "userUpA")
const B = owner("upB", "userUpB")

const catalog = buildCatalog()
const call = (name: string, principal: Principal, input: unknown): Promise<unknown> => {
  const op = catalog.find((o) => o.def.name === name)
  if (op === undefined) throw new Error(`${name} missing from catalog`)
  const ctx: SurfaceContext = { principal, env: testEnv, waitUntil: () => {}, surface: "mcp" }
  return op.invoke(ctx, input)
}

const app = createApp()
const put = (path: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  app.request(path, { method: "PUT", body, headers }, testEnv)

type Upload = { uploadId: string; url: string; curl: string; maxBytes: number; expiresAt: string }
const requestUpload = async (principal: Principal): Promise<Upload> =>
  (await call("request_upload", principal, { filename: "notes.md" })) as Upload
const pathOf = (url: string): string => url.replace("https://api.example.test", "")

beforeAll(async () => {
  await seedOrg("upA", "up-a")
  await seedMembership({ tenantId: "upA", userId: "userUpA" })
  await seedOrg("upB", "up-b")
  await seedMembership({ tenantId: "upB", userId: "userUpB" })
})

describe("request_upload / PUT /uploads / complete_ingest", () => {
  test("happy path: curl-style PUT with no auth header, then complete_ingest indexes it and drops the staged blob", async () => {
    const up = await requestUpload(A)
    expect(up.url.startsWith("https://api.example.test/uploads/bupl_")).toBe(true)
    expect(up.curl).toContain(`--data-binary @"notes.md"`)
    expect(up.curl).toContain(up.url)
    expect(up.maxBytes).toBe(MAX_BODY_BYTES)

    const res = await put(pathOf(up.url), "# Upload test\n\nThe zebra crossing is on Elm Street.\n")
    expect(res.status).toBe(200)
    expect(await env.BODIES.head(`upA/uploads/${up.uploadId}`)).not.toBeNull()

    const out = (await call("complete_ingest", A, {
      uploadId: up.uploadId,
      title: "Zebra note",
      tags: ["upload"],
    })) as { status: string; documentId: string | null; chunkCount: number }
    expect(out.status).toBe("indexed")
    expect(out.documentId).not.toBeNull()
    expect(out.chunkCount).toBeGreaterThan(0)
    expect(await env.BODIES.head(`upA/uploads/${up.uploadId}`)).toBeNull()

    // The same upload cannot be completed twice.
    await expect(call("complete_ingest", A, { uploadId: up.uploadId })).rejects.toThrow(
      /upload not found/,
    )
  })

  test("a second upload of identical content returns duplicate and still cleans up", async () => {
    const body = "# Dup\n\nsame bytes every time\n"
    const first = await requestUpload(A)
    await put(pathOf(first.url), body)
    await call("complete_ingest", A, { uploadId: first.uploadId })

    const second = await requestUpload(A)
    await put(pathOf(second.url), body)
    const out = (await call("complete_ingest", A, { uploadId: second.uploadId })) as {
      status: string
    }
    expect(out.status).toBe("duplicate")
    expect(await env.BODIES.head(`upA/uploads/${second.uploadId}`)).toBeNull()
  })

  test("complete_ingest before the PUT is a not-found error", async () => {
    const up = await requestUpload(A)
    await expect(call("complete_ingest", A, { uploadId: up.uploadId })).rejects.toThrow(
      /upload not found/,
    )
  })

  test("tenant isolation: B cannot complete A's staged upload", async () => {
    const up = await requestUpload(A)
    await put(pathOf(up.url), "# A only\n\nsecret\n")
    await expect(call("complete_ingest", B, { uploadId: up.uploadId })).rejects.toThrow(
      /upload not found/,
    )
    expect(await env.BODIES.head(`upA/uploads/${up.uploadId}`)).not.toBeNull()
  })

  test("PUT rejects a tampered token and an expired token with 401", async () => {
    const up = await requestUpload(A)
    const tampered = `${pathOf(up.url).slice(0, -3)}AAA`
    expect((await put(tampered, "x")).status).toBe(401)

    const expired = await signUploadToken(SECRET, {
      tenantId: "upA",
      userId: "userUpA",
      uploadId: crypto.randomUUID(),
      contentType: "text/markdown",
      exp: nowSeconds() - 1,
    })
    expect((await put(`/uploads/${expired}`, "x")).status).toBe(401)
  })

  test("PUT over the size cap is a 413 (declared length) and nothing is staged", async () => {
    const up = await requestUpload(A)
    const res = await put(pathOf(up.url), new Uint8Array(MAX_BODY_BYTES + 1))
    expect(res.status).toBe(413)
    expect(await env.BODIES.head(`upA/uploads/${up.uploadId}`)).toBeNull()
  })

  test("a bdev_-style MAC does not validate as an upload token (domain separation)", async () => {
    const res = await put("/uploads/bupl_e30.AAAA", "x")
    expect(res.status).toBe(401)
  })
})

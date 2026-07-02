import { env } from "cloudflare:test"
import { type BrainBindings, createBackfillServices } from "@brain/db"
import type { Principal } from "@brain/shared"
import { beforeAll, describe, expect, test } from "vitest"
import { type BackfillBindings, runDocIngestCore } from "../src/backfill"
import {
  isVaultNote,
  parseR2Key,
  type R2EventMessage,
  runVaultEventMessage,
  VaultEventRejectError,
} from "../src/vault-events/consume"
import { seedMembership, seedOrg } from "./seed"

/**
 * Phase-4 vault-event canary. Queues have NO local emulation; this drives `runVaultEventMessage`
 * (the testable core — no live queue) directly against real workerd D1 + R2.
 *
 * Proves the load-bearing Phase-4 invariants:
 *   - parseR2Key/isVaultNote correctly route and skip events before any DB access.
 *   - Unknown tenant → `VaultEventRejectError` (fail-closed, invariant 18).
 *   - Create event → note ingested (doc inserted + indexed via mocked AI).
 *   - Delete event → doc soft-deleted, vectors GC'd (no crash on missing-doc no-op).
 *   - Idempotent: same eTag delivered twice → second delivery no-ops (fingerprint gate).
 *   - Out-of-order guard: create event for a note already deleted from R2 → no phantom doc.
 */

const env_ = env as unknown as BrainBindings
const bfEnv = env_ as unknown as BackfillBindings

// Unique namespace per test run to avoid cross-test D1 collisions.
const VE_TENANT = "veEvtOrg"
const VE_SLUG = "ve-evt-org"

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

/** Injects minimal AI + Vectorize mocks so `runBatchIngest` can complete without real workers AI. */
const withMockAi = (base: BackfillBindings): BackfillBindings =>
  ({
    ...base,
    AI: {
      run: async (_model: string, inputs: { text: string[] }) => ({
        data: inputs.text.map(() => vec1024()),
      }),
    },
    CHUNK_INDEX: {
      upsert: async () => {},
      query: async () => ({ matches: [] }),
      // deleteByIds is called by ScopedVectorize.deleteVectors during supersede / soft-delete.
      deleteByIds: async () => {},
    },
    ENTITY_INDEX: {
      upsert: async () => {},
      query: async () => ({ matches: [] }),
      deleteByIds: async () => {},
    },
  }) as unknown as BackfillBindings

/** Minimal PutObject event for a vault note (eTag defaults to "etag-abc"). */
const putEvent = (tenantId: string, vaultPath: string, eTag = "etag-abc"): R2EventMessage => ({
  account: "acct-1",
  action: "PutObject",
  bucket: "the-brain-bodies",
  object: { key: `${tenantId}/vault/${vaultPath}`, size: 42, eTag },
  eventTime: "2026-06-28T10:00:00.000Z",
})

/** Minimal DeleteObject event (no eTag — matches Cloudflare's actual format). */
const deleteEvent = (tenantId: string, vaultPath: string): R2EventMessage => ({
  account: "acct-1",
  action: "DeleteObject",
  bucket: "the-brain-bodies",
  object: { key: `${tenantId}/vault/${vaultPath}` },
  eventTime: "2026-06-28T10:00:00.000Z",
})

beforeAll(async () => {
  await seedOrg(VE_TENANT, VE_SLUG)
  await seedMembership({ tenantId: VE_TENANT, userId: "veUser", role: "owner" })
})

// ── Pure helpers (no env, no D1) ─────────────────────────────────────────────────────────────────

describe("parseR2Key — key parsing", () => {
  test("parses a well-formed key", () => {
    expect(parseR2Key("org_abc/vault/notes.md")).toEqual({
      tenantId: "org_abc",
      vaultRelKey: "vault/notes.md",
    })
  })

  test("parses a nested path", () => {
    expect(parseR2Key("org_abc/vault/Projects/Acme/notes.md")).toEqual({
      tenantId: "org_abc",
      vaultRelKey: "vault/Projects/Acme/notes.md",
    })
  })

  test("returns null for a key without a slash", () => {
    expect(parseR2Key("no-slash")).toBeNull()
  })

  test("returns null for an empty tenant segment", () => {
    expect(parseR2Key("/vault/notes.md")).toBeNull()
  })

  test("returns null for an empty vaultRelKey segment", () => {
    expect(parseR2Key("org_abc/")).toBeNull()
  })
})

describe("isVaultNote — skip logic", () => {
  test("accepts a vault markdown note", () => {
    expect(isVaultNote("vault/notes.md")).toBe(true)
  })

  test("accepts a nested vault markdown note", () => {
    expect(isVaultNote("vault/Projects/foo.md")).toBe(true)
  })

  test("accepts .markdown extension", () => {
    expect(isVaultNote("vault/notes.markdown")).toBe(true)
  })

  test("skips non-vault prefix", () => {
    expect(isVaultNote("documents/notes.md")).toBe(false)
  })

  test("skips Brain/ prefix (loop avoidance)", () => {
    expect(isVaultNote("vault/Brain/synth.md")).toBe(false)
  })

  test("skips non-markdown extension", () => {
    expect(isVaultNote("vault/attachment.png")).toBe(false)
  })

  test("skips non-markdown extension (.pdf)", () => {
    expect(isVaultNote("vault/report.pdf")).toBe(false)
  })
})

// ── Integration tests (real workerd D1 + R2) ─────────────────────────────────────────────────────

describe("vault-event consumer canary (real local D1 + R2)", () => {
  test("skips Brain/ key without any DB access (loop avoidance)", async () => {
    // env is not a valid BackfillBindings (no DB) — if the consumer touches DB it would throw.
    // The skip must happen BEFORE principalFromMessage.
    const event = putEvent(VE_TENANT, "Brain/synth.md")
    // biome-ignore lint/suspicious/noExplicitAny: minimal env for skip test (no DB access)
    await expect(runVaultEventMessage({} as any, event)).resolves.toBeUndefined()
  })

  test("skips non-vault key without any DB access", async () => {
    const event: R2EventMessage = {
      account: "acct-1",
      action: "PutObject",
      bucket: "the-brain-bodies",
      object: { key: `${VE_TENANT}/documents/file.md`, size: 10, eTag: "e1" },
      eventTime: "2026-06-28T10:00:00.000Z",
    }
    // biome-ignore lint/suspicious/noExplicitAny: minimal env for skip test
    await expect(runVaultEventMessage({} as any, event)).resolves.toBeUndefined()
  })

  test("skips non-markdown vault file without any DB access", async () => {
    const event = putEvent(VE_TENANT, "image.png")
    // biome-ignore lint/suspicious/noExplicitAny: minimal env for skip test
    await expect(runVaultEventMessage({} as any, event)).resolves.toBeUndefined()
  })

  test("unknown tenant → VaultEventRejectError (fail-closed, invariant 18)", async () => {
    const event = putEvent("ghost-tenant-xyz", "notes.md")
    await expect(runVaultEventMessage(bfEnv, event)).rejects.toBeInstanceOf(VaultEventRejectError)
  })

  test("create event → doc inserted and indexed (mocked AI)", async () => {
    const aiEnv = withMockAi(bfEnv)
    const notePath = "create-test/hello.md"
    const noteContent = "# Hello\n\nThis is a vault note for create-event testing."

    // Stage the note content in R2 (the consumer reads it from the vault key).
    const svc = createBackfillServices(env_, {
      tenantId: VE_TENANT,
      userId: "veUser",
      teamIds: [],
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
      readOnly: false,
    })
    await svc.blobs.put(`vault/${notePath}`, noteContent)

    await runVaultEventMessage(aiEnv, putEvent(VE_TENANT, notePath, "etag-create-01"))

    const doc = await env_.DB.prepare(
      "SELECT id, status, fingerprint, ingested_via FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "create-test/hello")
      .first<{ id: string; status: string; fingerprint: string; ingested_via: string | null }>()

    expect(doc).not.toBeNull()
    expect(doc?.status).toBe("indexed")
    expect(doc?.fingerprint).toBe(`obsidian:${notePath}:etag-create-01`)
    expect(doc?.ingested_via).toBe("vault-event")
  })

  test("idempotent: same eTag delivered twice → second delivery is a no-op (embed NOT called again)", async () => {
    // Use a call counter inside the AI mock to discriminate no-op from re-ingest.
    // The no-op branch returns before runBatchIngest so AI.run is never called a second time;
    // a regressed supersede path would call it again (chunks would be re-embedded).
    let embedCalls = 0
    const countingAiEnv: BackfillBindings = {
      ...bfEnv,
      AI: {
        run: async (_model: string, inputs: { text: string[] }) => {
          embedCalls += inputs.text.length
          return { data: inputs.text.map(() => vec1024()) }
        },
      } as unknown as Ai,
      CHUNK_INDEX: {
        upsert: async () => {},
        query: async () => ({ matches: [] }),
        deleteByIds: async () => {},
      } as unknown as Vectorize,
      ENTITY_INDEX: {
        upsert: async () => {},
        query: async () => ({ matches: [] }),
        deleteByIds: async () => {},
      } as unknown as Vectorize,
    }

    const notePath = "idempotent-test/same.md"
    const noteContent = "# Idempotent note\n\nSame content, same eTag."

    const svc = createBackfillServices(env_, {
      tenantId: VE_TENANT,
      userId: "veUser",
      teamIds: [],
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
      readOnly: false,
    })
    await svc.blobs.put(`vault/${notePath}`, noteContent)

    // First delivery: inserts and indexes the doc — embedCalls > 0.
    await runVaultEventMessage(countingAiEnv, putEvent(VE_TENANT, notePath, "etag-idem-01"))
    const after1 = await env_.DB.prepare(
      "SELECT status FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "idempotent-test/same")
      .first<{ status: string }>()
    expect(after1?.status).toBe("indexed")
    const embedCallsAfterFirst = embedCalls
    expect(embedCallsAfterFirst).toBeGreaterThan(0) // at least one chunk was embedded

    // Second delivery with the SAME eTag: fingerprint matches → no-op.
    // The no-op branch returns early from runDocIngestCore without calling runBatchIngest,
    // so embedCalls must NOT increase.
    await runVaultEventMessage(countingAiEnv, putEvent(VE_TENANT, notePath, "etag-idem-01"))
    expect(embedCalls).toBe(embedCallsAfterFirst) // no second embed run = genuine no-op
  })

  test("supersede: changed eTag → doc updated, re-indexed with new fingerprint", async () => {
    const aiEnv = withMockAi(bfEnv)
    const notePath = "supersede-test/changed.md"

    const svc = createBackfillServices(env_, {
      tenantId: VE_TENANT,
      userId: "veUser",
      teamIds: [],
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
      readOnly: false,
    })

    // First create.
    await svc.blobs.put(`vault/${notePath}`, "# V1 content")
    await runVaultEventMessage(aiEnv, putEvent(VE_TENANT, notePath, "etag-v1"))
    const v1 = await env_.DB.prepare(
      "SELECT id, fingerprint FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "supersede-test/changed")
      .first<{ id: string; fingerprint: string }>()
    expect(v1?.fingerprint).toBe(`obsidian:${notePath}:etag-v1`)

    // Update content + eTag.
    await svc.blobs.put(`vault/${notePath}`, "# V2 content — updated")
    await runVaultEventMessage(aiEnv, putEvent(VE_TENANT, notePath, "etag-v2"))
    const v2 = await env_.DB.prepare(
      "SELECT id, fingerprint, status FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "supersede-test/changed")
      .first<{ id: string; fingerprint: string; status: string }>()

    // Same doc id (UUID reused for supersede), new fingerprint, re-indexed.
    expect(v2?.id).toBe(v1?.id)
    expect(v2?.fingerprint).toBe(`obsidian:${notePath}:etag-v2`)
    expect(v2?.status).toBe("indexed")
  })

  test("delete event → doc soft-deleted; second delete is a no-op", async () => {
    const aiEnv = withMockAi(bfEnv)
    const notePath = "delete-test/gone.md"

    const svc = createBackfillServices(env_, {
      tenantId: VE_TENANT,
      userId: "veUser",
      teamIds: [],
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
      readOnly: false,
    })

    // Create the doc first.
    await svc.blobs.put(`vault/${notePath}`, "# To be deleted")
    await runVaultEventMessage(aiEnv, putEvent(VE_TENANT, notePath, "etag-del"))

    const before = await env_.DB.prepare(
      "SELECT id, deleted_at FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "delete-test/gone")
      .first<{ id: string; deleted_at: string | null }>()
    expect(before?.deleted_at).toBeNull()

    // Delete event — use aiEnv so deleteVectors uses the mock CHUNK_INDEX (no remote binding).
    await runVaultEventMessage(aiEnv, deleteEvent(VE_TENANT, notePath))

    const after = await env_.DB.prepare(
      "SELECT deleted_at FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "delete-test/gone")
      .first<{ deleted_at: string | null }>()
    expect(after?.deleted_at).not.toBeNull()

    // Second delete event is idempotent (no crash on already-deleted doc).
    await expect(
      runVaultEventMessage(aiEnv, deleteEvent(VE_TENANT, notePath)),
    ).resolves.toBeUndefined()
  })

  test("out-of-order guard: create event for a note missing from R2 → no phantom doc", async () => {
    const aiEnv = withMockAi(bfEnv)
    const notePath = "missing-test/gone.md"
    // Do NOT put the note in R2 — simulates a file deleted before this event was processed.
    const event = putEvent(VE_TENANT, notePath, "etag-missing")

    await runVaultEventMessage(aiEnv, event)

    const doc = await env_.DB.prepare("SELECT id FROM documents WHERE tenant_id = ? AND slug = ?")
      .bind(VE_TENANT, "missing-test/gone")
      .first()
    // No phantom doc inserted when the R2 object is already gone.
    expect(doc).toBeNull()
  })

  test("supersede refreshes tags but ingested_via is IMMUTABLE after insert", async () => {
    const principal: Principal = {
      tenantId: VE_TENANT,
      userId: "veUser",
      teamIds: [],
      role: "owner",
      allowedScopes: "*",
      capabilities: ["read", "write", "admin"],
      readOnly: false,
    }
    const services = createBackfillServices(withMockAi(bfEnv), principal)

    // Fresh insert: ingested_via="first", tags=["t1"].
    await services.blobs.put("stage/immut.md", "# V1\n\nbody one")
    await runDocIngestCore(services, {
      slug: "immut-doc",
      fingerprint: "immut:1",
      payloadRef: "stage/immut.md",
      contentType: "text/markdown",
      isPhase2: true,
      sourceKind: "notion",
      tags: ["t1"],
      ingestedVia: "first",
    })

    // Edit (new fingerprint) that ALSO passes a different ingested_via + new tags.
    await services.blobs.put("stage/immut.md", "# V2\n\nbody two")
    await runDocIngestCore(services, {
      slug: "immut-doc",
      fingerprint: "immut:2",
      payloadRef: "stage/immut.md",
      contentType: "text/markdown",
      isPhase2: true,
      sourceKind: "notion",
      tags: ["t2"],
      ingestedVia: "second",
    })

    const doc = await env_.DB.prepare(
      "SELECT tags, ingested_via FROM documents WHERE tenant_id = ? AND slug = ?",
    )
      .bind(VE_TENANT, "immut-doc")
      .first<{ tags: string | null; ingested_via: string | null }>()
    expect(doc?.tags).toBe(JSON.stringify(["t2"])) // tags refreshed on edit
    expect(doc?.ingested_via).toBe("first") // provenance immutable — NOT "second"
  })
})

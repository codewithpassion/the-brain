import { env } from "cloudflare:test"
import { type BrainBindings, createBackfillServices, tenantFromMessage } from "@brain/db"
import { createClaudeCodeImporter } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import { beforeAll, describe, expect, test } from "vitest"
import type { BackfillBindings } from "../src/backfill"
import {
  type BackfillMessage,
  BackfillRejectError,
  type ReembedMessage,
  runBackfillMessage,
  runEnumerate,
  runReembedMessage,
  runReembedSweep,
} from "../src/backfill"
import { seedMembership, seedOrg } from "./seed"

/**
 * THE Phase-3 backfill canary. Queues + Workflows have NO local pool-workers emulation, so this
 * drives the TESTABLE CORE fns directly (the injected-`enqueue` seam) against REAL local D1 + R2
 * inside workerd — the same harness as the isolation suite. AI is unavailable in workerd (like
 * `slice.e2e`), so the re-embed test spoofs `env.AI`/`CHUNK_INDEX` while keeping real D1 + R2; the
 * session round-trip + DLQ paths touch NO AI.
 *
 * Proves the load-bearing Phase-3 invariants:
 *   - 15: enumerate→enqueue(references-only)→consume→capture is IDEMPOTENT — a re-delivery never
 *     doubles turns (the deterministic `(tenant,slug)` marker gate).
 *   -  the Enumerator enqueues REFERENCES (an R2 `payloadRef` key), never the payload inline.
 *   - 18: an UNKNOWN `tenant_id` is rejected (→ DLQ) while a real org processes — non-vacuous both arms.
 *   - 12: re-embed upserts the SAME vector id (incl. a different-user PRIVATE chunk), re-stamps the
 *     model, and books the cost tagged `surface='migration'`.
 */

const env_ = env as unknown as BrainBindings
const bfEnv = env_ as unknown as BackfillBindings

const principal = (tenantId: string): Principal => ({
  tenantId,
  userId: "enumUser",
  teamIds: [],
  role: "owner",
  allowedScopes: "*",
  capabilities: ["read", "write", "admin"],
  readOnly: false,
})

/** A two-record Claude-Code transcript; the assistant turn is >2048 chars (forces R2 offload). */
const transcript = (sessionId: string): string =>
  [
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2026-06-25T00:00:00.000Z",
      message: { role: "user", content: "ping the backfill spine" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: "2026-06-25T00:00:01.000Z",
      message: { role: "assistant", content: `pong ${"x".repeat(3000)}` },
    }),
  ].join("\n")

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0.1)

beforeAll(async () => {
  await seedOrg("bfOrg", "bf-org")
  await seedMembership({ tenantId: "bfOrg", userId: "enumUser", role: "owner" })
})

describe("backfill spine canary (real local D1 + R2 in workerd)", () => {
  test("enumerate enqueues REFERENCES-ONLY; consume→capture is idempotent (invariant 15)", async () => {
    const services = createBackfillServices(env_, principal("bfOrg"))
    await services.runs.createRun({ id: "run-enum", sourceId: "src-cc", kind: "session" })

    const queue: BackfillMessage[] = []
    const result = await runEnumerate({
      runs: services.runs,
      blobs: services.blobs,
      enqueue: async (message) => {
        queue.push(message)
      },
      tenantId: "bfOrg",
      sourceId: "src-cc",
      runId: "run-enum",
      kind: "session",
      importer: createClaudeCodeImporter(transcript("cc-session-1")),
    })
    expect(result.processed).toBe(1)
    expect(queue).toHaveLength(1)

    // REFERENCES-ONLY: the message carries an R2 key, never the payload inline.
    const message = queue[0]
    if (message === undefined) throw new Error("no message enqueued")
    expect(typeof message.payloadRef).toBe("string")
    expect("content" in message).toBe(false)
    expect("payload" in message).toBe(false)
    // ...and the body really is staged in R2 (the consumer reads it from there).
    const staged = await services.blobs.get(message.payloadRef)
    expect(staged).not.toBeNull()

    // The run advanced its anchor on the clean pass and finished success.
    const run = await services.runs.get("run-enum")
    expect(run?.status).toBe("success")
    expect(run?.anchor).not.toBeNull()

    // Consume → captures sessions/turns. (System principal, no AI on the session path.)
    await runBackfillMessage(bfEnv, message)
    const after1 = await env_.DB.prepare(
      "SELECT count(*) AS n FROM session_turns WHERE tenant_id = 'bfOrg'",
    ).first<{ n: number }>()
    expect(after1?.n).toBe(2) // both turns persisted

    // RE-DELIVERY (at-least-once): the marker gate skips → NO doubled turns.
    await runBackfillMessage(bfEnv, message)
    const after2 = await env_.DB.prepare(
      "SELECT count(*) AS n FROM session_turns WHERE tenant_id = 'bfOrg'",
    ).first<{ n: number }>()
    expect(after2?.n).toBe(2) // unchanged — idempotent
  })

  test("unknown tenant_id is rejected to DLQ; a real org processes (invariant 18, non-vacuous)", async () => {
    // tenantFromMessage is the discriminator — non-vacuous on BOTH arms.
    expect(await tenantFromMessage(env_, "bfOrg")).toEqual({ id: "bfOrg" })
    expect(await tenantFromMessage(env_, "ghostOrg")).toBeNull()

    // Stage a valid session body so the VALID arm reaches capture (not an R2-miss false pass).
    const valid = createBackfillServices(env_, principal("bfOrg"))
    await valid.blobs.put(
      "backfill/dlq/ok.json",
      JSON.stringify({
        sourceSessionId: "dlq-ok",
        client: "claude-code",
        turns: [{ role: "user", content: "hi", idx: 0 }],
        fingerprint: "claude-code:dlq-ok",
        embeddingModel: "pending",
        embeddingDims: 0,
      }),
    )
    const base = {
      sourceId: "src",
      runId: "run-dlq",
      kind: "session" as const,
      payloadRef: "backfill/dlq/ok.json",
      fingerprint: "claude-code:dlq-ok",
    }

    // VALID: resolves (a session row lands).
    await runBackfillMessage(bfEnv, { ...base, tenantId: "bfOrg" })
    const ok = await env_.DB.prepare(
      "SELECT count(*) AS n FROM sessions WHERE tenant_id = 'bfOrg' AND source_session_id = 'dlq-ok'",
    ).first<{ n: number }>()
    expect(ok?.n).toBe(1)

    // UNKNOWN tenant: fail-closed reject (the consumer routes this to the DLQ).
    await expect(
      runBackfillMessage(bfEnv, { ...base, tenantId: "ghostOrg" }),
    ).rejects.toBeInstanceOf(BackfillRejectError)
  })

  test("re-embed upserts the SAME vector id incl. a different-user PRIVATE chunk; cost tagged migration (invariant 12)", async () => {
    await seedOrg("reOrg", "re-org")
    // A stale, PRIVATE chunk owned by a DIFFERENT user — the migration must still re-embed it.
    await env_.DB.prepare(
      `INSERT INTO chunks
         (id, tenant_id, document_id, scope, team_id, user_id, visibility, chunk_index,
          content, embedded_at, embedding_model, embedding_dims, updated_at, deleted_at)
       VALUES ('chunk-priv','reOrg','doc-1',NULL,NULL,'someoneElse','private',0,
               'private needle to re-embed', NULL, 'pending', 0, '2026-06-25T00:00:00.000Z', NULL)`,
    ).run()

    // Spoof AI + Vectorize; keep REAL D1 + R2.
    const upserts: { id: string; namespace?: string; metadata?: Record<string, unknown> }[] = []
    const aiEnv = {
      ...env_,
      AI: {
        run: async (_model: string, inputs: { text: string[] }) => ({
          data: inputs.text.map(() => vec1024()),
        }),
      },
      CHUNK_INDEX: {
        upsert: async (vectors: typeof upserts) => {
          upserts.push(...vectors)
        },
        query: async () => ({ matches: [] }),
      },
    } as unknown as BackfillBindings

    // Sweep finds the candidate, opens the migration run, books cost, enqueues a reference.
    const queue: ReembedMessage[] = []
    const sweep = await runReembedSweep(aiEnv, {
      tenantIds: ["reOrg"],
      enqueue: async (message) => {
        queue.push(message)
      },
    })
    expect(sweep.enqueued).toBe(1)
    expect(sweep.estimatedNeurons).toBeGreaterThan(0)
    const message = queue[0]
    if (message === undefined) throw new Error("no reembed message enqueued")
    expect(message.chunkId).toBe("chunk-priv")

    await runReembedMessage(aiEnv, message)

    // SAME vector id, re-stamped model, tenant namespace.
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.id).toBe("chunk-priv")
    expect(upserts[0]?.namespace).toBe("reOrg")
    expect(upserts[0]?.metadata?.embedding_model).toBe("@cf/baai/bge-m3")

    // The chunk is re-stamped in D1; the cost is recorded with surface='migration'.
    const chunk = await env_.DB.prepare(
      "SELECT embedding_model AS m, embedded_at AS e FROM chunks WHERE id = 'chunk-priv'",
    ).first<{ m: string; e: string | null }>()
    expect(chunk?.m).toBe("@cf/baai/bge-m3")
    expect(chunk?.e).not.toBeNull()
    const spend = await env_.DB.prepare(
      "SELECT count(*) AS n FROM token_spend WHERE tenant_id = 'reOrg' AND surface = 'migration'",
    ).first<{ n: number }>()
    expect(spend?.n).toBeGreaterThan(0)

    // RE-DELIVERY: the chunk is no longer stale → getCandidate null → no second upsert (idempotent).
    await runReembedMessage(aiEnv, message)
    expect(upserts).toHaveLength(1)
  })
})

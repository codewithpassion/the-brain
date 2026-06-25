/**
 * Stage 1 of the backfill spine — the Enumerator (PRD §8.6).
 *
 * `runEnumerate` is the PLAIN, testable core (no Workflows runtime, which has no local emulation):
 * one instance per `(tenantId, sourceId)`, it drives a source importer through
 * `begin → nextBatch(cursor) → finalize` with:
 *   - the `runImporterContract` safety invariants (a terminal cursor is `null`; an empty batch with
 *     a NON-null cursor is a violation that would loop) enforced inline as it STREAMS;
 *   - gbrain's cursor/anchor discipline: `cursor` is persisted to `backfill_runs.cursor` after EVERY
 *     batch (a restarted enumerator resumes there); the durable `anchor` advances ONLY on a clean
 *     full pass (`finalize` reached with no per-item failure) — no silent page loss;
 *   - REFERENCES-ONLY enqueue: each item's body is staged to R2 FIRST, and the Queue message carries
 *     the R2 `payloadRef` (a key), NEVER the payload inline — staying under the Workflow 1 MiB
 *     step-output cap. The consumer reads the body from R2 itself.
 *
 * `EnumeratorWorkflow` is the deploy-time durable wrapper (mirrors `BatchIngestWorkflow`): it rebuilds
 * the scoped bundle from the serialized `Principal`, loads the source export from R2, picks the
 * importer, and runs `runEnumerate` inside a durable `step.do`. A production decomposition would make
 * each page its own `step.do(\`page-${n}\`)`; the slice wraps the drain in one step (the cursor
 * persisted per batch already makes a restart resumable).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import {
  type BackfillRunStore,
  type BackfillServices,
  createBackfillServices,
  type RunStats,
  type ScopedR2,
  ZERO_STATS,
} from "@brain/db"
import {
  createChatGptImporter,
  createClaudeCodeImporter,
  type ImportedSession,
  type Importer,
} from "@brain/ingest"
import type { Principal } from "@brain/shared"
import type { ApiBindings } from "../bindings"
import type { BackfillMessage } from "./messages"

/** The supported session-export clients (the net-new importers this phase wires into capture). */
export type ImporterClient = "chatgpt" | "claude-code"

/** Build the importer for a client over its raw export text. */
export const importerForClient = (client: ImporterClient, raw: string): Importer =>
  client === "chatgpt" ? createChatGptImporter(raw) : createClaudeCodeImporter(raw)

/** The tenant-relative R2 key an enumerated item is staged at (the message `payloadRef`). */
export const stageKey = (runId: string, fingerprint: string): string =>
  `backfill/${runId}/${fingerprint}.json`

/** Everything `runEnumerate` needs, all injectable so it runs with NO live queue/workflow. */
export interface EnumerateDeps {
  runs: BackfillRunStore
  blobs: ScopedR2
  /** Reference-only dispatch (real `env.BACKFILL_QUEUE.send` at deploy; an array push in tests). */
  enqueue: (message: BackfillMessage) => Promise<void>
  tenantId: string
  sourceId: string
  runId: string
  kind: BackfillMessage["kind"]
  importer: Importer
  /** Resume point loaded from `backfill_runs.cursor` (a restarted enumerator passes it). */
  resumeCursor?: string
}

/** The Enumerator run summary. */
export interface EnumerateResult extends RunStats {
  /** Number of pages (`nextBatch` calls) drained. */
  pages: number
}

const GUARD_LIMIT = 100_000

/**
 * Drive the importer to completion, staging+enqueuing references and persisting the cursor per
 * batch. On a clean terminal pass it `finalize`s, advances the anchor, and marks the run `success`.
 * A contract violation (empty batch / non-null cursor) or any error marks the run `failure` and
 * leaves the anchor UNTOUCHED (so a re-run resumes without losing pages) — then rethrows.
 */
export const runEnumerate = async (deps: EnumerateDeps): Promise<EnumerateResult> => {
  const stats: RunStats = { ...ZERO_STATS }
  let pages = 0
  try {
    const begin = await deps.importer.begin(
      deps.resumeCursor !== undefined ? { resumeCursor: deps.resumeCursor } : {},
    )
    let cursor = begin.cursor
    let guard = 0
    while (cursor !== null) {
      if (guard++ > GUARD_LIMIT) throw new Error("runEnumerate: cursor did not terminate")
      const batch = await deps.importer.nextBatch(cursor)
      pages++
      if (batch.items.length === 0 && batch.nextCursor !== null) {
        throw new Error("runEnumerate: empty batch with a non-null cursor (would loop)")
      }
      for (const item of batch.items) {
        const fingerprint = (item as ImportedSession).fingerprint
        const ref = stageKey(deps.runId, fingerprint)
        // Stage the body to R2 FIRST, then enqueue ONLY the reference (no payload inline).
        await deps.blobs.put(ref, JSON.stringify(item))
        await deps.enqueue({
          tenantId: deps.tenantId,
          sourceId: deps.sourceId,
          runId: deps.runId,
          kind: deps.kind,
          payloadRef: ref,
          fingerprint,
        })
        stats.processed++
        stats.created++
      }
      cursor = batch.nextCursor
      await deps.runs.persistProgress(deps.runId, cursor, stats) // resumable; anchor untouched
    }
    await deps.importer.finalize()
    await deps.runs.advanceAnchor(deps.runId, new Date().toISOString()) // clean pass ONLY
    await deps.runs.finishRun(deps.runId, "success")
    return { ...stats, pages }
  } catch (err) {
    stats.errors++
    await deps.runs.finishRun(deps.runId, "failure", err instanceof Error ? err.message : "error")
    throw err
  }
}

/** The serializable payload the `EnumeratorWorkflow` carries. */
export interface EnumeratorWorkflowParams {
  principal: Principal
  sourceId: string
  runId: string
  kind: BackfillMessage["kind"]
  client: ImporterClient
  /** Tenant-relative R2 key of the raw source export the importer parses. */
  exportR2Key: string
}

export class EnumeratorWorkflow extends WorkflowEntrypoint<ApiBindings, EnumeratorWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<EnumeratorWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<EnumerateResult> {
    const { principal, sourceId, runId, kind, client, exportR2Key } = event.payload
    const services: BackfillServices = createBackfillServices(this.env, principal)
    return step.do("enumerate", async () => {
      const obj = await services.blobs.get(exportR2Key)
      if (obj === null) throw new Error(`enumerate: source export not found at "${exportR2Key}"`)
      const raw = await obj.text()
      const run = await services.runs.get(runId)
      await services.runs.claim(runId) // optimistic queued→running
      const enqueue = async (message: BackfillMessage): Promise<void> => {
        // The producer binding is present at deploy; the workflow only runs there.
        const queue = (this.env as { BACKFILL_QUEUE?: Queue<BackfillMessage> }).BACKFILL_QUEUE
        if (queue !== undefined) await queue.send(message)
      }
      return runEnumerate({
        runs: services.runs,
        blobs: services.blobs,
        enqueue,
        tenantId: principal.tenantId,
        sourceId,
        runId,
        kind,
        importer: importerForClient(client, raw),
        ...(run?.cursor != null ? { resumeCursor: run.cursor } : {}),
      })
    })
  }
}

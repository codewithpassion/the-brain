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
  createObsidianImporter,
  type ImportedSession,
  type Importer,
  type VaultR2,
} from "@brain/ingest"
import type { Principal } from "@brain/shared"
import type { ApiBindings } from "../bindings"
import type { BackfillMessage } from "./messages"

/** Default vault prefix — must match `createObsidianImporter`'s default. */
const DEFAULT_VAULT_PREFIX = "vault/"

/**
 * Circuit-breaker thresholds for `reconcileObsidianDeletions`. A single reconcile pass
 * may delete at most `RECONCILE_DELETE_RATIO_LIMIT` of the live docs, subject to a minimum
 * floor of `RECONCILE_DELETE_FLOOR` — so small vaults don't get an unreasonably tight gate.
 * If candidates exceed the threshold the pass is aborted (not an error): self-healing will
 * occur gradually on subsequent passes or via explicit delete_document.
 */
const RECONCILE_DELETE_RATIO_LIMIT = 0.5
const RECONCILE_DELETE_FLOOR = 3

/**
 * List vault markdown slugs (vault paths minus extension, excluding `Brain/` and non-markdown
 * files). Returns a `Set<string>` for O(1) lookup. Empty-vault guard: if R2 returns zero
 * objects the function returns an empty set and the reconcile caller skips deletions.
 * Tenant prefix is stripped from keys: ScopedR2.list returns absolute R2 keys.
 *
 * Throws if R2 returns `truncated:true` with no cursor — a partial listing must never be
 * treated as complete, as that would cause spurious mass-deletes.
 *
 * @internal Exported for unit testing.
 */
export const listVaultSlugs = async (
  blobs: ScopedR2,
  tenantId: string,
  vaultPrefix: string,
): Promise<Set<string>> => {
  const slugs = new Set<string>()
  let cursor: string | undefined
  const tenantPrefixLen = tenantId.length + 1 // "${tenantId}/" length
  do {
    const result = await blobs.list({
      prefix: vaultPrefix,
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    if (result.truncated && !result.cursor) {
      throw new Error(
        "listVaultSlugs: R2 returned truncated=true with no cursor — aborting reconcile pass to avoid mass-delete on partial listing",
      )
    }
    for (const obj of result.objects) {
      if (!/\.(md|markdown)$/i.test(obj.key)) continue
      // obj.key = "${tenantId}/vault/foo.md" (absolute; ScopedR2 adds tenant prefix)
      const relKey = obj.key.slice(tenantPrefixLen)
      const vaultPath = relKey.slice(vaultPrefix.length)
      if (vaultPath.startsWith("Brain/")) continue // reserved Brain-authored prefix
      const slug = vaultPath.replace(/\.(md|markdown)$/i, "")
      if (slug.length > 0) slugs.add(slug)
    }
    cursor = result.truncated ? result.cursor : undefined
  } while (cursor !== undefined)
  return slugs
}

/**
 * Compare vault slugs against the DB and soft-delete any live obsidian docs that are no
 * longer in the vault (note deleted from Obsidian).
 *
 * Guards:
 * - Empty listing (vaultSlugs.size === 0): no-op — possible R2 hiccup.
 * - Circuit breaker: if this pass would delete more than `RECONCILE_DELETE_RATIO_LIMIT` of
 *   DB docs (min floor `RECONCILE_DELETE_FLOOR`), abort and log — the delete is deferred to
 *   later passes or explicit delete_document, avoiding transient mass-unsearchability.
 *
 * Each deleted doc's KG extraction is cleared and its Vectorize vectors are removed.
 */
export const reconcileObsidianDeletions = async (
  services: BackfillServices,
  sourceId: string,
  vaultSlugs: Set<string>,
): Promise<{ deleted: number }> => {
  if (vaultSlugs.size === 0) return { deleted: 0 } // guard: empty listing → skip
  const dbDocs = await services.db.getDocumentsBySource(sourceId)
  const toDelete = dbDocs.filter((doc) => !vaultSlugs.has(doc.slug))
  // Circuit breaker: abort if deleting too large a fraction of live docs in one pass.
  const threshold = Math.max(
    RECONCILE_DELETE_FLOOR,
    Math.ceil(dbDocs.length * RECONCILE_DELETE_RATIO_LIMIT),
  )
  if (toDelete.length > threshold) {
    console.warn(
      `reconcileObsidianDeletions: would delete ${toDelete.length}/${dbDocs.length} docs ` +
        `(threshold ${threshold}) — aborting pass to prevent mass-unsearchability`,
    )
    return { deleted: 0 }
  }
  let deleted = 0
  for (const doc of toDelete) {
    const { chunkIds, partDocumentIds } = await services.db.softDeleteDocument(doc.id)
    if (chunkIds.length > 0) {
      await services.vectors.deleteVectors(chunkIds)
    }
    // Clear KG extraction so the deleted note's entities (incl. split-doc child parts, §4.3 W4.5)
    // are no longer queryable; GC entities with zero remaining mentions across the tenant.
    await services.graph.clearExtractionForFamily([doc.id, ...partDocumentIds])
    deleted++
  }
  return { deleted }
}

/** The supported import clients. Session exporters + the Obsidian vault importer (Phase 1). */
export type ImporterClient = "chatgpt" | "claude-code" | "obsidian"

/**
 * Build the importer for a client.
 * Session importers (chatgpt, claude-code) consume a raw export string.
 * The Obsidian importer instead enumerates a live R2 vault — pass `blobs` (ScopedR2 satisfies
 * VaultR2 structurally); `raw` is unused and can be the empty string.
 */
export const importerForClient = (
  client: ImporterClient,
  raw: string,
  blobs?: VaultR2,
): Importer => {
  if (client === "chatgpt") return createChatGptImporter(raw)
  if (client === "claude-code") return createClaudeCodeImporter(raw)
  // client === "obsidian"
  if (blobs === undefined) throw new Error("obsidian importer requires blobs (VaultR2)")
  return createObsidianImporter(blobs)
}

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
        // For doc items the Obsidian importer attaches a `content` string (raw markdown).
        // Stage the markdown directly so the consumer's `runBatchIngest` gets the right body.
        // For session items (no `content` field) stage the full JSON as before.
        const asDoc = item as Partial<{
          content: string
          contentType: string
          path: string
          tags: string[]
        }>
        // Stage the body to R2 FIRST, then enqueue ONLY the reference (no payload inline).
        // Switch on deps.kind (not content presence) so a future producer cannot mis-stage.
        await deps.blobs.put(
          ref,
          deps.kind === "doc" && asDoc.content !== undefined ? asDoc.content : JSON.stringify(item),
        )
        await deps.enqueue({
          tenantId: deps.tenantId,
          sourceId: deps.sourceId,
          runId: deps.runId,
          kind: deps.kind,
          payloadRef: ref,
          fingerprint,
          ...(asDoc.contentType !== undefined ? { contentType: asDoc.contentType } : {}),
          ...(asDoc.path !== undefined ? { path: asDoc.path } : {}),
          ...(asDoc.tags !== undefined ? { tags: asDoc.tags } : {}),
          // Phase 2 D2: stable slug for doc items derived from the source-native id (vault path).
          // Absent for session items (deps.kind !== "doc") so non-obsidian paths are unaffected.
          ...(deps.kind === "doc" && (item as ImportedSession).sourceSessionId !== undefined
            ? { stableSlug: (item as ImportedSession).sourceSessionId }
            : {}),
          // Stamp the source-kind (delete-safety boundary) + provenance for doc items from the
          // importer. Notion docs → sourceKind:"notion" + ingestedVia:"notion-poll"; obsidian docs
          // → "obsidian" (unchanged from the prior isPhase2 default).
          ...(deps.kind === "doc" ? { sourceKind: deps.importer.source } : {}),
          ...(deps.kind === "doc" && deps.importer.source === "notion"
            ? { ingestedVia: "notion-poll" }
            : {}),
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
  /**
   * Tenant-relative R2 key of the raw source export the importer parses.
   * Required for `chatgpt`/`claude-code`; omitted for `obsidian` (vault is enumerated live).
   */
  exportR2Key?: string
}

export class EnumeratorWorkflow extends WorkflowEntrypoint<ApiBindings, EnumeratorWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<EnumeratorWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<EnumerateResult> {
    const { principal, sourceId, runId, kind, client, exportR2Key } = event.payload
    const services: BackfillServices = createBackfillServices(this.env, principal)
    return step.do("enumerate", async () => {
      const run = await services.runs.get(runId)
      await services.runs.claim(runId) // optimistic queued→running
      const enqueue = async (message: BackfillMessage): Promise<void> => {
        // The producer binding is present at deploy; the workflow only runs there.
        const queue = (this.env as { BACKFILL_QUEUE?: Queue<BackfillMessage> }).BACKFILL_QUEUE
        if (queue !== undefined) await queue.send(message)
      }
      // Obsidian vaults enumerate live R2; no export file to read.
      // All other clients require an exportR2Key pointing to the staged export.
      let importer: Importer
      if (client === "obsidian") {
        importer = importerForClient("obsidian", "", services.blobs)
      } else {
        if (exportR2Key === undefined)
          throw new Error(`enumerate: exportR2Key required for client "${client}"`)
        const obj = await services.blobs.get(exportR2Key)
        if (obj === null) throw new Error(`enumerate: source export not found at "${exportR2Key}"`)
        const raw = await obj.text()
        importer = importerForClient(client, raw)
      }
      const result = await runEnumerate({
        runs: services.runs,
        blobs: services.blobs,
        enqueue,
        tenantId: principal.tenantId,
        sourceId,
        runId,
        kind,
        importer,
        ...(run?.cursor != null ? { resumeCursor: run.cursor } : {}),
      })

      // Phase 2: after a clean obsidian enumeration, reconcile deletions (notes removed from vault).
      // Re-lists the vault to get current slugs; guard inside reconcileObsidianDeletions handles
      // empty-vault R2 hiccups (skips deletions rather than wiping everything).
      if (client === "obsidian") {
        const vaultSlugs = await listVaultSlugs(
          services.blobs,
          principal.tenantId,
          DEFAULT_VAULT_PREFIX,
        )
        await reconcileObsidianDeletions(services, sourceId, vaultSlugs)
      }

      return result
    })
  }
}

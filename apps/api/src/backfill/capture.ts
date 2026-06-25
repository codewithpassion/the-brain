/**
 * `runImportCapture` + `captureSession` — the importer→capture wiring (PRD §4.7/§8.2, closing the
 * deferral P5 handed to this phase).
 *
 * Drives a source importer (ChatGPT/Claude-Code from `@brain/ingest`) through `runImporterContract`
 * (the resumable-enumeration safety verifier) into normalized sessions/turns, then PERSISTS each
 * session via the tenant-scoped `SessionStore` (sessions + turns) with the full transcript in R2.
 *
 * IDEMPOTENCY (advisor): `captureTurn` is APPEND-ONLY — re-running the loop would DOUBLE every turn.
 * So each session is gated on a deterministic `(tenant, slug)` `documents` marker FIRST: a re-
 * delivery trips the per-tenant unique index → caught → the whole session is skipped before any
 * `captureTurn`. The marker `id` is a random UUID (so it never collides across tenants) while the
 * `slug` is content-addressed (`import-${fingerprint}`), so the `(tenant, slug)` index is the
 * per-tenant dedup — the SAME mechanism `/ingest` relies on (index.ts).
 */
import { type SessionServices, transcriptKey } from "@brain/db"
import { type ImportedSession, type Importer, runImporterContract } from "@brain/ingest"

/** What `captureSession` did with one imported session. */
export interface CaptureSessionResult {
  /** The Brain's own session row id (`null` when the item was a dedup skip). */
  brainSessionId: string | null
  /** Turns persisted (0 on a skip). */
  turns: number
  /** True when a re-delivery was deduped (no turns written). */
  skipped: boolean
}

/** The roll-up of one importer drain. */
export interface ImportCaptureResult {
  sessions: number
  captured: number
  skipped: number
  turns: number
}

/** Content-addressed dedup slug (the per-tenant `(tenant, slug)` unique-index key). */
const importSlug = (fingerprint: string): string => `import-${fingerprint}`

/** The subset of the scoped bundle capture needs (any `SessionServices`/`BackfillServices`). */
type CaptureServices = Pick<SessionServices, "db" | "sessions" | "blobs">

/**
 * Persist ONE imported session idempotently: gate on the `(tenant, slug)` marker, then append every
 * turn through `SessionStore.captureTurn`, then write the full transcript to R2 (captureTurn nulls
 * `content` + sets `r2_offset` for any turn >2048 chars but leaves the body write to the caller —
 * without this an offloaded turn would lose its body, invariant 13).
 */
export const captureSession = async (
  services: CaptureServices,
  session: ImportedSession,
): Promise<CaptureSessionResult> => {
  try {
    await services.db.insertDocument({
      slug: importSlug(session.fingerprint),
      fingerprint: session.fingerprint,
      sourceKind: session.client,
      ingestedVia: "backfill-queue",
      status: "indexed",
      ...(session.title !== undefined ? { title: session.title } : {}),
    })
  } catch {
    // The marker already exists (a re-delivery) → skip the whole session, no turn doubling.
    return { brainSessionId: null, turns: 0, skipped: true }
  }

  let brainSessionId: string | null = null
  for (const turn of session.turns) {
    const res = await services.sessions.captureTurn({
      sessionId: session.sourceSessionId,
      client: session.client,
      role: turn.role,
      content: turn.content,
      ...(session.title !== undefined ? { title: session.title } : {}),
    })
    brainSessionId = res.brainSessionId
  }

  if (brainSessionId !== null) {
    const jsonl = session.turns
      .map((turn) => JSON.stringify({ idx: turn.idx, role: turn.role, content: turn.content }))
      .join("\n")
    await services.blobs.put(transcriptKey(brainSessionId), jsonl)
  }
  return { brainSessionId, turns: session.turns.length, skipped: false }
}

/**
 * Drive a source importer from its raw export through `runImporterContract` → normalized sessions,
 * persisting each via `captureSession`. `makeImporter` is the importer factory
 * (`createChatGptImporter`/`createClaudeCodeImporter`); `raw` is the untrusted export text (the
 * importer parses it defensively, skip-record on drift). Re-running over the same export is a no-op
 * (every session dedups on its marker).
 */
export const runImportCapture = async (
  services: CaptureServices,
  makeImporter: (raw: string) => Importer,
  raw: string,
): Promise<ImportCaptureResult> => {
  const sessions = await runImporterContract(makeImporter(raw))
  let captured = 0
  let skipped = 0
  let turns = 0
  for (const session of sessions) {
    const result = await captureSession(services, session)
    if (result.skipped) {
      skipped++
    } else {
      captured++
      turns += result.turns
    }
  }
  return { sessions: sessions.length, captured, skipped, turns }
}

/**
 * The platform-neutral `Importer` SDK contract (PRD §4.7) — net-new here (the openbrains types
 * are not vendored into this repo). The backfill Enumerator (§8.6) drives sources through
 * `begin → nextBatch(cursor) → finalize`; the ChatGPT + Claude-Code importers (this dir)
 * implement it over their untrusted JSON/JSONL exports.
 *
 * FOREIGN-EMBEDDING RULE (locked, §4.7): an import NEVER copies a foreign embedding. Every
 * emitted thought carries `embeddingModel:'pending'` / `embeddingDims:0`, so the re-embed sweep
 * (§8.7) re-embeds at bge-m3 1024d. Same dimension is NOT interchangeability — cross-model cosine
 * is meaningless.
 */

/** A normalized session turn the importer emits (maps 1:1 to a `session_turns` row, §8.2 path-2). */
export interface ImportedTurn {
  role: "user" | "assistant" | "system" | "tool"
  content: string
  /** Ordinal within the reconstructed linear order. */
  idx: number
  /** ISO timestamp from the source record, when present. */
  createdAt?: string
}

/** A normalized session the importer emits (one per source conversation/transcript). */
export interface ImportedSession {
  /** The source platform's own session id — the idempotent-upsert key `source_session_id`. */
  sourceSessionId: string
  client: "chatgpt" | "claude-code" | "obsidian"
  title?: string
  startedAt?: string
  turns: ImportedTurn[]
  /** Content fingerprint basis (the export ref) — never a foreign embedding. */
  fingerprint: string
  /** ALWAYS `'pending'`: imports drop foreign embeddings; the re-embed sweep re-embeds (§4.7). */
  embeddingModel: "pending"
  /** ALWAYS `0` for the same reason. */
  embeddingDims: 0
}

/** One page of imported sessions + the resume cursor (`null` ⇒ terminal). */
export interface ImportBatch {
  items: readonly ImportedSession[]
  /** Resume point (byte/line offset into the export); `null` is terminal (no more pages). */
  nextCursor: string | null
}

/**
 * The importer contract. `runImporterContract` (contract.ts) enforces the two safety invariants:
 * a terminal cursor is `null`; an empty batch with a non-null cursor is a violation (would loop).
 */
export interface Importer {
  readonly source: string
  begin(opts: { resumeCursor?: string }): Promise<{ cursor: string | null }>
  nextBatch(cursor: string | null): Promise<ImportBatch>
  finalize(): Promise<void>
}

// ── Defensive per-field narrowing guards (ported posture from openbrains `ob1.ts`) ──────
// Every export field is `unknown`; a missing/mistyped field skips that record, never throws.

/** Narrow to a plain record, or `null`. */
export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Narrow to a string, or `undefined`. */
export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** Narrow to a finite number, or `undefined`. */
export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Narrow to an array (of `unknown`), or `[]`. */
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Narrow to the four canonical turn roles (default `'user'`). */
export const asRole = (value: unknown): ImportedTurn["role"] => {
  const s = asString(value)
  return s === "assistant" || s === "system" || s === "tool" ? s : "user"
}

/** A Unix-seconds (or ms) timestamp → ISO, or `undefined` on absence/garbage. */
export const asIsoTime = (value: unknown): string | undefined => {
  const n = asNumber(value)
  if (n === undefined) return asString(value)
  const ms = n > 1e12 ? n : n * 1000 // seconds vs milliseconds heuristic
  return new Date(ms).toISOString()
}

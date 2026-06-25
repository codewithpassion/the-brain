/**
 * Claude-Code session-transcript importer (PRD §4.7.1).
 *
 * INPUT: one JSON object PER LINE (a `.jsonl` transcript), append-ordered. Each record is
 * `{ type:'user'|'assistant'|'system'|'summary'|..., uuid, parentUuid, timestamp, sessionId,
 * message? }` where `message` mirrors the Anthropic Messages shape
 * `{ role, content: string | Array<{type:'text'|'tool_use'|'tool_result', text?}> }`.
 *
 * PARSE RULE: read line-by-line (records arrive in causal order). Keep records whose
 * `type ∈ {user, assistant}` and whose `message.content` yields non-empty text (a string, OR the
 * concatenation of its `type:'text'` blocks; `tool_use`/`tool_result` blocks collapse to a short
 * inline marker, kept verbatim only in the R2 transcript). The file → one session
 * (`source_session_id ← sessionId`, constant across the file). Untrusted JSONL: a malformed line
 * is skipped, never thrown. No foreign embeddings — `embeddingModel:'pending'`, `embeddingDims:0`.
 *
 * Cursor = a line offset into the export (resumable mid-file). One session emitted, so the whole
 * file is one page: `begin` → cursor `"0"`, the single `nextBatch` emits it and returns `null`.
 */
import {
  asArray,
  asIsoTime,
  asRecord,
  asRole,
  asString,
  type ImportBatch,
  type ImportedSession,
  type ImportedTurn,
  type Importer,
} from "./types"

const MAX_TITLE = 80

/** Extract a record's text: a string `content`, or the joined `type:'text'` blocks (markers else). */
const messageText = (message: Record<string, unknown>): string => {
  const content = message.content
  const asStr = asString(content)
  if (asStr !== undefined) return asStr
  return asArray(content)
    .map((block) => {
      const rec = asRecord(block)
      if (rec === null) return ""
      const type = asString(rec.type)
      if (type === "text") return asString(rec.text) ?? ""
      if (type === "tool_use") return `[tool_use: ${asString(rec.name) ?? "tool"}]`
      if (type === "tool_result") return "[tool_result]"
      return ""
    })
    .filter((part) => part.length > 0)
    .join("\n")
}

/** Parse the JSONL export into `{ sourceSessionId, turns }`, skipping malformed/non-text records. */
const parseTranscript = (
  jsonl: string,
): { sourceSessionId: string; turns: ImportedTurn[]; startedAt?: string } => {
  const turns: ImportedTurn[] = []
  let sourceSessionId: string | undefined
  let startedAt: string | undefined
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record: Record<string, unknown> | null
    try {
      record = asRecord(JSON.parse(trimmed))
    } catch {
      continue // drop-don't-throw: a malformed line is skipped
    }
    if (record === null) continue
    sourceSessionId ??= asString(record.sessionId)
    startedAt ??= asIsoTime(record.timestamp)
    const type = asString(record.type)
    if (type !== "user" && type !== "assistant") continue
    const message = asRecord(record.message)
    if (message === null) continue
    const text = messageText(message)
    if (text.trim().length === 0) continue
    const createdAt = asIsoTime(record.timestamp)
    turns.push({
      role: asRole(message.role ?? type),
      content: text,
      idx: turns.length,
      ...(createdAt !== undefined ? { createdAt } : {}),
    })
  }
  return {
    sourceSessionId: sourceSessionId ?? "claude-code-unknown",
    turns,
    ...(startedAt !== undefined ? { startedAt } : {}),
  }
}

/** Build a Claude-Code importer over the raw `.jsonl` transcript export. */
export const createClaudeCodeImporter = (jsonl: string): Importer => {
  const parsed = parseTranscript(jsonl)
  const session: ImportedSession | null =
    parsed.turns.length === 0
      ? null
      : {
          sourceSessionId: parsed.sourceSessionId,
          client: "claude-code",
          turns: parsed.turns,
          fingerprint: `claude-code:${parsed.sourceSessionId}`,
          embeddingModel: "pending",
          embeddingDims: 0,
          title: (parsed.turns.find((t) => t.role === "user")?.content ?? "").slice(0, MAX_TITLE),
          ...(parsed.startedAt !== undefined ? { startedAt: parsed.startedAt } : {}),
        }

  return {
    source: "claude-code",
    begin: async () => ({ cursor: session === null ? null : "0" }),
    nextBatch: async (): Promise<ImportBatch> => ({
      items: session === null ? [] : [session],
      nextCursor: null,
    }),
    finalize: async () => undefined,
  }
}

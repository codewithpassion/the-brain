/**
 * ChatGPT `conversations.json` importer (PRD §4.7.1).
 *
 * INPUT: a top-level ARRAY of conversations; each is `{ title, create_time, mapping, current_node? }`
 * where `mapping` is a node-id-keyed tree of `{ id, parent, children:[ids], message? }` and a
 * `message` is `{ author:{role}, create_time, content:{ content_type, parts:[string|...] } }`.
 *
 * PARSE RULE: pick the ACTIVE LEAF (`current_node`, else the deepest reachable leaf) and walk
 * `parent` pointers to the root to recover the linear turn order (branches encode edits/regens;
 * the parent-walk takes the chosen path). Each visited node with non-empty text → one turn.
 * Untrusted JSON: every field is narrowed; a malformed conversation/node is skipped, never thrown.
 * No foreign embeddings — `embeddingModel:'pending'`, `embeddingDims:0`.
 *
 * Cursor = the index of the NEXT conversation to emit (one conversation per page); `null` terminal.
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

/** Join a message's `content.parts`, keeping only the string parts (drop image/tool blobs inline). */
const partsToText = (content: unknown): string => {
  const rec = asRecord(content)
  if (rec === null) return ""
  return asArray(rec.parts)
    .map((part) => asString(part))
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n")
}

/** Walk `parent` pointers from the active leaf to the root, returning node ids in linear order. */
const linearNodeIds = (
  mapping: Record<string, unknown>,
  conversation: Record<string, unknown>,
): string[] => {
  const deepestLeaf = (): string | undefined => {
    // No current_node: pick the leaf (no children) with the longest parent-chain to root.
    let best: string | undefined
    let bestDepth = -1
    for (const [id, node] of Object.entries(mapping)) {
      const rec = asRecord(node)
      if (rec === null) continue
      const children = asArray(rec.children)
      if (children.length > 0) continue // not a leaf
      let depth = 0
      let cursor: string | undefined = id
      const seen = new Set<string>()
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor)
        const parent = asString(asRecord(mapping[cursor])?.parent)
        cursor = parent
        depth++
      }
      if (depth > bestDepth) {
        bestDepth = depth
        best = id
      }
    }
    return best
  }

  const leaf = asString(conversation.current_node) ?? deepestLeaf()
  if (leaf === undefined) return []
  const chain: string[] = []
  let cursor: string | undefined = leaf
  const seen = new Set<string>()
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    chain.push(cursor)
    cursor = asString(asRecord(mapping[cursor])?.parent)
  }
  return chain.reverse() // root → leaf
}

/** Map one parsed conversation object to an `ImportedSession` (or `null` if it has no text turns). */
const toSession = (raw: unknown, index: number): ImportedSession | null => {
  const conv = asRecord(raw)
  if (conv === null) return null
  const mapping = asRecord(conv.mapping)
  if (mapping === null) return null
  const sourceSessionId = asString(conv.id) ?? asString(conv.conversation_id) ?? `chatgpt-${index}`

  const turns: ImportedTurn[] = []
  for (const nodeId of linearNodeIds(mapping, conv)) {
    const node = asRecord(mapping[nodeId])
    const message = node === null ? null : asRecord(node.message)
    if (message === null) continue
    const text = partsToText(message.content)
    if (text.trim().length === 0) continue
    const author = asRecord(message.author)
    const createdAt = asIsoTime(message.create_time)
    turns.push({
      role: asRole(author?.role),
      content: text,
      idx: turns.length,
      ...(createdAt !== undefined ? { createdAt } : {}),
    })
  }
  if (turns.length === 0) return null

  const title = asString(conv.title)
  const startedAt = asIsoTime(conv.create_time)
  return {
    sourceSessionId,
    client: "chatgpt",
    turns,
    fingerprint: `chatgpt:${sourceSessionId}`,
    embeddingModel: "pending",
    embeddingDims: 0,
    ...(title !== undefined ? { title } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  }
}

/** Build a ChatGPT importer over the raw `conversations.json` export text. */
export const createChatGptImporter = (exportJson: string): Importer => {
  let conversations: unknown[] = []
  try {
    const parsed: unknown = JSON.parse(exportJson)
    conversations = Array.isArray(parsed) ? parsed : []
  } catch {
    conversations = [] // a corrupt export yields zero sessions, never a throw
  }

  return {
    source: "chatgpt",
    begin: async () => ({ cursor: conversations.length === 0 ? null : "0" }),
    nextBatch: async (cursor): Promise<ImportBatch> => {
      const start = cursor === null ? 0 : Number.parseInt(cursor, 10)
      // Scan forward to the next conversation that yields a session — a conversation with no text
      // turns must NOT produce an empty batch with a non-null cursor (the contract violation that
      // would loop). The terminal page is the ONLY empty batch, and it carries `null`.
      for (
        let i = Number.isInteger(start) ? start : conversations.length;
        i < conversations.length;
        i++
      ) {
        const session = toSession(conversations[i], i)
        if (session === null) continue
        const next = i + 1
        return { items: [session], nextCursor: next >= conversations.length ? null : String(next) }
      }
      return { items: [], nextCursor: null }
    },
    finalize: async () => undefined,
  }
}

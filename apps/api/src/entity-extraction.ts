/**
 * `runEntityExtraction` — the platform-neutral KG-extraction pipeline (PRD §6.2, the Phase-4
 * KG phase of ingest). Like `runBatchIngest`, it is a PLAIN async function over the
 * tenant-scoped `ScopedServices` bundle so the slice/canary tests drive it directly against
 * real workerd D1 (+ deterministic AI stubs); the deploy-time `EntityExtractionWorkflow` wraps
 * it across durable `step.do()` boundaries.
 *
 * NON-FATAL by contract: the whole body is wrapped in try/catch and ALWAYS resolves to a
 * result (never throws). A doc stays searchable even if KG extraction fails (s06 §6.2
 * `mark-failed`); the ingest call-site is non-fatal too (defence in depth).
 *
 * Steps (s06 §6.2, parameterized): clear prior extraction → load chunks (`visibility <>
 * 'private'`, §6.2) → extract in batches of `KG_BATCH_SIZE` via `genExtract`/EXTRACT_MODEL
 * (json_object + truncation salvage) → upsert entities (deterministic key + alias union,
 * tier derived from source chunks, NEVER the LLM) + relate + mention → embed
 * canonical_name+description to `brain-entities` → done. `tenant_id` is forced on every write
 * by `ScopedGraph`.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type { ScopedServices } from "@brain/db"
import { createScopedServices, type ExtractedEntityInput, mergeVisibility } from "@brain/db"
import type { Principal } from "@brain/shared"
import { EMBED_BATCH_SIZE, EMBEDDING_MODEL, KG_BATCH_SIZE } from "@brain/shared"
import type { ApiBindings } from "./bindings"

export interface EntityExtractionResult {
  documentId: string
  entitiesUpserted: number
  relationsUpserted: number
  mentions: number
  status: "indexed" | "skipped" | "failed"
  error?: string
}

/** The serializable payload the deploy-time `EntityExtractionWorkflow` carries. */
export interface EntityExtractionWorkflowParams {
  principal: Principal
  documentId: string
}

/** A source chunk's derived access tier (the LLM emits none — it travels from the chunks). */
interface ChunkTier {
  scope: string | null
  visibility: string
  teamId: string | null
}

/** The LLM's structured KG payload (s06 §6.2). */
interface KgExtractionResult {
  entities: { name: string; kind: string; aliases?: string[]; description?: string }[]
  relationships: {
    source: string
    target: string
    relKind: string
    description?: string
    confidence?: number
  }[]
}

const EXTRACT_SYSTEM =
  "You are a knowledge-graph extractor. From the supplied text, extract named entities and " +
  "the relationships between them. Respond with ONLY a JSON object of the shape " +
  '{"entities":[{"name","kind","aliases","description"}],' +
  '"relationships":[{"source","target","relKind","description","confidence"}]}. ' +
  "kind is one of person|org|project|concept|place|event|other. confidence is 0..1. " +
  "Use entity names verbatim as the source/target of relationships."

/**
 * Truncation-salvage JSON parse (s06 §6.2, cf-graph `extractJsonFromText`): parse-as-is →
 * slice first-brace…last-brace → trim back to the last complete object. Returns `null` when
 * nothing parses (extraction degrades to a no-op for that batch).
 */
const parseKgJson = (text: string): KgExtractionResult | null => {
  const candidates = [text]
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === "object")
        return normalizeKg(parsed as Record<string, unknown>)
    } catch {
      // try the next salvage strategy
    }
  }
  return null
}

/** Coerce a loosely-typed parsed object into a `KgExtractionResult` (defensive). */
const normalizeKg = (raw: Record<string, unknown>): KgExtractionResult => {
  const entities = Array.isArray(raw.entities) ? raw.entities : []
  const relationships = Array.isArray(raw.relationships) ? raw.relationships : []
  return {
    entities: entities
      .filter(
        (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
      )
      .map((entry) => ({
        name: String(entry.name ?? "").trim(),
        kind: String(entry.kind ?? "other").trim() || "other",
        aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
        description: typeof entry.description === "string" ? entry.description : "",
      }))
      .filter((entry) => entry.name.length > 0),
    relationships: relationships
      .filter(
        (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
      )
      .map((entry) => ({
        source: String(entry.source ?? "").trim(),
        target: String(entry.target ?? "").trim(),
        relKind: String(entry.relKind ?? "related").trim() || "related",
        description: typeof entry.description === "string" ? entry.description : "",
        confidence: typeof entry.confidence === "number" ? entry.confidence : 0.5,
      }))
      .filter((entry) => entry.source.length > 0 && entry.target.length > 0),
  }
}

/** Max-permissive tier over a set of source chunks (scope from the first; visibility merged). */
const deriveTier = (chunkIds: string[], chunkById: Map<string, ChunkTier>): ChunkTier => {
  let tier: ChunkTier | null = null
  for (const id of chunkIds) {
    const chunk = chunkById.get(id)
    if (!chunk) continue
    if (tier === null) {
      tier = { scope: chunk.scope, visibility: chunk.visibility, teamId: chunk.teamId }
      continue
    }
    const merged = mergeVisibility(tier, chunk)
    tier = { scope: tier.scope, visibility: merged.visibility, teamId: merged.teamId }
  }
  return tier ?? { scope: null, visibility: "world", teamId: null }
}

/** Relation-endpoint resolution key: scope partition + lowercased name (cf-graph parity). */
const nameKey = (scope: string | null, name: string): string =>
  `${scope ?? ""}::${name.toLowerCase()}`

export const runEntityExtraction = async (
  services: ScopedServices,
  documentId: string,
): Promise<EntityExtractionResult> => {
  const base: EntityExtractionResult = {
    documentId,
    entitiesUpserted: 0,
    relationsUpserted: 0,
    mentions: 0,
    status: "indexed",
  }
  try {
    // 1. clear prior extraction (mentions + relation-evidence prune) — idempotent re-extract.
    await services.graph.clearPriorExtraction({ sourceKind: "document", sourceId: documentId })

    // 2. load chunks (private chunks never become tenant-wide entities, §6.2).
    const chunks = await services.graph.loadChunksForExtraction(documentId)
    if (chunks.length === 0) return { ...base, status: "skipped" }
    const chunkById = new Map<string, ChunkTier>(
      chunks.map((chunk) => [
        chunk.id,
        { scope: chunk.scope, visibility: chunk.visibility, teamId: chunk.teamId },
      ]),
    )

    // 3. extract in batches of KG_BATCH_SIZE via genExtract/EXTRACT_MODEL.
    const extractedEntities: (ExtractedEntityInput & { batchScope: string | null })[] = []
    const extractedRelations: {
      source: string
      target: string
      relKind: string
      confidence: number
      chunkIds: string[]
      scope: string | null
    }[] = []
    for (let i = 0; i < chunks.length; i += KG_BATCH_SIZE) {
      const batch = chunks.slice(i, i + KG_BATCH_SIZE)
      const batchIds = batch.map((chunk) => chunk.id)
      const prompt = batch
        .map((chunk, index) => `# Chunk ${index + 1}\n${chunk.content}`)
        .join("\n\n")
      const raw = await services.ai.genExtract(prompt, EXTRACT_SYSTEM)
      if (raw === null) continue // degrade this batch (non-fatal)
      const parsed = parseKgJson(raw)
      if (parsed === null) continue
      const tier = deriveTier(batchIds, chunkById)
      for (const entity of parsed.entities) {
        extractedEntities.push({
          name: entity.name,
          kind: entity.kind,
          aliases: entity.aliases ?? [],
          description: entity.description ?? "",
          chunkIds: batchIds,
          scope: tier.scope,
          visibility: tier.visibility,
          teamId: tier.teamId,
          batchScope: tier.scope,
        })
      }
      for (const relation of parsed.relationships) {
        extractedRelations.push({
          source: relation.source,
          target: relation.target,
          relKind: relation.relKind,
          confidence: relation.confidence ?? 0.5,
          chunkIds: batchIds,
          scope: tier.scope,
        })
      }
    }

    // 4. store-kg: upsert entities (+ mentions), then relate (endpoints resolved by scope+name).
    const nameToId = new Map<string, string>()
    const toEmbed: {
      id: string
      text: string
      scope: string | null
      visibility: string
      teamId: string | null
    }[] = []
    for (const entity of extractedEntities) {
      const id = await services.graph.upsertEntity(entity)
      nameToId.set(nameKey(entity.scope, entity.name), id)
      base.entitiesUpserted++
      for (const chunkId of new Set(entity.chunkIds)) {
        await services.graph.mention(id, "chunk", chunkId)
        base.mentions++
      }
      toEmbed.push({
        id,
        text: `${entity.name}\n${entity.description}`.trim(),
        scope: entity.scope,
        visibility: entity.visibility,
        teamId: entity.teamId,
      })
    }
    for (const relation of extractedRelations) {
      const fromId = nameToId.get(nameKey(relation.scope, relation.source))
      const toId = nameToId.get(nameKey(relation.scope, relation.target))
      if (fromId === undefined || toId === undefined || fromId === toId) continue
      await services.graph.relate(
        { kind: relation.relKind, confidence: relation.confidence, chunkIds: relation.chunkIds },
        fromId,
        toId,
      )
      base.relationsUpserted++
    }

    // 5. embed canonical_name+description → brain-entities (best-effort; D1 row is the gate).
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH_SIZE)
      const vectors = await services.ai.embed(batch.map((entry) => entry.text))
      if (vectors === null) continue // degrade: entities stay searchable via entity_fts
      const embeddedAt = new Date().toISOString()
      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j]
        const values = vectors[j]
        if (entry === undefined || values === undefined) continue
        await services.entityVectors.upsert({
          id: entry.id,
          values,
          scope: entry.scope,
          teamId: entry.teamId,
          visibility: entry.visibility,
          embeddingModel: EMBEDDING_MODEL,
        })
        await services.graph.markEntityEmbedded(entry.id, embeddedAt)
      }
    }

    return base
  } catch (err) {
    // NON-FATAL: a KG-extraction failure never fails ingest (the doc is already indexed).
    return { ...base, status: "failed", error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `EntityExtractionWorkflow` — the deploy-time durable wrapper around `runEntityExtraction`
 * (mirrors `BatchIngestWorkflow`). Re-creates the tenant-scoped `ScopedServices` from the
 * serialized `Principal`, then runs extraction inside a durable `step.do()` boundary. NO local
 * pool-workers emulation; the slice/canary drive `runEntityExtraction` directly.
 */
export class EntityExtractionWorkflow extends WorkflowEntrypoint<
  ApiBindings,
  EntityExtractionWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<EntityExtractionWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<EntityExtractionResult> {
    const { principal, documentId } = event.payload
    const services = createScopedServices(this.env, principal)
    return step.do("entity-extraction", () => runEntityExtraction(services, documentId))
  }
}

/**
 * `createScopedServices(env, principal)` — the dependency bundle every future
 * OpContext/handler receives (PRD §7).
 *
 * Wraps the raw bindings into the isolation chokepoints + AI wrappers ONCE per request,
 * bound to the resolved `Principal`. Below this point no handler ever touches a raw
 * binding (invariant 2) — they get `{ db, vectors, blobs, ai }`, all tenant-scoped.
 */
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { embed, embedForIndex } from "./ai/embed"
import type { AiDeps, OpenAiCompatConfig } from "./ai/gateway"
import { gen, genExtract } from "./ai/gen"
import { type RerankCandidate, type RerankHit, rerank } from "./ai/rerank"
import { type Transcription, transcribe } from "./ai/transcribe"
import type { BrainBindings } from "./env"
import { ScopedGraph } from "./graph/scoped-graph"
import { type BreakGlassAudit, ScopedDB } from "./scoped/db"
import { ScopedR2 } from "./scoped/r2"
import { ScopedVectorize } from "./scoped/vectorize"
import { WikiStore } from "./wiki/store"

/** The per-request, tenant-scoped service bundle. */
export interface ScopedServices {
  db: ScopedDB
  vectors: ScopedVectorize
  /** `brain-entities` Vectorize wrapper (Phase 4 — entity search + extraction upserts). */
  entityVectors: ScopedVectorize
  /** Graph node-space read/write chokepoint (pages/entities/links; Phase 4). */
  graph: ScopedGraph
  /** First-class wiki pages on the shared `pages` layer (v3/W1). */
  wiki: WikiStore
  blobs: ScopedR2
  ai: {
    /** READ path — `null` ⇒ degrade to keyword-only. */
    embed: (texts: string[]) => Promise<number[][] | null>
    /** WRITE/index path — throws to trigger Workflow retry. */
    embedForIndex: (texts: string[]) => Promise<number[][]>
    /** READ path — `null` ⇒ evidence-without-synthesis. */
    gen: (prompt: string, system?: string) => Promise<string | null>
    /** KG-extraction READ path over EXTRACT_MODEL — `null` ⇒ extraction degrades (non-fatal). */
    genExtract: (
      prompt: string,
      system?: string,
      opts?: { maxTokens?: number },
    ) => Promise<string | null>
    /** READ path — degrades to RRF/identity order. */
    rerank: (query: string, candidates: RerankCandidate[], topK: number) => Promise<RerankHit[]>
    /**
     * CF document converter — markdown extraction for binary/HTML bodies via `env.AI.toMarkdown`
     * (the Workers AI Markdown Conversion API). OPTIONAL: absent on openai-compatible providers
     * and in test stubs that omit it. The `/documents` upload handler returns 415 when absent.
     */
    toMarkdown?: (name: string, buf: ArrayBuffer) => Promise<string>
    /** WRITE/ingest path (voice memo, W3.2) — THROWS on failure so the audio doc fails visibly. */
    transcribe: (audio: Uint8Array) => Promise<Transcription>
  }
}

export interface ScopedServicesOptions {
  /** Audit+alert sink for `ScopedDB.breakGlass`; absent ⇒ break-glass fails closed. */
  breakGlassAudit?: BreakGlassAudit
  /**
   * When set, all AI chokepoints route to the openai-compatible provider via fetch instead of
   * `env.AI.run`. Built by the app layer from `AI_PROVIDER` + `OPENAI_*` env vars.
   */
  openaiConfig?: OpenAiCompatConfig
}

/**
 * Blobs-only factory for surfaces that need R2 and nothing else (vault-dav). Lives here so
 * `packages/db` stays the ONE module that names the raw `BODIES` binding (invariant 2).
 */
export const createScopedBlobs = (
  env: Pick<BrainBindings, "BODIES">,
  principal: Principal,
): ScopedR2 => new ScopedR2(env.BODIES, principal)

export const createScopedServices = (
  env: BrainBindings,
  principal: Principal,
  options?: ScopedServicesOptions,
): ScopedServices => {
  const db = drizzle(env.DB)
  const aiDeps: AiDeps = {
    ai: env.AI,
    gatewayId: env.AI_GATEWAY_ID,
    tenantId: principal.tenantId,
    ...(options?.openaiConfig !== undefined ? { openaiConfig: options.openaiConfig } : {}),
  }
  return {
    db: new ScopedDB(db, principal, options?.breakGlassAudit),
    vectors: new ScopedVectorize(env.CHUNK_INDEX, principal),
    entityVectors: new ScopedVectorize(env.ENTITY_INDEX, principal),
    graph: new ScopedGraph(db, principal),
    wiki: new WikiStore(db, principal),
    blobs: new ScopedR2(env.BODIES, principal),
    ai: {
      embed: (texts) => embed(aiDeps, texts),
      embedForIndex: (texts) => embedForIndex(aiDeps, texts),
      gen: (prompt, system) => gen(aiDeps, prompt, system),
      genExtract: (prompt, system, opts) => genExtract(aiDeps, prompt, system, opts),
      rerank: (query, candidates, topK) => rerank(aiDeps, query, candidates, topK),
      toMarkdown: async (name: string, buf: ArrayBuffer): Promise<string> => {
        const results = await env.AI.toMarkdown([
          { name, blob: new Blob([buf], { type: "application/octet-stream" }) },
        ])
        const r = results[0]
        if (r === undefined) throw new Error("toMarkdown: no result returned")
        if (r.format === "error") throw new Error(r.error)
        return r.data
      },
      transcribe: (audio) => transcribe(aiDeps, audio),
    },
  }
}

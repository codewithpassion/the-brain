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
import type { AiDeps } from "./ai/gateway"
import { gen, genExtract } from "./ai/gen"
import { type RerankCandidate, type RerankHit, rerank } from "./ai/rerank"
import type { BrainBindings } from "./env"
import { ScopedGraph } from "./graph/scoped-graph"
import { type BreakGlassAudit, ScopedDB } from "./scoped/db"
import { ScopedR2 } from "./scoped/r2"
import { ScopedVectorize } from "./scoped/vectorize"

/** The per-request, tenant-scoped service bundle. */
export interface ScopedServices {
  db: ScopedDB
  vectors: ScopedVectorize
  /** `brain-entities` Vectorize wrapper (Phase 4 — entity search + extraction upserts). */
  entityVectors: ScopedVectorize
  /** Graph node-space read/write chokepoint (pages/entities/links; Phase 4). */
  graph: ScopedGraph
  blobs: ScopedR2
  ai: {
    /** READ path — `null` ⇒ degrade to keyword-only. */
    embed: (texts: string[]) => Promise<number[][] | null>
    /** WRITE/index path — throws to trigger Workflow retry. */
    embedForIndex: (texts: string[]) => Promise<number[][]>
    /** READ path — `null` ⇒ evidence-without-synthesis. */
    gen: (prompt: string, system?: string) => Promise<string | null>
    /** KG-extraction READ path over EXTRACT_MODEL — `null` ⇒ extraction degrades (non-fatal). */
    genExtract: (prompt: string, system?: string) => Promise<string | null>
    /** READ path — degrades to RRF/identity order. */
    rerank: (query: string, candidates: RerankCandidate[], topK: number) => Promise<RerankHit[]>
  }
}

export interface ScopedServicesOptions {
  /** Audit+alert sink for `ScopedDB.breakGlass`; absent ⇒ break-glass fails closed. */
  breakGlassAudit?: BreakGlassAudit
}

export const createScopedServices = (
  env: BrainBindings,
  principal: Principal,
  options?: ScopedServicesOptions,
): ScopedServices => {
  const db = drizzle(env.DB)
  const aiDeps: AiDeps = { ai: env.AI, gatewayId: env.AI_GATEWAY_ID, tenantId: principal.tenantId }
  return {
    db: new ScopedDB(db, principal, options?.breakGlassAudit),
    vectors: new ScopedVectorize(env.CHUNK_INDEX, principal),
    entityVectors: new ScopedVectorize(env.ENTITY_INDEX, principal),
    graph: new ScopedGraph(db, principal),
    blobs: new ScopedR2(env.BODIES, principal),
    ai: {
      embed: (texts) => embed(aiDeps, texts),
      embedForIndex: (texts) => embedForIndex(aiDeps, texts),
      gen: (prompt, system) => gen(aiDeps, prompt, system),
      genExtract: (prompt, system) => genExtract(aiDeps, prompt, system),
      rerank: (query, candidates, topK) => rerank(aiDeps, query, candidates, topK),
    },
  }
}

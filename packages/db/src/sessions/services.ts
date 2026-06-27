/**
 * `createSessionServices(env, principal)` — the tenant-scoped bundle the session/governance
 * ops + workflows receive (PRD §8).
 *
 * Mirrors `createScopedServices` (services.ts) but ALSO exposes the `SessionStore`
 * (sessions/turns/facts writeback+recall) and `GovernanceStore` (review/break-glass/audit)
 * the net-new tables need. Obtaining the raw `BrainDrizzle` here is legal: `packages/db` is the
 * ONLY package allowed to touch `env.DB` (invariant 2). Below this point the ops never see a
 * raw binding — they get `ScopedDB`/`ScopedVectorize`/`ScopedR2`/AI + the two stores.
 */
import type { Principal } from "@brain/shared"
import { drizzle } from "drizzle-orm/d1"
import { embed, embedForIndex } from "../ai/embed"
import type { AiDeps } from "../ai/gateway"
import { gen } from "../ai/gen"
import { type RerankCandidate, type RerankHit, rerank } from "../ai/rerank"
import type { BrainBindings } from "../env"
import { GovernanceStore } from "../governance/store"
import { MemoryStore } from "../memory/store"
import { type BreakGlassAudit, ScopedDB } from "../scoped/db"
import { ScopedR2 } from "../scoped/r2"
import { ScopedVectorize } from "../scoped/vectorize"
import { SessionStore } from "./store"

/** The per-request, tenant-scoped session/governance service bundle. */
export interface SessionServices {
  db: ScopedDB
  sessions: SessionStore
  governance: GovernanceStore
  /** OKF-compatible agent memory on the pages layer (memory_* ops). */
  memory: MemoryStore
  vectors: ScopedVectorize
  blobs: ScopedR2
  ai: {
    /** READ path — `null` ⇒ degrade. */
    embed: (texts: string[]) => Promise<number[][] | null>
    /** WRITE/index path — throws to trigger Workflow retry. */
    embedForIndex: (texts: string[]) => Promise<number[][]>
    /** READ path — `null` ⇒ no extraction/synthesis. */
    gen: (prompt: string, system?: string) => Promise<string | null>
    /** READ path — degrades to RRF/identity order. */
    rerank: (query: string, candidates: RerankCandidate[], topK: number) => Promise<RerankHit[]>
  }
}

export interface SessionServicesOptions {
  /** Audit+alert sink for break-glass reads (chunks AND facts); absent ⇒ break-glass fails closed. */
  breakGlassAudit?: BreakGlassAudit
}

export const createSessionServices = (
  env: BrainBindings,
  principal: Principal,
  options?: SessionServicesOptions,
): SessionServices => {
  const raw = drizzle(env.DB)
  const aiDeps: AiDeps = { ai: env.AI, gatewayId: env.AI_GATEWAY_ID, tenantId: principal.tenantId }
  return {
    db: new ScopedDB(raw, principal, options?.breakGlassAudit),
    sessions: new SessionStore(raw, principal),
    governance: new GovernanceStore(raw, principal, options?.breakGlassAudit),
    memory: new MemoryStore(raw, principal),
    vectors: new ScopedVectorize(env.CHUNK_INDEX, principal),
    blobs: new ScopedR2(env.BODIES, principal),
    ai: {
      embed: (texts) => embed(aiDeps, texts),
      embedForIndex: (texts) => embedForIndex(aiDeps, texts),
      gen: (prompt, system) => gen(aiDeps, prompt, system),
      rerank: (query, candidates, topK) => rerank(aiDeps, query, candidates, topK),
    },
  }
}

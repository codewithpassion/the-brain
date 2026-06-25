/** Isolation chokepoints (PRD §7) — see the individual modules for invariants. */
export type {
  BrainDrizzle,
  BreakGlassAudit,
  BreakGlassEvent,
  InsertChunkInput,
  InsertDocumentInput,
  RecallTraceInput,
  RecordSpendInput,
  ScopedChunk,
  ScopedDocument,
  ScopedFact,
  UpdateChunkEmbeddingInput,
  UpdateDocumentStatusInput,
  UpsertMemoryPolicyInput,
} from "./db"
export { ScopedDB } from "./db"
export type { VisibilityColumns } from "./predicates"
export { scopePredicate, visibilityPredicate } from "./predicates"
export type { R2PutBody } from "./r2"
export { ScopedR2 } from "./r2"
export type { ScopedUpsert, ScopedVectorQuery, VectorMatch } from "./vectorize"
export { ScopedVectorize } from "./vectorize"

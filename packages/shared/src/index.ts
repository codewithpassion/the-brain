/**
 * `@brain/shared` — the FROZEN shared contract for The Brain.
 *
 * Pure types, constants, and Zod schemas only. No Cloudflare runtime imports,
 * no DB, no side effects. Every other package imports from here so the
 * cross-section contract cannot drift.
 */

// ── Model + algorithm + limit constants ──────────────────────────────────────
export {
  CANDIDATE_TOP,
  CHUNK_DB_BATCH_SIZE,
  COSINE_FLOOR,
  EMBED_BATCH_SIZE,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EXTRACT_MODEL,
  GENERATION_MODEL,
  INGEST_WEBHOOK_MAX_BYTES,
  KG_BATCH_SIZE,
  MARKDOWN_PREVIEW_MAX,
  MAX_BODY_BYTES,
  MAX_CHUNKS_PER_DOC,
  MONTHLY_COST_CEILING_USD,
  RELATED_FLOOR,
  RERANK_MODEL,
  RRF_K,
  SYNTHESIS_TOKEN_BUDGET,
  THINK_TOP_K,
  TITLE_BOOST,
  VECTORIZE_TOPK_MAX,
} from "./constants"
export type { Capability, EntityVisibility, Role, TrustGrade, Visibility } from "./enums"
// ── Enums / unions (governance + identity axes) ──────────────────────────────
export {
  CAPABILITIES,
  CapabilitySchema,
  ENTITY_VISIBILITIES,
  EntityVisibilitySchema,
  ROLES,
  RoleSchema,
  TRUST_BOOST,
  TRUST_GRADES,
  TrustGradeSchema,
  VISIBILITIES,
  VisibilitySchema,
} from "./enums"
export type { EdgeSpec, GraphNode, GraphPath } from "./graph"
// ── Graph contracts (two-graph model + generalized EdgeSpec) ─────────────────
export { DOC_GRAPH, ENTITY_GRAPH } from "./graph"
// ── Ingestion params ─────────────────────────────────────────────────────────
export type { IngestionParams } from "./ingest"
// ── Truncation-salvage JSON parsing (shared by KG extractor + Dream judge) ───
export { extractJsonCandidates } from "./json"
export type { AnyOpDef, DefineOpInput, OpDef, OpSurface } from "./ops"
// ── Op-registry (single source of truth for MCP + tRPC + CLI) ────────────────
export {
  ALL_SURFACES,
  CORE_OPS,
  defineOp,
  OP_SURFACES,
  OpRegistry,
  SEARCH_OP,
  THINK_OP,
} from "./ops"
export type { AuthMethod, AuthMethodKind, Principal } from "./principal"
// ── Principal + AuthMethod (canonical identity/scope contract) ────────────────
export {
  AUTH_METHOD_KINDS,
  AuthMethodSchema,
  PrincipalSchema,
} from "./principal"
// ── Capability-authorization gate (admin ⊃ write ⊃ read) ─────────────────────
export { scopeSatisfied } from "./scope"
// ── Deterministic slugify (shared by entity / org / Dream insight slugs) ─────
export { slugify } from "./slug"

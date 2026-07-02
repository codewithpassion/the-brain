import { z } from "zod"

/**
 * Governance & access enums for The Brain (PRD §3 / §7.5).
 *
 * The two governance axes are NEVER conflated:
 *   - `TrustGrade` is an agent-BEHAVIOUR signal (lives only in the
 *     `memory_use_policy` sidecar; never a column on chunks/documents/facts).
 *   - `Visibility` is ACCESS control (an intra-tenant row tier).
 * They stay orthogonal — a trust promotion never rewrites a chunk, and a
 * visibility change never touches a trust grade.
 *
 * Likewise the identity axes stay separate (PRD §7.2):
 *   - `Role` is the membership rank.
 *   - `Capability` is the read|write|admin authorization axis, distinct from
 *     `allowedScopes` (the DATA-partition axis on the `Principal`).
 */

// ── Trust grade (behaviour) — PRD §3 / §7.5 ──────────────────────────────────
export const TRUST_GRADES = ["instruction", "evidence", "draft"] as const
export const TrustGradeSchema = z.enum(TRUST_GRADES)
export type TrustGrade = z.infer<typeof TrustGradeSchema>

/**
 * Multiplicative trust weighting applied at read/rank time (PRD §5 constants).
 * Agent writeback is hard-wired to `evidence`; promotion to `instruction` flows
 * exclusively through a human-confirmed `memory_review` row.
 */
export const TRUST_BOOST = {
  instruction: 2.0,
  evidence: 1.0,
  draft: 0.6,
} as const satisfies Record<TrustGrade, number>

/**
 * Multiplicative NOTABILITY weighting (Dream hygiene D5) — applied at rank time to a candidate that
 * carries a fact `notability` (raised by the hygiene boost / lowered implicitly by decay). TUNABLE.
 * `medium` is neutral (1.0) so this is a no-op for the common tier; chunk candidates carry NO
 * notability, so it is inert for content search today (effectively OFF) until a fact-bearing arm
 * supplies it — the flagged/minimal weight the D5 plan asked for.
 */
export const NOTABILITY_BOOST = {
  high: 1.15,
  medium: 1.0,
  low: 0.9,
} as const satisfies Record<"high" | "medium" | "low", number>

// ── Visibility (access) — PRD §3 / §7.5 ──────────────────────────────────────
export const VISIBILITIES = ["private", "team", "world"] as const
export const VisibilitySchema = z.enum(VISIBILITIES)
export type Visibility = z.infer<typeof VisibilitySchema>

/**
 * The KG node space (`entities`) carries NO `private` tier — entities are a
 * canonical merge of mentions, gated `{team, world}` only and merged
 * max-permissive (PRD §3 / §6.1).
 */
export const ENTITY_VISIBILITIES = ["team", "world"] as const
export const EntityVisibilitySchema = z.enum(ENTITY_VISIBILITIES)
export type EntityVisibility = z.infer<typeof EntityVisibilitySchema>

// ── Role (membership rank) — PRD §7.2 ────────────────────────────────────────
export const ROLES = ["owner", "admin", "member", "readonly"] as const
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>

// ── Capability (authorization axis, NOT a data partition) — PRD §7.2 / §9 ────
export const CAPABILITIES = ["read", "write", "admin"] as const
export const CapabilitySchema = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof CapabilitySchema>

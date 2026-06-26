/**
 * Pure data model for the entity-graph canvas — no browser APIs, server-side safe.
 * Maps the-brain's Entity/TraversalNeighbor shapes into graph nodes/links.
 */
import type { Entity, TraversalNeighbor } from "../server/types"

export interface GraphNode {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly color: string
  readonly mentionCount: number
}

export interface GraphLink {
  readonly source: string
  readonly target: string
  readonly label: string
}

// Stable colour palette — same hues across sessions so the visual stays consistent.
const PALETTE: Readonly<Record<string, string>> = {
  person: "#60a5fa", // sky-400
  org: "#f59e0b", // amber-500
  topic: "#a78bfa", // violet-400
  habit: "#34d399", // emerald-400
  goal: "#f472b6", // pink-400
  place: "#fb7185", // rose-400
}

const FALLBACK_COLOR = "#64748b" // slate-500

export function colorForKind(kind: string): string {
  return PALETTE[kind] ?? FALLBACK_COLOR
}

export function entitiesToNodes(entities: readonly Entity[]): readonly GraphNode[] {
  return entities.map((e) => ({
    id: e.id,
    label: e.name,
    kind: e.kind,
    color: colorForKind(e.kind),
    mentionCount: e.mentionCount,
  }))
}

export function neighborsToLinks(
  seedId: string,
  neighbors: readonly TraversalNeighbor[],
): readonly GraphLink[] {
  return neighbors.map((n) => ({
    source: seedId,
    target: n.id,
    label: n.relation,
  }))
}

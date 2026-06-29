/**
 * Pure data model for the entity-graph canvas — no browser APIs, server-side safe.
 * Maps the-brain's Entity/EntityEdge/TraversalResult shapes into graph nodes/links.
 */
import type { Entity, EntityEdge, TraversalResult } from "../server/types"

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

// Stable colour palette — maps actual entity kinds (person|org|project|concept|place|event|other)
// to distinct hues. Falls back to slate for any unrecognised kind.
const PALETTE: Readonly<Record<string, string>> = {
  person: "#60a5fa", // sky-400
  org: "#f59e0b", // amber-500
  project: "#a78bfa", // violet-400
  concept: "#34d399", // emerald-400
  place: "#fb7185", // rose-400
  event: "#f472b6", // pink-400
  other: "#64748b", // slate-500
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

/** Convert entity-relation edges loaded on mount into graph links. */
export function edgesToLinks(edges: readonly EntityEdge[]): readonly GraphLink[] {
  return edges.map((e) => ({
    source: e.fromId,
    target: e.toId,
    label: e.kind,
  }))
}

/** Convert traversal paths (from traverse_graph op) into graph links. */
export function pathsToLinks(
  paths: readonly Pick<TraversalResult["paths"][number], "from_id" | "to_id" | "link_type">[],
): readonly GraphLink[] {
  return paths.map((p) => ({
    source: p.from_id,
    target: p.to_id,
    label: p.link_type,
  }))
}

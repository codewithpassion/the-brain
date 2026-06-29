/**
 * EntityGraph — SSR-safe force-directed entity visualization.
 *
 * react-force-graph-2d accesses window/canvas at module-load time and crashes
 * Cloudflare Workers SSR if imported eagerly. We defer the import to a useEffect
 * (never runs server-side), hold the component in React state, and render a
 * placeholder on the initial (server) pass. After hydration the effect fires,
 * loads the lib, and the canvas replaces the placeholder — no hydration mismatch.
 *
 * openbrains/apps/dashboard imports ForceGraph2D eagerly because it is a
 * pure client-side Vite app with no SSR. The SSR-safe pattern here is original.
 */
import type { ComponentType } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { traverseGraph } from "../server/fns"
import type { Entity, EntityEdge } from "../server/types"
import type { GraphLink, GraphNode } from "./graph-model"
import {
  colorForKind,
  edgesToLinks,
  edgesToNodes,
  entitiesToNodes,
  pathsToLinks,
} from "./graph-model"

// Mutable variants — react-force-graph-2d adds x/y/vx/vy to each object in-place.
interface MutableNode extends GraphNode {
  x?: number
  y?: number
  vx?: number
  vy?: number
}

interface EntityGraphProps {
  entities: readonly Entity[]
  edges: readonly EntityEdge[]
  /** Called when a graph node is clicked — keeps the table traversal panel in sync. */
  onNodeSelect?: (entity: Entity) => void
}

export function EntityGraph({ entities, edges, onNodeSelect }: EntityGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 520 })
  /**
   * Held in state so the render tree only includes the ForceGraph2D component
   * after client-side hydration (useState initialises to null on the server,
   * useEffect never runs on the server, so the server always renders the
   * placeholder branch).
   */
  const [Graph, setGraph] = useState<ComponentType<Record<string, unknown>> | null>(null)
  // Initialise with all loaded edges so relationship lines appear immediately on mount.
  const [accLinks, setAccLinks] = useState<readonly GraphLink[]>(() => edgesToLinks(edges))
  const [expanding, setExpanding] = useState(false)
  // Ref — mutation does not need to trigger a re-render.
  const expandedIds = useRef(new Set<string>())

  // --- SSR-safe dynamic import --------------------------------------------------
  // import() is only called after hydration (inside useEffect); the server never
  // reaches this code path, so react-force-graph-2d is never bundled server-side.
  useEffect(() => {
    let cancelled = false
    void import("react-force-graph-2d").then((mod) => {
      if (!cancelled) {
        // Functional-updater form prevents React from calling the component
        // as a state-updater function.
        setGraph(() => mod.default as ComponentType<Record<string, unknown>>)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // --- Responsive width ---------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current
    if (el === null) return
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: 520 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- Graph data ---------------------------------------------------------------
  // Node set = the listed entities (carry mentionCount for sizing + standalone, edge-less ones)
  // MERGED with every edge endpoint (so the relationship network renders fully — no line dropped
  // because one endpoint fell outside the listed top-N). Dedupe by id; the listed entity wins
  // (it has the real mentionCount).
  const nodes = useMemo(() => {
    const byId = new Map<string, GraphNode>()
    for (const n of edgesToNodes(edges)) byId.set(n.id, n)
    for (const n of entitiesToNodes(entities)) byId.set(n.id, n)
    return [...byId.values()]
  }, [entities, edges])

  // Drop links whose endpoints are not in the current node set (safety net).
  const nodeIdSet = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])

  /**
   * Shallow-copy every node and link before handing them to ForceGraph2D.
   * The library mutates objects in-place (adds x, y, vx, vy, index …) so we
   * must never pass the original readonly records.
   */
  const graphData = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })) as MutableNode[],
      links: accLinks
        .filter((l) => nodeIdSet.has(l.source) && nodeIdSet.has(l.target))
        .map((l) => ({ ...l })),
    }),
    [nodes, accLinks, nodeIdSet],
  )

  // --- Node click: expand neighbors via traversal ------------------------------
  const onNodeClick = useCallback(
    async (rawNode: unknown) => {
      const node = rawNode as MutableNode

      // Sync the table traversal panel below with the clicked entity.
      const entity = entities.find((e) => e.id === node.id)
      if (entity !== undefined && onNodeSelect !== undefined) onNodeSelect(entity)

      // Only traverse each node once (edges accumulate across clicks).
      if (expandedIds.current.has(node.id)) return
      expandedIds.current.add(node.id)

      setExpanding(true)
      const res = await traverseGraph({ data: { seedId: node.id } })
      if (res.ok) {
        const newLinks = pathsToLinks(res.data.paths)
        setAccLinks((prev) => {
          // Dedup by source:target pair to avoid duplicate lines.
          const seen = new Set(prev.map((l) => `${l.source}:${l.target}`))
          const fresh = newLinks.filter((l) => !seen.has(`${l.source}:${l.target}`))
          return fresh.length > 0 ? [...prev, ...fresh] : prev
        })
      }
      setExpanding(false)
    },
    [entities, onNodeSelect],
  )

  // --- Node label canvas paint (rendered "after" the default circle) -----------
  const paintNodeLabel = useCallback(
    (rawNode: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const node = rawNode as MutableNode
      const fontSize = 12 / globalScale
      ctx.save()
      ctx.font = `${fontSize}px Sans-Serif`
      ctx.textAlign = "center"
      ctx.textBaseline = "top"
      ctx.fillStyle = "#e2e8f0" // slate-100 — readable on the dark canvas background
      // The default node radius = nodeRelSize(4) * sqrt(nodeVal) where nodeVal = Math.max(2, mentionCount).
      const r = 4 * Math.sqrt(Math.max(2, node.mentionCount)) + 2
      ctx.fillText(node.label, node.x ?? 0, (node.y ?? 0) + r)
      ctx.restore()
    },
    [],
  )

  const kinds = useMemo(() => {
    const set = new Set(nodes.map((n) => n.kind))
    return [...set].sort()
  }, [nodes])

  // --- Empty state --------------------------------------------------------------
  if (entities.length === 0) {
    return (
      <p className="text-neutral-500 text-sm">
        No entities yet — ingest some documents to populate the graph.
      </p>
    )
  }

  // --- Render ------------------------------------------------------------------
  return (
    <div className="space-y-3">
      <Legend kinds={kinds} />
      {expanding && <p className="text-neutral-400 text-xs">Expanding neighbors…</p>}
      <div ref={containerRef} className="overflow-hidden rounded-md border">
        {Graph === null ? (
          <div className="flex h-[520px] items-center justify-center text-neutral-400 text-sm">
            Loading graph…
          </div>
        ) : (
          <Graph
            graphData={graphData}
            width={size.width}
            height={size.height}
            nodeColor={(n: unknown) => (n as MutableNode).color}
            nodeLabel={(n: unknown) => `${(n as MutableNode).label} (${(n as MutableNode).kind})`}
            nodeRelSize={3}
            // Gentle sqrt scale + cap so high-mention entities don't become giant blobs that hide
            // the relationship lines underneath.
            nodeVal={(n: unknown) => Math.min(10, 1 + Math.sqrt((n as MutableNode).mentionCount))}
            nodeCanvasObject={paintNodeLabel}
            nodeCanvasObjectMode={() => "after"}
            linkColor={() => "#94a3b8"}
            linkLabel={(l: unknown) => (l as GraphLink).label}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            cooldownTicks={60}
            onNodeClick={onNodeClick}
          />
        )}
      </div>
    </div>
  )
}

function Legend({ kinds }: { kinds: readonly string[] }) {
  if (kinds.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-3 text-sm">
      {kinds.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-3 rounded-full"
            style={{ backgroundColor: colorForKind(k) }}
          />
          <span className="text-neutral-500">{k}</span>
        </li>
      ))}
    </ul>
  )
}

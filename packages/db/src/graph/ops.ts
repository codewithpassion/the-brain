/**
 * The graph + entity ops (PRD §6.5 surface), registered into the shared `OpRegistry` exactly
 * like the retrieval ops (search/ops.ts): each is a `BoundOp` = the FROZEN handler-free
 * `OpDef` contract + a runtime handler composing the chokepoints. Handlers bind in the Worker.
 *
 * SCOPE: the read surface — `traverse_graph`, `get_links`, `get_backlinks`, `get_tags`,
 * `get_timeline`, `list_entities`, `find_orphans`, `search_entities` — plus the W4.4 mutating
 * curation surface `add_link` / `add_tag` / `add_timeline_entry` (each a `write` op routed
 * through `ScopedGraph` with an in-batch audit row). The remaining §6.5 surface
 * (`remove_link` / `get_versions` / `revert_version` / `get_entity` / `entity_relations`) stays
 * DEFERRED.
 */
import {
  type AnyOpDef,
  DOC_GRAPH,
  defineOp,
  ENTITY_GRAPH,
  type GraphPath,
  type OpRegistry,
  type Principal,
} from "@brain/shared"
import { z } from "zod"
import type { ScopedVectorize } from "../scoped/vectorize"
import type { AiPort } from "../search/types"
import { type EntityHit, searchEntities } from "./entities"
import type { DocLinkRow, EntityRow, OrphanReport, ScopedGraph, TimelineRow } from "./scoped-graph"

/** The per-request dependency bundle a graph op handler receives. */
export interface GraphOpDeps {
  graph: ScopedGraph
  entityVectors: ScopedVectorize
  ai: Pick<AiPort, "embed">
}

/** The context a bound graph-op handler receives (mirrors `search` `OpContext`). */
export interface GraphOpContext {
  deps: GraphOpDeps
  principal: Principal
}

/** A frozen `OpDef` contract paired with its runtime handler. */
export interface BoundOp<I, O> {
  def: AnyOpDef
  handler: (ctx: GraphOpContext, input: I) => Promise<O>
}

// ── Zod contracts ─────────────────────────────────────────────────────────────

const GraphPathSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  link_type: z.string(),
  context: z.string(),
  confidence: z.number().optional(),
  depth: z.number().int(),
})

const DocLinkSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  linkType: z.string(),
  context: z.string(),
})

const EntityHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  description: z.string(),
  score: z.number(),
  scope: z.string().nullable(),
  visibility: z.string(),
  teamId: z.string().nullable(),
  /** Dashboard deep link to this entity's wiki page — present when DASHBOARD_URL is configured. */
  url: z.string().optional(),
})

const anchorInput = z.object({
  target: z.string().min(1).describe("Document slug or entity id to query."),
})

// ── Op definitions ──────────────────────────────────────────────────────────────

export const TRAVERSE_OP = defineOp({
  name: "traverse_graph",
  description:
    "BFS traversal of the document link graph or entity knowledge graph up to a given depth and direction. " +
    "Use for multi-hop paths; use get_links/get_backlinks for direct one-hop edges.",
  capability: "read",
  readOnly: true,
  input: z.object({
    target: z.string().min(1).describe("Slug or id of the start node."),
    depth: z.number().int().min(1).max(10).default(5).describe("BFS hop depth 1–10 (default 5)."),
    direction: z
      .enum(["in", "out", "both"])
      .default("both")
      .describe(
        "'out' = follows links forward; 'in' = follows backlinks; 'both' = all directions.",
      ),
    graph: z
      .enum(["doc", "entity"])
      .default("doc")
      .describe("'doc' = document link graph; 'entity' = entity knowledge graph."),
  }),
  output: z.object({ paths: z.array(GraphPathSchema) }),
})

export const GET_LINKS_OP = defineOp({
  name: "get_links",
  description:
    "Return all outgoing typed links from a document or entity node (one hop). " +
    "Use before traverse_graph when you only need immediate forward neighbors.",
  capability: "read",
  readOnly: true,
  input: anchorInput,
  output: z.object({ links: z.array(DocLinkSchema) }),
})

export const GET_BACKLINKS_OP = defineOp({
  name: "get_backlinks",
  description:
    "Return all incoming typed links pointing at a document or entity node (one hop). " +
    "Complements get_links for discovering what references a given node.",
  capability: "read",
  readOnly: true,
  input: anchorInput,
  output: z.object({ links: z.array(DocLinkSchema) }),
})

export const GET_TAGS_OP = defineOp({
  name: "get_tags",
  description:
    "Return the tags attached to a document or entity node by slug. " +
    "Use to check categorization before filtering list_documents by tag.",
  capability: "read",
  readOnly: true,
  input: anchorInput,
  output: z.object({ tags: z.array(z.string()) }),
})

export const GET_TIMELINE_OP = defineOp({
  name: "get_timeline",
  description:
    "Return the ordered timeline entries for a document or entity node, newest first. " +
    "Use to reconstruct the chronological history of events associated with a node.",
  capability: "read",
  readOnly: true,
  input: anchorInput,
  output: z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        date: z.string(),
        summary: z.string(),
        detail: z.string(),
        source: z.string(),
      }),
    ),
  }),
})

export const LIST_ENTITIES_OP = defineOp({
  name: "list_entities",
  description:
    "List knowledge-graph entities (people, orgs, concepts) visible to the caller, optionally filtered by kind. " +
    "Use to enumerate entities before graph traversal; use search_entities to find one by name.",
  capability: "read",
  readOnly: true,
  input: z.object({
    kind: z
      .string()
      .optional()
      .describe("Filter by entity kind, e.g. 'person', 'org', 'concept'. Omit for all kinds."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max entities to return (1–200, default 50)."),
  }),
  output: z.object({
    entities: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        canonicalName: z.string(),
        description: z.string(),
        aliases: z.array(z.string()),
        scope: z.string().nullable(),
        visibility: z.string(),
        teamId: z.string().nullable(),
        mentionCount: z.number().int(),
        /** Dashboard deep link to this entity's wiki page — present when DASHBOARD_URL is configured. */
        url: z.string().optional(),
      }),
    ),
  }),
})

export const LIST_ENTITY_EDGES_OP = defineOp({
  name: "list_entity_edges",
  description:
    "List all entity-relation edges in the knowledge graph. " +
    "Use for full graph export or visualization; for a single node's neighborhood use traverse_graph with graph='entity'.",
  capability: "read",
  readOnly: true,
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(1000)
      .describe("Max edges to return (1–2000, default 1000)."),
  }),
  output: z.object({
    edges: z.array(
      z.object({
        fromId: z.string(),
        fromName: z.string(),
        fromKind: z.string(),
        toId: z.string(),
        toName: z.string(),
        toKind: z.string(),
        kind: z.string(),
      }),
    ),
  }),
})

export const FIND_ORPHANS_OP = defineOp({
  name: "find_orphans",
  description:
    "Report document or entity nodes with no graph connections. Not a deleter. " +
    "Use to audit coverage gaps in the knowledge graph before running traversal.",
  capability: "read",
  readOnly: true,
  input: z.object({
    graph: z
      .enum(["doc", "entity"])
      .default("doc")
      .describe("'doc' = document link graph; 'entity' = entity knowledge graph."),
  }),
  output: z.object({
    orphans: z.array(z.object({ id: z.string(), label: z.string(), type: z.string() })),
    totalOrphans: z.number().int(),
    totalLinkable: z.number().int(),
    totalNodes: z.number().int(),
    excluded: z.number().int(),
  }),
})

export const SEARCH_ENTITIES_OP = defineOp({
  name: "search_entities",
  description:
    "Semantic search over knowledge-graph entities using vector+FTS RRF fusion. " +
    "Use to find an entity by name or description when you don't know its id; use list_entities to enumerate all.",
  capability: "read",
  readOnly: true,
  input: z.object({
    query: z.string().min(1).describe("Name or description to search for."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Max entities to return (1–100, default 20)."),
  }),
  output: z.object({ hits: z.array(EntityHitSchema) }),
})

// ── Mutating op definitions (W4.4; capability: write) ─────────────────────────────

export const ADD_LINK_OP = defineOp({
  name: "add_link",
  description:
    "Create a typed link between two doc-graph pages (each named by slug or id). " +
    "Use to manually connect pages the extractor missed; the edge then shows in get_links/get_backlinks.",
  capability: "write",
  readOnly: false,
  input: z.object({
    from: z.string().min(1).describe("Source page slug or id."),
    to: z.string().min(1).describe("Target page slug or id."),
    linkType: z
      .string()
      .default("")
      .describe("Relationship label, e.g. 'relates_to', 'depends_on'. Empty for a generic link."),
    context: z.string().default("").describe("Optional note describing why the pages are linked."),
  }),
  output: z.object({
    fromId: z.string(),
    toId: z.string(),
    linkType: z.string(),
    context: z.string(),
  }),
})

export const ADD_TAG_OP = defineOp({
  name: "add_tag",
  description:
    "Attach a tag to a doc-graph page (named by slug or id). Idempotent. " +
    "Use to categorize a page so get_tags and tag-filtered listings surface it.",
  capability: "write",
  readOnly: false,
  input: z.object({
    target: z.string().min(1).describe("Page slug or id to tag."),
    tag: z.string().min(1).describe("The tag to attach."),
  }),
  output: z.object({ pageId: z.string(), tag: z.string() }),
})

export const ADD_TIMELINE_ENTRY_OP = defineOp({
  name: "add_timeline_entry",
  description:
    "Append a dated timeline entry to a doc-graph page (named by slug or id). Idempotent per " +
    "(date, summary). Use to record an event in a page's chronological history (get_timeline).",
  capability: "write",
  readOnly: false,
  input: z.object({
    target: z.string().min(1).describe("Page slug or id the entry belongs to."),
    date: z.string().min(1).describe("Entry date (ISO-8601 or any sortable date string)."),
    summary: z.string().min(1).describe("One-line summary of the event."),
    detail: z.string().default("").describe("Optional longer detail for the entry."),
  }),
  output: z.object({
    id: z.string(),
    pageId: z.string(),
    date: z.string(),
    summary: z.string(),
  }),
})

// ── Bound handlers ────────────────────────────────────────────────────────────

const specOf = (graph: "doc" | "entity") => (graph === "entity" ? ENTITY_GRAPH : DOC_GRAPH)

export const traverseOp: BoundOp<
  { target: string; depth: number; direction: "in" | "out" | "both"; graph: "doc" | "entity" },
  { paths: GraphPath[] }
> = {
  def: TRAVERSE_OP,
  handler: async (ctx, input) => {
    const spec = specOf(input.graph)
    const seedId = await ctx.deps.graph.resolveNodeId(spec, input.target)
    if (seedId === null) return { paths: [] }
    const paths = await ctx.deps.graph.traverse(spec, seedId, {
      depth: input.depth,
      direction: input.direction,
    })
    return { paths }
  },
}

export const getLinksOp: BoundOp<{ target: string }, { links: DocLinkRow[] }> = {
  def: GET_LINKS_OP,
  handler: async (ctx, input) => ({ links: await ctx.deps.graph.getLinks(input.target) }),
}

export const getBacklinksOp: BoundOp<{ target: string }, { links: DocLinkRow[] }> = {
  def: GET_BACKLINKS_OP,
  handler: async (ctx, input) => ({ links: await ctx.deps.graph.getBacklinks(input.target) }),
}

export const getTagsOp: BoundOp<{ target: string }, { tags: string[] }> = {
  def: GET_TAGS_OP,
  handler: async (ctx, input) => ({ tags: await ctx.deps.graph.getTags(input.target) }),
}

export const getTimelineOp: BoundOp<{ target: string }, { entries: TimelineRow[] }> = {
  def: GET_TIMELINE_OP,
  handler: async (ctx, input) => ({ entries: await ctx.deps.graph.getTimeline(input.target) }),
}

export const listEntitiesOp: BoundOp<{ kind?: string; limit: number }, { entities: EntityRow[] }> =
  {
    def: LIST_ENTITIES_OP,
    handler: async (ctx, input) => ({
      entities: await ctx.deps.graph.listEntities({
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        limit: input.limit,
      }),
    }),
  }

export const listEntityEdgesOp: BoundOp<
  { limit: number },
  { edges: { fromId: string; toId: string; kind: string }[] }
> = {
  def: LIST_ENTITY_EDGES_OP,
  handler: async (ctx, input) => ({ edges: await ctx.deps.graph.listEntityEdges(input.limit) }),
}

export const findOrphansOp: BoundOp<{ graph: "doc" | "entity" }, OrphanReport> = {
  def: FIND_ORPHANS_OP,
  handler: (ctx, input) => ctx.deps.graph.findOrphans(input.graph),
}

export const searchEntitiesOp: BoundOp<{ query: string; topK: number }, { hits: EntityHit[] }> = {
  def: SEARCH_ENTITIES_OP,
  handler: async (ctx, input) => ({
    hits: await searchEntities(ctx.deps, input.query, { topK: input.topK }),
  }),
}

export const addLinkOp: BoundOp<
  { from: string; to: string; linkType: string; context: string },
  DocLinkRow
> = {
  def: ADD_LINK_OP,
  handler: (ctx, input) => ctx.deps.graph.addLink(input),
}

export const addTagOp: BoundOp<{ target: string; tag: string }, { pageId: string; tag: string }> = {
  def: ADD_TAG_OP,
  handler: (ctx, input) => ctx.deps.graph.addTag(input),
}

export const addTimelineEntryOp: BoundOp<
  { target: string; date: string; summary: string; detail: string },
  { id: string; pageId: string; date: string; summary: string }
> = {
  def: ADD_TIMELINE_ENTRY_OP,
  handler: (ctx, input) => ctx.deps.graph.addTimelineEntry(input),
}

/** Every bound graph op. */
export const GRAPH_OPS = [
  traverseOp,
  getLinksOp,
  getBacklinksOp,
  getTagsOp,
  getTimelineOp,
  listEntitiesOp,
  listEntityEdgesOp,
  findOrphansOp,
  searchEntitiesOp,
  addLinkOp,
  addTagOp,
  addTimelineEntryOp,
] as const

/** Register the graph op CONTRACTS into a shared `OpRegistry` (handlers bind in the Worker). */
export const registerGraphOps = (registry: OpRegistry): OpRegistry => {
  for (const op of GRAPH_OPS) registry.register(op.def)
  return registry
}

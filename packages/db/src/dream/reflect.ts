/**
 * `runDreamReflection` (v2 W1/D2) — the dream's second act: reflect over the tenant's own memory
 * and write cited INSIGHT documents. It reuses the EXISTING `think` pipeline verbatim (no fork) to
 * synthesize, then stores each insight through the normal ingest spine so it is searchable,
 * citable, and (in the workflow path only) graph-linked. Runs over the shared `runDreamJob` FSM.
 *
 * TARGETS: per-arm quotas — top entities by mention growth + top namespaces by new-doc growth
 * SINCE the last successful reflection run. ANTI-LOOP (D-i2, depth ≤ 1): BOTH arms exclude
 * `origin='dream'` documents (namespaces directly; entities via the mention→chunk→document join),
 * so an insight is never a reflection target. Both arms also apply `deleted_at IS NULL` +
 * `scopePredicate` — a scope-limited principal never reflects over out-of-scope memory (isolation).
 *
 * TRUST (D-i1): each insight gets an explicit `memory_use_policy` `trust_grade='draft'` (below
 * evidence) — dream output never reads above draft. BUDGET (D-i3): its OWN `dream_runs` row
 * (`kind='reflection'`), `surface='dream'` spend via `recordThinkSpend`, clean `paused`/resume.
 * SCOPING (D-i4): every read/write tenant-forced; the ingest spine audits its own mutations.
 *
 * NOTE: KG-extraction over insight docs ("graph-linked") runs ONLY in the `DreamWorkflow` path
 * (`runEntityExtraction` lives in apps/api); the inline dispatch and this module do NOT run it.
 */
import { fingerprint } from "@brain/ingest"
import type { Principal } from "@brain/shared"
import { slugify, THINK_TOP_K } from "@brain/shared"
import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { runBatchIngestCore } from "../ingest"
import { syncBackingDoc } from "../pages/backing-doc"
import { chunks, documents, dreamRuns, entities, entityMentions, pages } from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import {
  DOC_ORIGIN_DREAM,
  liveEntityPredicate,
  notAgentAuthoredPage,
  notAgentOrigin,
  scopePredicate,
} from "../scoped/predicates"
import { thinkOp } from "../search/ops"
import { makeBudgetPort, monthlyWindow, recordThinkSpend } from "../search/ports"
import type { RecallSink, SearchDeps } from "../search/types"
import { createScopedServices, type ScopedServices } from "../services"
import { EntityPageStore } from "../wiki/entity-pages"
import { mintInsightPage } from "../wiki/insight-pages"
import { runDreamJob } from "./job"
import { reflectionRunId } from "./plan"
import { dreamRunId } from "./run"
import { type DreamRunStats, type DreamRunStatus, DreamRunStore } from "./runs"

/** Default reflection targets per run (small; budget-gated). */
const REFLECTION_TARGETS_PER_RUN = 3

/** The tenant-scoped bundle reflection needs — the FULL `ScopedServices` (think + ingest) + extras. */
export type DreamReflectServices = ScopedServices & {
  raw: BrainDrizzle
  runs: DreamRunStore
  principal: Principal
}

export interface DreamReflectionOptions {
  runId?: string
  maxNeurons?: number
  now?: string
  /** Max targets this run (default `REFLECTION_TARGETS_PER_RUN`). */
  targetLimit?: number
}

export interface DreamReflectionResult {
  runId: string
  status: DreamRunStatus
  noop: boolean
  resumed: boolean
  /** Insight document ids created this run — the workflow runs KG-extraction over these. */
  insightDocumentIds: string[]
  stats: DreamRunStats
  targetsRemaining: number
}

/** A reflection target — a namespace or an entity to synthesize an insight about. */
interface ReflectionTarget {
  /** Deterministic ordering key (cursor = last-processed key). */
  key: string
  /** Human label ("/brain/topics/pricing" or "Cloudflare Workers"). */
  label: string
  /** URL-safe slug fragment for the insight namespace/slug. */
  slugKey: string
  /** The retrieval query (carries the distinctive term so the pipeline grounds its evidence). */
  query: string
  /** Set for ENTITY targets — the entity whose page the dream also maintains (W2 deliverable 3). */
  entityId?: string
}

/** Reflection never writes recall traces (it is not a user read). */
const NOOP_RECALL: RecallSink = { append: async () => {} }

/** The insight namespace for a target. */
const insightPath = (target: ReflectionTarget): string => `/brain/insights/${target.slugKey}`

/** The last successful reflection run's `created_at` — the "new since" watermark (null ⇒ all-time). */
const lastReflectionSince = async (
  db: BrainDrizzle,
  principal: Principal,
): Promise<string | null> => {
  const rows = await db
    .select({ createdAt: dreamRuns.createdAt })
    .from(dreamRuns)
    .where(
      and(
        eq(dreamRuns.tenantId, principal.tenantId),
        eq(dreamRuns.kind, "reflection"),
        eq(dreamRuns.status, "success"),
      ),
    )
    .orderBy(desc(dreamRuns.createdAt))
    .limit(1)
  return rows[0]?.createdAt ?? null
}

/**
 * Select reflection targets with PER-ARM quotas (so `e:`-keyed entities can't starve `n:`
 * namespaces): ~half the limit to entities, the rest to namespaces, backfilling from the other arm
 * when one underfills. BOTH arms are tenant-forced + `scopePredicate` + `deleted_at IS NULL` +
 * `origin<>'dream'` (anti-loop + isolation). Deterministic key order for cursor resumability.
 */
export const selectReflectionTargets = async (
  db: BrainDrizzle,
  principal: Principal,
  opts: { since: string | null; limit: number },
): Promise<ReflectionTarget[]> => {
  const entityQuota = Math.ceil(opts.limit / 2)
  const namespaceQuota = opts.limit - entityQuota

  // ── Entities by mention growth (mentions from deleted OR origin='dream' docs excluded) ──
  const entRows = await db
    .select({ id: entities.id, name: entities.canonicalName, growth: sql<number>`count(*)` })
    .from(entityMentions)
    .innerJoin(
      entities,
      and(eq(entities.id, entityMentions.entityId), eq(entities.tenantId, entityMentions.tenantId)),
    )
    .leftJoin(
      chunks,
      and(
        eq(entityMentions.sourceKind, "chunk"),
        eq(chunks.id, entityMentions.sourceId),
        eq(chunks.tenantId, entityMentions.tenantId),
      ),
    )
    .leftJoin(
      documents,
      and(
        eq(documents.tenantId, entityMentions.tenantId),
        eq(
          documents.id,
          sql`coalesce(${chunks.documentId}, case when ${entityMentions.sourceKind} = 'document' then ${entityMentions.sourceId} end)`,
        ),
      ),
    )
    // W2 anti-loop (W-i4): a mention sourced from an AGENT-authored page (entity/insight) must not
    // count toward reflection growth — else a dream-maintained page would feed the dream that wrote
    // it. Non-page mentions leave this join NULL (kept); human wiki/memory page mentions are kept.
    .leftJoin(
      pages,
      and(
        eq(entityMentions.sourceKind, "page"),
        eq(pages.id, entityMentions.sourceId),
        eq(pages.tenantId, entityMentions.tenantId),
      ),
    )
    .where(
      and(
        eq(entityMentions.tenantId, principal.tenantId),
        opts.since ? gte(entityMentions.createdAt, opts.since) : undefined,
        notAgentOrigin(documents.origin),
        notAgentAuthoredPage(pages.ingestedVia),
        isNull(documents.deletedAt), // a NULL join (session/page source) keeps the mention
        liveEntityPredicate(entities), // never reflect on a D4 dedup loser
        scopePredicate(principal, entities.scope),
      ),
    )
    .groupBy(entities.id, entities.canonicalName)
    .orderBy(desc(sql`count(*)`), asc(entities.canonicalName))
    .limit(opts.limit) // over-fetch; capped after backfill
  const entityTargets: ReflectionTarget[] = entRows.map((row) => ({
    key: `e:${row.id}`,
    label: row.name,
    slugKey: slugify(row.name, "insight"),
    query: row.name,
    entityId: row.id,
  }))

  // ── Namespaces (documents grouped by path; origin='dream' + the insights namespace excluded) ──
  const nsRows = await db
    .select({ path: documents.path, cnt: sql<number>`count(*)` })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, principal.tenantId),
        isNull(documents.deletedAt),
        isNotNull(documents.path),
        notAgentOrigin(documents.origin),
        sql`${documents.path} NOT LIKE '/brain/insights/%'`,
        opts.since ? gte(documents.createdAt, opts.since) : undefined,
        scopePredicate(principal, documents.scope),
      ),
    )
    .groupBy(documents.path)
    .orderBy(desc(sql`count(*)`), asc(documents.path))
    .limit(opts.limit)
  const namespaceTargets: ReflectionTarget[] = nsRows
    .filter((row): row is { path: string; cnt: number } => row.path !== null)
    .map((row) => ({
      key: `n:${row.path}`,
      label: row.path,
      slugKey: slugify(row.path, "insight"),
      query: row.path.split("/").filter(Boolean).join(" "),
    }))

  // Per-arm quotas + backfill from the other arm when one underfills.
  const entTake = entityTargets.slice(0, entityQuota)
  const nsTake = namespaceTargets.slice(0, namespaceQuota)
  const chosen = [...entTake, ...nsTake]
  if (chosen.length < opts.limit) {
    const spare = [...entityTargets.slice(entTake.length), ...namespaceTargets.slice(nsTake.length)]
    chosen.push(...spare.slice(0, opts.limit - chosen.length))
  }
  chosen.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return chosen
}

/** The reflection question wrapped around a target. */
const reflectionQuery = (target: ReflectionTarget): string =>
  `About "${target.label}": based on the evidence, what is known, what has changed recently, ` +
  `what is unresolved or contradictory, and what connects to what? ${target.query}`

/** Render the cited insight markdown from a think result (citations preserved as slug links). */
const renderInsight = (
  target: ReflectionTarget,
  answer: string,
  citations: { slug: string }[],
  gaps: string[],
): string => {
  const sources = citations
    .map((c) => `- [[${c.slug}]]`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join("\n")
  const gapsBlock =
    gaps.length > 0 ? `\n\n## Open questions\n${gaps.map((g) => `- ${g}`).join("\n")}` : ""
  return `# Insight: ${target.label}\n\n${answer}\n\n## Sources\n${sources}${gapsBlock}\n`
}

/** True when an insight for this target already exists at/after the watermark (pre-think dedup). */
const hasRecentInsight = async (
  db: BrainDrizzle,
  principal: Principal,
  target: ReflectionTarget,
  since: string | null,
): Promise<boolean> => {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, principal.tenantId),
        eq(documents.path, insightPath(target)),
        eq(documents.origin, DOC_ORIGIN_DREAM),
        isNull(documents.deletedAt),
        since ? gte(documents.createdAt, since) : undefined,
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Synthesize one insight and ingest it as an `origin='dream'`, `draft`-trust document. Returns the
 * new/repaired doc id, or `null` when synthesis produced no answer or the target was already
 * consolidated into an indexed insight (dedup). Records `surface='dream'` spend; returns neurons.
 */
const reflectTarget = async (
  services: DreamReflectServices,
  target: ReflectionTarget,
  window: string,
): Promise<{ documentId: string | null; neurons: number }> => {
  const deps: SearchDeps = {
    db: services.db,
    vectors: services.vectors,
    ai: services.ai,
    budget: makeBudgetPort(services, window),
    recall: NOOP_RECALL,
  }
  const result = await thinkOp.handler(
    { deps, principal: services.principal },
    { query: reflectionQuery(target), topK: THINK_TOP_K },
  )
  const neurons = await recordThinkSpend(services, result, window, "dream")
  if (result.answer.trim().length === 0) return { documentId: null, neurons }

  const body = renderInsight(target, result.answer, result.citations, result.gaps)
  const fp = await fingerprint(body)
  const slug = `insight-${target.slugKey}-${fp.slice(0, 12)}`
  const path = insightPath(target)

  let documentId = crypto.randomUUID()
  try {
    await services.db.insertDocument({
      id: documentId,
      slug,
      fingerprint: fp,
      title: `Insight: ${target.label}`,
      contentType: "text/markdown",
      bodyR2Key: `documents/${documentId}`,
      status: "pending",
      tags: ["insight"],
      path,
      origin: DOC_ORIGIN_DREAM, // anti-loop marker (D-i2)
    })
  } catch {
    // A UNIQUE (tenant,scope,fingerprint)/(tenant,slug) conflict → resolve the existing doc; a
    // NON-dedup failure (no such doc) is a real error → rethrow so the run fails (resumable).
    const existing = (await services.db.listDocuments()).find(
      (d) => d.fingerprint === fp || d.slug === slug,
    )
    if (existing === undefined) throw new Error("reflect: insight insert failed (non-dedup)")
    const full = await services.db.getDocumentById(existing.id)
    const stuck =
      existing.status === "pending" ||
      existing.status === "processing" ||
      (full?.chunkCount ?? 0) === 0
    if (!stuck) {
      // Already indexed → no re-ingest, but STILL (re)mint + link the insight/entity pages so a page
      // whose first-run maintenance failed self-heals on the next reflect (documentId = the real doc).
      await maintainInsightAndEntityPages(services, target, result.answer, body, existing.id)
      return { documentId: null, neurons } // documentId null → the caller doesn't re-KG a deduped doc
    }
    documentId = existing.id // repair the orphaned/pending doc below (re-put body + re-ingest)
  }

  await services.blobs.put(`documents/${documentId}`, body)
  await runBatchIngestCore(services, {
    documentId,
    r2Key: `documents/${documentId}`,
    contentType: "text/markdown",
    path,
  })
  // D-i1: pin the insight at draft trust (never reads above draft).
  await services.db.upsertMemoryPolicy(documentId, { trustGrade: "draft", scopes: [] })

  await maintainInsightAndEntityPages(services, target, result.answer, body, documentId)
  return { documentId, neurons }
}

/**
 * Promote the insight to a first-class PAGE (Sources `[[slug]]` → real doc_links), link it to its
 * EXISTING insight document (W3 Option A — no double-index), and for an ENTITY target maintain the
 * entity's page too (dream-authored, don't-clobber). IDEMPOTENT + runs on EVERY reflect of a target
 * (incl. the dedup path) so `pages.document_id` lands even when the insight doc was unchanged — else a
 * first-run failure would permanently degrade the insight's citation to the raw doc slug. SECONDARY:
 * a failure here never fails the run (the insight doc already landed).
 */
const maintainInsightAndEntityPages = async (
  services: DreamReflectServices,
  target: ReflectionTarget,
  answer: string,
  body: string,
  insightDocId: string,
): Promise<void> => {
  try {
    const insightPage = await mintInsightPage(services.raw, services.principal, {
      slugKey: target.slugKey,
      title: target.label,
      body,
    })
    await services.graph.linkPageBackingDoc(insightPage.pageId, insightDocId)
    if (target.entityId !== undefined) {
      // Dream-maintained = the body is REPLACED with the latest synthesis each run (not accumulated);
      // a human's edits are protected by the don't-clobber gate, and every version is rollback-able.
      const entityStore = new EntityPageStore(services.raw, services.principal)
      const entityBody = `# ${target.label}\n\n${answer}\n\n## Insights\n- [[insights/${target.slugKey}]]\n`
      const minted = await entityStore.mintOrUpdate(target.entityId, {
        body: entityBody,
        systemAuthored: true,
      })
      // W3: the entity page's backing doc is searchable but KG-SKIPPED (agent origin) — KG-less core.
      if (minted?.pageId != null && minted.changed) {
        await syncBackingDoc(services, minted.pageId, (params) =>
          runBatchIngestCore(services, params).then(() => {}),
        )
      }
    }
  } catch (err) {
    console.error("reflect: entity/insight page maintenance failed", target.key, err)
  }
}

/** Run one reflection dream over the shared FSM driver. */
export const runDreamReflection = async (
  services: DreamReflectServices,
  opts?: DreamReflectionOptions,
): Promise<DreamReflectionResult> => {
  const now = opts?.now ?? new Date().toISOString()
  const runId =
    opts?.runId ?? reflectionRunId(dreamRunId(services.principal.tenantId, new Date(now)))
  const window = monthlyWindow(new Date(now))
  const targetLimit = opts?.targetLimit ?? REFLECTION_TARGETS_PER_RUN
  // Read the "new since" watermark BEFORE the run (the current row isn't `success` yet).
  const since = await lastReflectionSince(services.raw, services.principal)

  const result = await runDreamJob(services.runs, {
    runId,
    kind: "reflection",
    ...(opts?.maxNeurons !== undefined ? { maxNeurons: opts.maxNeurons } : {}),
    windowSpentNeurons: () => services.db.readWindowSpendNeurons(window),
    selectItems: () =>
      selectReflectionTargets(services.raw, services.principal, { since, limit: targetLimit }),
    itemKey: (target) => target.key,
    processItem: async (target) => {
      // Pre-think dedup: an insight for this target already exists this cycle → skip the think.
      if (await hasRecentInsight(services.raw, services.principal, target, since)) {
        return { neurons: 0, statsDelta: { targets: 1, skipped: 1 }, payload: null }
      }
      const { documentId, neurons } = await reflectTarget(services, target, window)
      return {
        neurons,
        statsDelta: {
          targets: 1,
          insights: documentId !== null ? 1 : 0,
          skipped: documentId !== null ? 0 : 1,
          neurons,
        },
        payload: documentId,
      }
    },
  })

  return {
    runId: result.runId,
    status: result.status,
    noop: result.noop,
    resumed: result.resumed,
    insightDocumentIds: result.payloads,
    stats: result.stats,
    targetsRemaining: result.itemsRemaining,
  }
}

/**
 * `createDreamReflectServices(env, principal)` — the FULL `ScopedServices` (think + ingest) plus the
 * raw handle + the `dream_runs` store. Raw `drizzle(env.DB)` here is legal (packages/db, invariant 2).
 */
export const createDreamReflectServices = (
  env: BrainBindings,
  principal: Principal,
): DreamReflectServices => {
  const raw = drizzle(env.DB)
  return {
    ...createScopedServices(env, principal),
    raw,
    runs: new DreamRunStore(raw, principal),
    principal,
  }
}

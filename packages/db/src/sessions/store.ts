/**
 * `SessionStore` — tenant-scoped reads/writes for the NET-NEW session + hot-memory tables
 * (`sessions`, `session_turns`, `facts`) that `ScopedDB` does not cover (PRD §8, authoritative).
 *
 * WHY A SEPARATE STORE (not new `ScopedDB` methods): `scoped/db.ts` is frozen for this phase;
 * `search/**` composes it the same way (it never adds methods). So this store COMPOSES the
 * public `ScopedDB` primitives where they suffice (`readFacts`, `ftsFactIds`, `appendRecallTrace`,
 * `insertChunks`, `updateChunkEmbedding`, `breakGlass`) and, for the rest, mirrors the SAME
 * discipline `ScopedDB` enforces:
 *   - `tenant_id = p.tenantId` is FORCED on every write, NEVER read from the caller (invariant 1).
 *   - every visibility-bearing read ANDs the SHARED `scopePredicate` + `visibilityPredicate`
 *     from `../scoped/predicates` (invariant 8) — the gate is never hand-rolled here.
 *   - every mutating write batches its `memory_audit` row in the SAME `db.batch` (invariant 10),
 *     all-or-nothing (invariant 11); there is no raw passthrough on the public surface.
 *
 * The raw `BrainDrizzle` handle is obtained legally inside `packages/db` (the ONLY package
 * allowed to, invariant 2) via `createSessionServices` (services.ts) or, in unit tests, a
 * `withBatch(drizzle(sqlite))` constructed directly — exactly like `scoped-write.test.ts`.
 */
import type { Principal } from "@brain/shared"
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  type SQL,
} from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import {
  brainSnapshots,
  facts,
  memoryAudit,
  memoryProvenance,
  pages,
  pageVersions,
  sessions,
  sessionTurns,
} from "../schema"
import type { BrainDrizzle } from "../scoped/db"
import { scopePredicate, visibilityPredicate } from "../scoped/predicates"

/** A runnable Drizzle insert/update statement for atomic batch execution. */
type BatchStatement = BatchItem<"sqlite">

/** `db.batch([...])` — the all-or-nothing atomicity primitive (invariant 11). */
interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** A turn body longer than this is offloaded to R2 (`content` NULL, `r2_offset` set, §8.1). */
export const TURN_INLINE_MAX = 2048

/** The tenant-RELATIVE R2 transcript key for a brain session (`ScopedR2` adds the tenant prefix). */
export const transcriptKey = (brainSessionId: string): string => `sessions/${brainSessionId}.jsonl`

const visibilityCols = {
  visibility: facts.visibility,
  teamId: facts.teamId,
  userId: facts.userId,
} as const

/** `captureTurn` input — `tenantId`/`userId` are NEVER accepted; the store forces them. */
export interface CaptureTurnInput {
  /** The client's own session id — the idempotent-upsert key `(tenant, client, source_session_id)`. */
  sessionId: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  client: string
  scope?: string | null
  teamId?: string | null
  visibility?: string
  title?: string | null
}

/** The result of one `captureTurn` — the (possibly newly-created) brain session id + the turn idx. */
export interface CaptureTurnResult {
  /** The Brain's own session row id (NOT the client `source_session_id`). */
  brainSessionId: string
  /** Ordinal of the appended turn within the session. */
  idx: number
  /** True when this turn's content was offloaded to R2 (exceeded `TURN_INLINE_MAX`). */
  offloaded: boolean
}

/** One promoted fact extracted from a transcript (the writeback input). */
export interface PromotedFact {
  fact: string
  kind: string
  entitySlug?: string | null
  visibility?: string
  notability?: string
  confidence?: number
  scope?: string | null
  teamId?: string | null
}

/** A session row after a tenant-scoped read (the idle-sweep + finalize projection). */
export interface SessionRow {
  id: string
  tenantId: string
  scope: string | null
  teamId: string | null
  userId: string
  status: string
  lastActivityAt: string
}

/** A turn row after a tenant-scoped read (the `get_session_context` recent-turn projection). */
export interface SessionTurnRow {
  idx: number
  role: string
  content: string | null
  r2Offset: string | null
}

/** A fact row after the scoped + visibility-gated recall read. */
export interface RecalledFact {
  id: number
  entitySlug: string | null
  fact: string
  kind: string
  visibility: string
  notability: string
  validFrom: string
  source: string
}

/** Dispatch shape for `recall` (port of gbrain's recall dispatcher, §8.4). */
export interface RecallQuery {
  entitySlug?: string
  /** ISO lower bound on `created_at` (the caller pre-parses "8 hours ago"/"30m"/ISO). */
  since?: string
  sessionId?: string
  /** SQL `LIKE` grep over the `fact` text (newest-first). */
  grep?: string
  limit?: number
}

/** The JSON shape stored in `brain_snapshots.manifest` (§8.5). */
export interface SnapshotManifest {
  pageVersionIds: string[]
}

/** A pinned `page_versions` row resolved from a snapshot manifest (§8.5). */
export interface PinnedPage {
  pageVersionId: string
  pageId: string
  compiledTruth: string
  frontmatter: string
  snapshotAt: string
}

/** A snapshot row after a tenant-scoped read. */
export interface SnapshotRow {
  id: string
  scope: string | null
  label: string
  createdBy: string
  createdAt: string
}

export class SessionStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
  }

  /** Run statements atomically (invariant 11). See `BatchCapable` for the D1/test seam. */
  private async commitBatch(statements: BatchStatement[]): Promise<void> {
    const [first, ...rest] = statements
    if (first === undefined) return
    await (this.db as unknown as BatchCapable).batch([first, ...rest])
  }

  /** Build the `memory_audit` insert with `tenant_id` + actor FORCED from the Principal. */
  private auditStatement(action: string, targetId: string | null, diff?: string): BatchStatement {
    return this.db.insert(memoryAudit).values({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced — never caller-supplied
      userId: this.p.userId, // forced actor
      action,
      targetId,
      at: Date.now(),
      ...(diff !== undefined ? { diff } : {}),
    })
  }

  /** Authorize an EXPLICIT scope on a write; `'*'` may name any scope, else it must be granted. */
  private assertScopeAllowed(scope: string): void {
    if (this.p.allowedScopes === "*") return
    if (!this.p.allowedScopes.includes(scope)) {
      throw new Error(`scope '${scope}' not in this principal's allowedScopes`)
    }
  }

  /**
   * Append a turn (invariant 21). Upserts the `sessions` row keyed on
   * `(tenant_id, client, source_session_id)`, appends a `session_turns` row at
   * `idx = turn_count`, bumps `turn_count`, and **refreshes `last_activity_at = now()` on this
   * same write** — the idle-sweep key, so an actively-capturing session with no Stop-hook is
   * still recoverable once it goes idle. A turn longer than `TURN_INLINE_MAX` is offloaded:
   * `content` is set NULL and `r2_offset` records the slice (the full transcript is in R2). All
   * D1 writes land in ONE `db.batch` (D1 has no cross-await transaction). The R2 transcript
   * append is the caller's responsibility (it holds `ScopedR2`).
   */
  async captureTurn(input: CaptureTurnInput): Promise<CaptureTurnResult> {
    if (this.p.readOnly) throw new Error("capture_turn denied: read-only principal")
    if (input.scope) this.assertScopeAllowed(input.scope)
    if (input.teamId && !this.p.teamIds.includes(input.teamId)) {
      throw new Error(`team '${input.teamId}' not in this principal's teamIds`)
    }
    const now = new Date().toISOString()
    const existing = await this.db
      .select({ id: sessions.id, turnCount: sessions.turnCount })
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, this.p.tenantId),
          eq(sessions.client, input.client),
          eq(sessions.sourceSessionId, input.sessionId),
        ),
      )
      .limit(1)

    const found = existing[0]
    const brainSessionId = found?.id ?? crypto.randomUUID()
    const idx = found?.turnCount ?? 0
    const offloaded = input.content.length > TURN_INLINE_MAX
    const r2Key = transcriptKey(brainSessionId)

    const statements: BatchStatement[] = []
    if (found === undefined) {
      statements.push(
        this.db.insert(sessions).values({
          id: brainSessionId,
          tenantId: this.p.tenantId, // forced
          userId: this.p.userId, // authorship forced
          teamId: input.teamId ?? null,
          scope: input.scope ?? null,
          client: input.client,
          sourceSessionId: input.sessionId,
          title: input.title ?? null,
          startedAt: now,
          lastActivityAt: now,
          status: "open",
          turnCount: 1,
          r2Key,
          createdAt: now,
          updatedAt: now,
        }),
      )
    } else {
      statements.push(
        this.db
          .update(sessions)
          .set({ turnCount: idx + 1, lastActivityAt: now, updatedAt: now })
          .where(and(eq(sessions.id, brainSessionId), eq(sessions.tenantId, this.p.tenantId))),
      )
    }
    statements.push(
      this.db.insert(sessionTurns).values({
        id: crypto.randomUUID(),
        tenantId: this.p.tenantId, // forced
        sessionId: brainSessionId,
        idx,
        role: input.role,
        content: offloaded ? null : input.content,
        r2Offset: offloaded ? `${r2Key}#turn-${idx}` : null,
        tokenCount: Math.ceil(input.content.length / 4),
      }),
    )
    statements.push(this.auditStatement("session.capture", brainSessionId, JSON.stringify({ idx })))
    await this.commitBatch(statements)
    return { brainSessionId, idx, offloaded }
  }

  /**
   * Mark a session `finalizing` and stamp `ended_at` (the explicit-close path). Tenant-scoped
   * WHERE so it can never touch another tenant's session. Audited in-batch.
   */
  async finalizeSession(brainSessionId: string): Promise<void> {
    if (this.p.readOnly) throw new Error("finalize denied: read-only principal")
    const now = new Date().toISOString()
    const update = this.db
      .update(sessions)
      .set({ status: "finalizing", endedAt: now, updatedAt: now })
      .where(and(eq(sessions.id, brainSessionId), eq(sessions.tenantId, this.p.tenantId)))
    await this.commitBatch([update, this.auditStatement("session.finalize", brainSessionId)])
  }

  /** Mark a session `promoted` (the end of `runSessionPromote`). Tenant-scoped, audited. */
  async markPromoted(brainSessionId: string): Promise<void> {
    const now = new Date().toISOString()
    const update = this.db
      .update(sessions)
      .set({ status: "promoted", updatedAt: now })
      .where(and(eq(sessions.id, brainSessionId), eq(sessions.tenantId, this.p.tenantId)))
    await this.commitBatch([update, this.auditStatement("session.promoted", brainSessionId)])
  }

  /**
   * Intra-tenant authorship gate on a SESSION (invariant 8). Sessions carry NO `world` tier — a
   * transcript is private to its author or shared with its team. So a session (and its turns) is
   * reachable only by `user_id = p.userId` OR a team session whose `team_id ∈ p.teamIds`. This is
   * the structural replacement for the per-user enforcement the move to `namespace=tenantId`
   * dissolved: without it, member B could `get_session_context(A's session)` and read A's turns.
   */
  private sessionAuthGate(): SQL {
    const teamClause =
      this.p.teamIds.length > 0
        ? and(isNotNull(sessions.teamId), inArray(sessions.teamId, [...this.p.teamIds]))
        : undefined
    return or(eq(sessions.userId, this.p.userId), teamClause) ?? eq(sessions.userId, this.p.userId)
  }

  /** Read one session row (tenant + authorship gated). Returns null when absent / not the author's. */
  async getSession(brainSessionId: string): Promise<SessionRow | null> {
    const rows = await this.db
      .select({
        id: sessions.id,
        tenantId: sessions.tenantId,
        scope: sessions.scope,
        teamId: sessions.teamId,
        userId: sessions.userId,
        status: sessions.status,
        lastActivityAt: sessions.lastActivityAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, brainSessionId),
          eq(sessions.tenantId, this.p.tenantId),
          this.sessionAuthGate(),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * The most-recent turns of a session, oldest-first (the `get_session_context` projection). JOINs
   * `session_turns` back to `sessions` and ANDs the SAME authorship gate as `getSession` on BOTH
   * tenant ids — so a non-author / non-teammate in the same tenant reads NO turns (drop-don't-error,
   * invariant 8). `session_turns` carries no authorship of its own; the parent session is the gate.
   */
  async recentTurns(brainSessionId: string, limit = 50): Promise<SessionTurnRow[]> {
    return this.db
      .select({
        idx: sessionTurns.idx,
        role: sessionTurns.role,
        content: sessionTurns.content,
        r2Offset: sessionTurns.r2Offset,
      })
      .from(sessionTurns)
      .innerJoin(
        sessions,
        and(eq(sessions.id, sessionTurns.sessionId), eq(sessions.tenantId, sessionTurns.tenantId)),
      )
      .where(
        and(
          eq(sessionTurns.tenantId, this.p.tenantId),
          eq(sessionTurns.sessionId, brainSessionId),
          this.sessionAuthGate(),
        ),
      )
      .orderBy(asc(sessionTurns.idx))
      .limit(limit)
  }

  // ── HOT-MEMORY WRITEBACK (the promote clean-replace, §8.3 / invariant 21) ─────────
  // Re-finalize is a CLEAN REPLACE, never an append: soft-expire the prior promoted set for
  // this `source_session_id` (preserving lineage, not hard-deleting) in the SAME batch as the
  // fresh inserts, so the swap is atomic. Agent writeback hard-wires `trust_grade='evidence'`
  // (invariant 9): there is NO instruction-writing path here, and `trust_grade` COALESCEs to
  // 'evidence' when no `memory_use_policy` row exists — so a promoted fact is NEVER instruction
  // regardless of the sidecar. The autoincrement `facts.id` is unknown until insert, so the
  // sidecars (provenance) reference ids re-SELECTed AFTER the atomic clean-replace batch.

  /** Build one `facts` INSERT with `tenant_id`/`user_id`/`source` FORCED (`trust_grade` is implicit evidence). */
  private factInsert(f: PromotedFact, sessionId: string): BatchStatement {
    return this.db.insert(facts).values({
      tenantId: this.p.tenantId, // forced
      scope: f.scope ?? null,
      teamId: f.teamId ?? null,
      userId: this.p.userId, // authorship forced
      entitySlug: f.entitySlug ?? null,
      fact: f.fact,
      kind: f.kind,
      visibility: f.visibility ?? "private",
      notability: f.notability ?? "medium",
      confidence: f.confidence ?? 1.0,
      source: "session:promote",
      sourceSessionId: sessionId,
    })
  }

  /**
   * The clean-replace promotion (invariant 21). ONE `db.batch`:
   *   [ soft-expire prior promoted set by source_session_id, ...insert fresh facts, audit ]
   * then re-SELECT the new ids and write a `memory_provenance(agent_inferred)` row per fact in a
   * second batch (the autoincrement id is unknowable inside the first batch). Returns the new ids.
   * Caller dedupes `facts` before passing them in.
   */
  async replacePromotedFacts(sessionId: string, promoted: PromotedFact[]): Promise<number[]> {
    if (this.p.readOnly) throw new Error("promote denied: read-only principal")
    const now = new Date().toISOString()
    const expire = this.db
      .update(facts)
      .set({ expiredAt: now })
      .where(
        and(
          eq(facts.tenantId, this.p.tenantId),
          eq(facts.sourceSessionId, sessionId),
          isNull(facts.expiredAt),
        ),
      )
    const inserts = promoted.map((f) => this.factInsert(f, sessionId))
    const audit = this.auditStatement(
      "fact.promote",
      sessionId,
      JSON.stringify({ count: promoted.length }),
    )
    await this.commitBatch([expire, ...inserts, audit])

    if (promoted.length === 0) return []
    const fresh = await this.db
      .select({ id: facts.id })
      .from(facts)
      .where(
        and(
          eq(facts.tenantId, this.p.tenantId),
          eq(facts.sourceSessionId, sessionId),
          isNull(facts.expiredAt),
        ),
      )
      .orderBy(asc(facts.id))
    const ids = fresh.map((row) => row.id)
    if (ids.length > 0) {
      const provenance = ids.map((id) =>
        this.db.insert(memoryProvenance).values({
          id: crypto.randomUUID(),
          tenantId: this.p.tenantId, // forced
          targetId: String(id),
          origin: "agent_inferred",
          sessionId,
          capturedAt: now,
        }),
      )
      await this.commitBatch(provenance)
    }
    return ids
  }

  /**
   * Soft-expire a single fact (`forget_fact`, §8.4). The WHERE carries `tenant_id` AND an
   * authorship gate (`user_id = p.userId` OR a team fact whose `team_id ∈ p.teamIds`) — so a
   * non-author / non-teammate cannot soft-expire another user's fact: the UPDATE simply matches
   * nothing (a no-op, drop-don't-error), exactly like `updateChunkEmbedding` cross-tenant. Audited
   * in-batch (the audit row records the attempt regardless; the change lands only if the gate matched).
   */
  async forgetFact(factId: number): Promise<void> {
    if (this.p.readOnly) throw new Error("forget_fact denied: read-only principal")
    const teamClause =
      this.p.teamIds.length > 0
        ? and(isNotNull(facts.teamId), inArray(facts.teamId, [...this.p.teamIds]))
        : undefined
    const ownership =
      or(eq(facts.userId, this.p.userId), teamClause) ?? eq(facts.userId, this.p.userId)
    const update = this.db
      .update(facts)
      .set({ expiredAt: new Date().toISOString() })
      .where(and(eq(facts.id, factId), eq(facts.tenantId, this.p.tenantId), ownership))
    await this.commitBatch([update, this.auditStatement("fact.forget", String(factId))])
  }

  // ── HOT-MEMORY RECALL (§8.4) — every read ANDs the SHARED visibility predicate ───────

  /** The projection shared by every recall dispatch. */
  private recallSelect() {
    return this.db
      .select({
        id: facts.id,
        entitySlug: facts.entitySlug,
        fact: facts.fact,
        kind: facts.kind,
        visibility: facts.visibility,
        notability: facts.notability,
        validFrom: facts.validFrom,
        source: facts.source,
      })
      .from(facts)
  }

  /**
   * Recall hot memory (§8.4). Dispatch by entity / since / session / grep, newest-first. The
   * base WHERE ALWAYS carries `tenant_id` + the SHARED `scopePredicate` + `visibilityPredicate`
   * + live (`expired_at IS NULL`) — so user B never recalls user A's `private` fact and the
   * `team` tier is enforced (invariant 8). Keyword recall (FTS) routes through
   * `ScopedDB.ftsFactIds` + `hydrateFacts` instead (it owns the `facts_fts` JOIN-back).
   */
  async recall(query: RecallQuery): Promise<RecalledFact[]> {
    const where = and(
      eq(facts.tenantId, this.p.tenantId),
      isNull(facts.expiredAt),
      scopePredicate(this.p, facts.scope),
      visibilityPredicate(this.p, visibilityCols),
      query.entitySlug ? eq(facts.entitySlug, query.entitySlug) : undefined,
      query.sessionId ? eq(facts.sourceSessionId, query.sessionId) : undefined,
      query.since ? gte(facts.createdAt, query.since) : undefined,
      query.grep ? like(facts.fact, `%${query.grep}%`) : undefined,
    )
    return this.recallSelect()
      .where(where)
      .orderBy(desc(facts.createdAt))
      .limit(query.limit ?? 50)
  }

  /**
   * Hydrate a set of fact ids (from `ScopedDB.ftsFactIds`) back to scoped+visible rows. The
   * SAME `tenant_id` + `scopePredicate` + `visibilityPredicate` re-check the FTS already applied
   * runs again here — defense-in-depth, drop-don't-error (an out-of-visibility id is absent).
   */
  async hydrateFacts(ids: number[]): Promise<RecalledFact[]> {
    if (ids.length === 0) return []
    return this.recallSelect()
      .where(
        and(
          eq(facts.tenantId, this.p.tenantId),
          inArray(facts.id, ids),
          isNull(facts.expiredAt),
          scopePredicate(this.p, facts.scope),
          visibilityPredicate(this.p, visibilityCols),
        ),
      )
      .orderBy(desc(facts.createdAt))
  }

  // ── FROZEN-SNAPSHOT INJECTION (§8.5) ─────────────────────────────────────────────

  /**
   * Pin the current page versions into a `brain_snapshots` row (§8.5). For each live page in the
   * tenant (optionally filtered by `scope`, soft-deleted pages excluded), inserts a `page_versions`
   * row capturing the current `compiled_truth` + `frontmatter`, stores their ids in the manifest
   * JSON, and inserts the snapshot row + audit in ONE `db.batch`. Returns the new snapshot id.
   *
   * The page_version ids are pre-generated (crypto.randomUUID()) so the manifest can reference
   * them before the batch commits — no second query needed. Cross-tenant isolation: `tenant_id`
   * is FORCED on every inserted row, never caller-supplied.
   */
  async createSnapshot(label: string, scope?: string | null): Promise<string> {
    if (this.p.readOnly) throw new Error("create_snapshot denied: read-only principal")
    if (scope) this.assertScopeAllowed(scope)
    const now = new Date().toISOString()
    const snapshotId = crypto.randomUUID()

    // 1. Read all live (non-deleted) pages for this tenant, optionally scoped.
    const pageWhere =
      scope != null
        ? and(eq(pages.tenantId, this.p.tenantId), eq(pages.scope, scope), isNull(pages.deletedAt))
        : and(eq(pages.tenantId, this.p.tenantId), isNull(pages.deletedAt))

    const livePages = await this.db
      .select({ id: pages.id, compiledTruth: pages.compiledTruth, frontmatter: pages.frontmatter })
      .from(pages)
      .where(pageWhere)

    // 2. Pre-generate page_versions ids so the manifest can reference them before the batch.
    const pvRows = livePages.map((pg) => ({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced
      pageId: pg.id,
      compiledTruth: pg.compiledTruth,
      frontmatter: pg.frontmatter,
      snapshotAt: now,
    }))

    const manifest: SnapshotManifest = { pageVersionIds: pvRows.map((pv) => pv.id) }

    // 3. One batch: [page_versions inserts..., brain_snapshots insert, audit].
    const statements: BatchStatement[] = pvRows.map((pv) => this.db.insert(pageVersions).values(pv))
    statements.push(
      this.db.insert(brainSnapshots).values({
        id: snapshotId,
        tenantId: this.p.tenantId, // forced
        scope: scope ?? null,
        label,
        createdBy: this.p.userId, // authorship forced
        createdAt: now,
        manifest: JSON.stringify(manifest),
      }),
    )
    statements.push(
      this.auditStatement(
        "snapshot.create",
        snapshotId,
        JSON.stringify({ pageCount: pvRows.length }),
      ),
    )
    await this.commitBatch(statements)
    return snapshotId
  }

  /**
   * Resolve a snapshot's pinned `page_versions` (§8.5). The `brain_snapshots` lookup is
   * tenant-scoped: a cross-tenant `snapshotId` returns `null` (drop-don't-error — no existence
   * leak). The `page_versions` hydration re-checks `tenant_id` as defense-in-depth. Returns `null`
   * when the snapshot is not found; returns `[]` when the manifest is empty or malformed.
   */
  async resolveSnapshot(snapshotId: string): Promise<PinnedPage[] | null> {
    const rows = await this.db
      .select({ manifest: brainSnapshots.manifest })
      .from(brainSnapshots)
      .where(and(eq(brainSnapshots.id, snapshotId), eq(brainSnapshots.tenantId, this.p.tenantId)))
      .limit(1)

    const snap = rows[0]
    if (snap === undefined) return null // cross-tenant or not found

    let parsed: unknown
    try {
      parsed = JSON.parse(snap.manifest)
    } catch {
      return [] // malformed manifest → empty, not fatal
    }

    const m = parsed as SnapshotManifest
    const ids = Array.isArray(m?.pageVersionIds) ? m.pageVersionIds : []
    if (ids.length === 0) return []

    const pinned = await this.db
      .select({
        id: pageVersions.id,
        pageId: pageVersions.pageId,
        compiledTruth: pageVersions.compiledTruth,
        frontmatter: pageVersions.frontmatter,
        snapshotAt: pageVersions.snapshotAt,
      })
      .from(pageVersions)
      .where(
        and(
          eq(pageVersions.tenantId, this.p.tenantId), // re-check tenant (defense-in-depth)
          inArray(pageVersions.id, ids),
        ),
      )

    return pinned.map((pv) => ({
      pageVersionId: pv.id,
      pageId: pv.pageId,
      compiledTruth: pv.compiledTruth,
      frontmatter: pv.frontmatter,
      snapshotAt: pv.snapshotAt,
    }))
  }

  /** List snapshots for the tenant, newest-first (read op, §8.5). */
  async listSnapshots(limit = 50): Promise<SnapshotRow[]> {
    return this.db
      .select({
        id: brainSnapshots.id,
        scope: brainSnapshots.scope,
        label: brainSnapshots.label,
        createdBy: brainSnapshots.createdBy,
        createdAt: brainSnapshots.createdAt,
      })
      .from(brainSnapshots)
      .where(eq(brainSnapshots.tenantId, this.p.tenantId))
      .orderBy(desc(brainSnapshots.createdAt))
      .limit(limit)
  }
}

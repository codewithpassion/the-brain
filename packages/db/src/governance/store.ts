/**
 * `GovernanceStore` — the trust-promotion, break-glass, and audit-export surfaces (PRD §7.5/§7.6).
 *
 * Like `SessionStore`, this COMPOSES the frozen `ScopedDB` primitives where they suffice
 * (`ScopedDB.breakGlass` for chunks, `ScopedDB.upsertMemoryPolicy` semantics) and, for the
 * net-new governance tables (`memory_review`) and fact break-glass, mirrors the SAME discipline:
 * `tenant_id` forced, the SHARED `scopePredicate` on reads, and the change + its `memory_audit`
 * row in one `db.batch` (invariant 10/11).
 *
 * The keystone (invariant 9): promotion to `trust_grade='instruction'` flows ONLY through
 * `memoryReview` — a human-confirmed `memory_review` row gates it. Agent writeback never reaches
 * here. LOCKED authority decision: a `member` MAY promote a fact within their own `allowedScopes`;
 * `owner`/`admin` promote anywhere; `readonly` never. A target outside the member's grant (or a
 * tenant-global / null-scope target a restricted member cannot reach) is rejected `403`-style.
 */
import type { Principal } from "@brain/shared"
import { and, eq, gt, isNull, sql } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { facts, memoryAudit, memoryReview, memoryUsePolicy } from "../schema"
import type { BrainDrizzle, BreakGlassAudit } from "../scoped/db"
import { scopePredicate } from "../scoped/predicates"

type BatchStatement = BatchItem<"sqlite">

interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** A promoted-private fact returned by a break-glass read (the audited exception, §7.6). */
export interface BreakGlassFact {
  id: number
  fact: string
  visibility: string
  userId: string | null
}

/** One append-only audit row, the unit `auditExport` serializes to R2 ndjson (§7.6 SC7). */
export interface AuditRow {
  id: string
  tenantId: string
  userId: string
  action: string
  targetId: string | null
  at: number
  diff: string | null
}

/** The result of one audit export sweep. */
export interface AuditExportResult {
  /** Tenant-RELATIVE R2 key the ndjson landed at (never rewritten). */
  r2Key: string | null
  exported: number
  /** The max `at` exported — the caller persists it as the next sweep's cursor. */
  cursor: number
}

export class GovernanceStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal
  private readonly audit: BreakGlassAudit | undefined

  constructor(db: BrainDrizzle, principal: Principal, audit?: BreakGlassAudit) {
    this.db = db
    this.p = principal
    this.audit = audit
  }

  private async commitBatch(statements: BatchStatement[]): Promise<void> {
    const [first, ...rest] = statements
    if (first === undefined) return
    await (this.db as unknown as BatchCapable).batch([first, ...rest])
  }

  private auditStatement(action: string, targetId: string | null, diff?: string): BatchStatement {
    return this.db.insert(memoryAudit).values({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced
      userId: this.p.userId, // forced actor
      action,
      targetId,
      at: Date.now(),
      ...(diff !== undefined ? { diff } : {}),
    })
  }

  /**
   * Promote a fact to `trust_grade='instruction'` (the ONLY path, invariant 9). Enforces the
   * LOCKED authority rule, then writes — in ONE `db.batch` — the `memory_review(confirmed)` row,
   * a clean-replace of the `memory_use_policy(instruction)` sidecar (tenant-scoped DELETE + new
   * INSERT), and the `usePolicy.promote` audit row. Atomic: all land or none do.
   */
  async memoryReview(
    factId: number,
    review: { status?: "confirmed" | "rejected" | "needs_revision"; note?: string },
  ): Promise<void> {
    if (this.p.readOnly) throw new Error("review denied: read-only principal")
    const targetId = String(factId)
    // Read the target's scope (tenant-scoped) to evaluate the member-in-scope authority rule.
    const rows = await this.db
      .select({ scope: facts.scope })
      .from(facts)
      .where(and(eq(facts.id, factId), eq(facts.tenantId, this.p.tenantId)))
      .limit(1)
    const target = rows[0]
    if (target === undefined) throw new Error("review denied: target fact not found in tenant")
    this.assertMayPromote(target.scope)

    const status = review.status ?? "confirmed"
    const now = new Date().toISOString()
    const reviewRow = this.db.insert(memoryReview).values({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced
      targetId,
      status,
      reviewer: this.p.userId, // forced — the human confirming
      reviewedAt: now,
      ...(review.note !== undefined ? { note: review.note } : {}),
    })
    // Only a CONFIRMED review promotes; reject/needs_revision records the review without promoting.
    if (status !== "confirmed") {
      await this.commitBatch([reviewRow, this.auditStatement("usePolicy.review", targetId)])
      return
    }
    const removePolicy = this.db
      .delete(memoryUsePolicy)
      .where(
        and(eq(memoryUsePolicy.tenantId, this.p.tenantId), eq(memoryUsePolicy.targetId, targetId)),
      )
    const insertPolicy = this.db.insert(memoryUsePolicy).values({
      id: crypto.randomUUID(),
      tenantId: this.p.tenantId, // forced
      targetId,
      trustGrade: "instruction",
      scopes: JSON.stringify(target.scope === null ? [] : [target.scope]),
    })
    await this.commitBatch([
      reviewRow,
      removePolicy,
      insertPolicy,
      this.auditStatement("usePolicy.promote", targetId),
    ])
  }

  /**
   * The LOCKED authority gate. owner/admin promote anywhere; a `member` may promote ONLY a fact
   * whose scope is within its own `allowedScopes` — a tenant-global (null-scope) target or an
   * out-of-grant scope is beyond a restricted member's reach. readonly never reaches here.
   */
  private assertMayPromote(targetScope: string | null): void {
    if (this.p.role === "owner" || this.p.role === "admin") return
    if (this.p.role !== "member") {
      throw new Error("promotion denied: requires member, admin, or owner role")
    }
    if (this.p.allowedScopes === "*") return // an unrestricted member moves freely
    if (targetScope === null) {
      throw new Error("promotion denied: a restricted member cannot promote a tenant-global fact")
    }
    if (!this.p.allowedScopes.includes(targetScope)) {
      throw new Error(`promotion denied: scope '${targetScope}' not in this member's allowedScopes`)
    }
  }

  // ── BREAK-GLASS (the audited exception to visibility, §7.6) ───────────────────────
  // Four gates, all enforced: (a) role-gated owner/admin only; (b) fails CLOSED for non-admins
  // AND when no audit sink is configured (no unaudited path); (c) every read writes a distinct
  // audit row + fires the alert via the injected sink; (d) NEVER bypasses tenant_id — it only
  // drops the visibility arm. Chunks route through the frozen `ScopedDB.breakGlass`; fact
  // break-glass is mirrored HERE through the SAME injected `BreakGlassAudit` sink.

  /**
   * Break-glass read of `facts` across the visibility tier. Mirrors `ScopedDB.breakGlass`'s gates
   * exactly: non-owner/admin → throws (fail-closed); missing audit sink → throws; the audit+alert
   * sink fires BEFORE the read. NEVER bypasses `tenant_id` or `scopePredicate` — only the
   * visibility arm is dropped, so other users' `private`/`team` facts are returned.
   */
  async breakGlassFacts(factIds: number[], reason: string): Promise<BreakGlassFact[]> {
    if (this.p.role !== "owner" && this.p.role !== "admin") {
      throw new Error("break-glass denied: requires owner or admin role")
    }
    if (!this.audit) {
      throw new Error("break-glass denied: no audit sink configured")
    }
    await this.audit({
      tenantId: this.p.tenantId,
      actorUserId: this.p.userId,
      actorRole: this.p.role,
      targetIds: factIds.map(String),
      reason,
    })
    if (factIds.length === 0) return []
    return this.db
      .select({
        id: facts.id,
        fact: facts.fact,
        visibility: facts.visibility,
        userId: facts.userId,
      })
      .from(facts)
      .where(
        and(
          eq(facts.tenantId, this.p.tenantId), // hard boundary NEVER bypassed
          isNull(facts.expiredAt),
          scopePredicate(this.p, facts.scope), // scope gate still applies
          sql`${facts.id} IN (${sql.join(
            factIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
          // NOTE: NO visibilityPredicate — that is the deliberate break-glass bypass.
        ),
      )
  }

  // ── AUDIT EXPORT (append-only memory_audit → R2 ndjson, §7.6 SC7) ─────────────────

  /**
   * Read new `memory_audit` rows since a cursor (owner/admin only — the audit log is privileged).
   * Tenant-scoped; ordered by `at` ascending so the export is append-ordered and the returned
   * cursor is monotonic.
   */
  async readAuditSince(cursor: number, limit = 1000): Promise<AuditRow[]> {
    if (this.p.role !== "owner" && this.p.role !== "admin") {
      throw new Error("audit read denied: requires owner or admin role")
    }
    return this.db
      .select({
        id: memoryAudit.id,
        tenantId: memoryAudit.tenantId,
        userId: memoryAudit.userId,
        action: memoryAudit.action,
        targetId: memoryAudit.targetId,
        at: memoryAudit.at,
        diff: memoryAudit.diff,
      })
      .from(memoryAudit)
      .where(and(eq(memoryAudit.tenantId, this.p.tenantId), gt(memoryAudit.at, cursor)))
      .orderBy(memoryAudit.at)
      .limit(limit)
  }
}

/**
 * `ReembedStore` — tenant-scoped re-embed candidate selection + content read (PRD §8.7).
 *
 * The re-embed migration upgrades any chunk whose vector is stale, wrong-model, or foreign-
 * dimension to bge-m3 1024d against the SAME vector id (invariant 12: foreign-dimension vectors
 * are RE-EMBEDDED, never copied). A chunk is a candidate when:
 *   `embedding_model != EMBEDDING_MODEL` (wrong model, incl. importer `'pending'`)
 *   OR `embedded_at IS NULL`            (never embedded)
 *   OR `updated_at > embedded_at`       (content changed since last embed — staleness)
 *   OR `embedding_dims != EMBEDDING_DIMS` (foreign dimension)
 * …and `deleted_at IS NULL`.
 *
 * CRITICAL (invariant 12 coverage): these reads are VISIBILITY-AGNOSTIC. The migration must re-
 * embed EVERY stale chunk in the tenant — `private` and `team` included — so it deliberately does
 * NOT route through `ScopedDB.getChunksByIds` (whose `visibilityPredicate` would silently drop a
 * chunk the system principal can't see, leaving it to rot un-re-embedded). Raw `tenant_id`-scoped
 * access is legal here: `packages/db` is the ONLY package allowed to touch `chunks` directly
 * (invariant 2). `tenant_id` is still FORCED on every read — a candidate can never cross tenants.
 */
import type { Principal } from "@brain/shared"
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "@brain/shared"
import { and, eq, gt, isNull, ne, or } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { chunks } from "../schema"
import type { BrainDrizzle } from "../scoped/db"

type BatchStatement = BatchItem<"sqlite">

/** `db.batch([...])` — the all-or-nothing atomicity primitive (invariant 11). */
interface BatchCapable {
  batch(statements: [BatchStatement, ...BatchStatement[]]): Promise<unknown>
}

/** A re-embed candidate — id (the SAME Vectorize id to re-upsert) + the metadata the upsert needs. */
export interface ReembedCandidate {
  id: string
  content: string
  scope: string | null
  teamId: string | null
  visibility: string
  embeddingModel: string
  embeddingDims: number
}

export class ReembedStore {
  private readonly db: BrainDrizzle
  private readonly p: Principal

  constructor(db: BrainDrizzle, principal: Principal) {
    this.db = db
    this.p = principal
  }

  /** The stale/wrong-model/foreign-dim predicate (visibility-agnostic; `deleted_at IS NULL`). */
  private staleWhere() {
    return and(
      eq(chunks.tenantId, this.p.tenantId), // forced — never crosses tenants
      isNull(chunks.deletedAt),
      or(
        ne(chunks.embeddingModel, EMBEDDING_MODEL),
        isNull(chunks.embeddedAt),
        gt(chunks.updatedAt, chunks.embeddedAt),
        ne(chunks.embeddingDims, EMBEDDING_DIMS),
      ),
    )
  }

  private projection() {
    return {
      id: chunks.id,
      content: chunks.content,
      scope: chunks.scope,
      teamId: chunks.teamId,
      visibility: chunks.visibility,
      embeddingModel: chunks.embeddingModel,
      embeddingDims: chunks.embeddingDims,
    }
  }

  /** Select up to `limit` stale candidates in the tenant (visibility-agnostic — invariant 12). */
  async findCandidates(limit = 50): Promise<ReembedCandidate[]> {
    return this.db.select(this.projection()).from(chunks).where(this.staleWhere()).limit(limit)
  }

  /**
   * Read ONE candidate by id for the consumer's re-embed (visibility-agnostic). Returns `null`
   * when the chunk is absent, soft-deleted, owned by another tenant, OR no longer stale (a
   * concurrent re-embed already upgraded it — the re-delivery no-op).
   */
  async getCandidate(chunkId: string): Promise<ReembedCandidate | null> {
    const rows = await this.db
      .select(this.projection())
      .from(chunks)
      .where(and(eq(chunks.id, chunkId), this.staleWhere()))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Re-stamp a chunk AFTER its vector was re-upserted: set `embedding_model`/`embedding_dims` to
   * the locked bge-m3 1024d AND `embedded_at = now`, clearing `embed_error`. Critically it restamps
   * `embedding_dims` (which the frozen `ScopedDB.updateChunkEmbedding` does NOT) — a foreign-
   * dimension row stays a candidate until its dims are corrected, so without this the migration
   * would re-embed the same chunk forever (the idempotency break). Tenant-scoped WHERE so it can
   * never touch another tenant's chunk. Ops mechanic — the audit trail is the migration
   * `backfill_run` + the `token_spend` row, not a per-chunk `memory_audit` entry.
   */
  async markReembedded(chunkId: string, embeddedAt: string): Promise<void> {
    const update = this.db
      .update(chunks)
      .set({
        embeddingModel: EMBEDDING_MODEL,
        embeddingDims: EMBEDDING_DIMS,
        embeddedAt,
        embedError: null,
      })
      .where(and(eq(chunks.id, chunkId), eq(chunks.tenantId, this.p.tenantId)))
    await (this.db as unknown as BatchCapable).batch([update])
  }
}

/**
 * The injected break-glass audit sink (PRD §7.6). A break-glass read of another user's private
 * content is the ONE audited exception to visibility — so the sink durably records the exception
 * BEFORE the read runs (`ScopedDB.breakGlass` / `GovernanceStore.breakGlassFacts` fire it first;
 * if it throws, the read aborts → fail-closed). This writes one append-only `memory_audit` row
 * per invocation. The raw `env.DB` access lives HERE in `packages/db` (invariant 2 / boundary-lint)
 * — the orchestrator may not name a raw binding; it injects this sink into `createSessionServices`.
 */
import { drizzle } from "drizzle-orm/d1"
import type { BrainBindings } from "../env"
import { memoryAudit } from "../schema"
import type { BreakGlassAudit } from "../scoped/db"

/** Build the durable break-glass audit sink (writes one `memory_audit` row per break-glass read). */
export const createBreakGlassAuditSink =
  (env: BrainBindings): BreakGlassAudit =>
  async (event) => {
    await drizzle(env.DB)
      .insert(memoryAudit)
      .values({
        id: crypto.randomUUID(),
        tenantId: event.tenantId, // the actor's tenant — never bypassed
        userId: event.actorUserId, // the admin/owner who broke glass
        action: "breakGlass.read",
        targetId: event.targetIds.length > 0 ? event.targetIds.join(",") : null,
        at: Date.now(),
        diff: JSON.stringify({
          reason: event.reason,
          actorRole: event.actorRole,
          targetIds: event.targetIds,
        }),
      })
  }

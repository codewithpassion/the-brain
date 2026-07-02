/**
 * The shared `memory_review.note` contract for Dream contradictions (v2 W1) — the SINGLE source
 * imported by BOTH the writer (`dream/apply.ts`) and the reader (`governance/store.ts`), so the
 * two cannot drift on the JSON shape. The `kind:'contradiction'` discriminator lets the reader
 * skip human-promotion review rows (which carry no such note).
 */
import { z } from "zod"

/** How a contradiction was resolved (appended to the note by `resolveContradiction`). */
export const ContradictionResolution = z.object({
  resolvedBy: z.string(),
  action: z.enum(["keep", "dismiss"]),
  keptFactId: z.number().int().nullable(),
  expiredFactIds: z.array(z.number().int()),
  resolvedAt: z.string(),
})
export type ContradictionResolution = z.infer<typeof ContradictionResolution>

/** The `memory_review.note` payload for a Dream-filed contradiction. */
export const ContradictionNote = z.object({
  kind: z.literal("contradiction"),
  factIds: z.array(z.number().int()),
  rationale: z.string().default(""),
  originalAction: z.string().optional(),
  downgraded: z.boolean().optional(),
  resolution: ContradictionResolution.optional(),
})
export type ContradictionNote = z.infer<typeof ContradictionNote>

/** Parse a raw `note` string into a validated contradiction note, or `null` (skip non-matching). */
export const parseContradictionNote = (raw: string | null): ContradictionNote | null => {
  if (raw === null) return null
  try {
    const parsed = ContradictionNote.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

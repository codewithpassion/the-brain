/**
 * Build the `wiki_save_page` payload from editor state, enforcing the VISIBILITY-PRESERVE invariant
 * (W1/W4b): `visibility` is included ONLY when the user explicitly changed it. Omitting it means an
 * EDIT keeps the page's current tier and a NEW page takes the op's safe default (private) — so the
 * editor can never silently escalate a private page to world by shipping a defaulted dropdown value.
 * Pure + unit-tested (`test/save-payload.test.ts`) because it's the easiest isolation rule to regress.
 */
export interface WikiEditState {
  slug: string
  type: string
  body: string
  title: string
  tags: string[]
  draft: boolean
  /** True only after the user interacts with the visibility control this session. */
  visibilityTouched: boolean
  /** The chosen tier; consulted ONLY when `visibilityTouched`. */
  visibility: string
}

export interface WikiSavePayload {
  slug: string
  type: string
  body: string
  title: string
  tags: string[]
  draft: boolean
  visibility?: string
}

export const buildWikiSavePayload = (state: WikiEditState): WikiSavePayload => {
  const payload: WikiSavePayload = {
    slug: state.slug.trim(),
    type: state.type.trim() || "note",
    body: state.body,
    title: state.title.trim(),
    tags: state.tags.map((t) => t.trim()).filter((t) => t.length > 0),
    draft: state.draft,
  }
  // ONLY send visibility when the user explicitly touched it — otherwise omit (preserve tier).
  if (state.visibilityTouched && state.visibility.length > 0) {
    payload.visibility = state.visibility
  }
  return payload
}

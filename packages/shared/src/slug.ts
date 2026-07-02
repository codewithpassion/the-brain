/**
 * Deterministic slugify — lowercase, non-alphanumerics collapsed to `-`, trimmed, capped at 48
 * chars. One shared home so the KG/entity slug, the org slug, and the Dream insight slug cannot
 * drift. Falls back to `fallback` when the input reduces to empty.
 */
export const slugify = (name: string, fallback = "item"): string => {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return s.length > 0 ? s : fallback
}

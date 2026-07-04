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

/**
 * The canonical entity-page slug for an entity (D5: `entities/<kind>/<slugified name>`). One shared
 * home so the store's minting, the dashboard's @mention/[[link]] autocomplete, and Cmd+K cannot drift.
 */
export const entityPageSlug = (kind: string, canonicalName: string): string =>
  `entities/${slugify(kind, "kind")}/${slugify(canonicalName, "entity")}`

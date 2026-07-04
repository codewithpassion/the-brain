/**
 * Golden fixtures for `normalizeLinkTarget` — the wikilink-slug rule. Imported by BOTH the store's
 * parity test (`packages/db/test/wikilink-parity.test.ts`, pinning `@brain/db`'s implementation) and
 * the dashboard's test (`apps/dashboard/test/wikilink.test.ts`, pinning the client PORT). A store-side
 * change forces updating these cases, which then fails the dashboard test until the port is synced —
 * so the two normalizers cannot silently drift (W4a fix round, item 4).
 */
export interface WikilinkSlugFixture {
  input: string
  slug: string | null
}

export const WIKILINK_SLUG_FIXTURES: readonly WikilinkSlugFixture[] = [
  { input: "algorithm", slug: "algorithm" },
  { input: "tables/customers", slug: "tables/customers" },
  { input: "Charles Babbage|Babbage", slug: "Charles Babbage" },
  { input: "a/b|Label", slug: "a/b" },
  { input: "guide#section", slug: "guide" },
  { input: "/tables/customers", slug: "tables/customers" },
  { input: "./y", slug: "y" },
  { input: "./y.md", slug: "y" },
  { input: "/tables/customers.MD", slug: "tables/customers" },
  { input: "ticket:1234", slug: "ticket:1234" }, // colon slug: NOT a scheme (no `//`) → a real slug
  { input: "https://example.com", slug: null },
  { input: "HTTP://Example.com", slug: null },
  { input: "mailto:a@b.com", slug: null },
  { input: "", slug: null },
  { input: "   ", slug: null },
  { input: "#section", slug: null },
  { input: "/path/x.md#frag|Label", slug: "path/x" },
]

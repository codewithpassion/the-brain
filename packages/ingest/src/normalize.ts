/**
 * Input text normalization (PRD §4).
 *
 * Two DIFFERENT normalizations live in this package and must never be
 * cross-wired:
 *
 *   - `normalize(raw)` (here) is the *gentle* normalization applied to text
 *     bodies before they are treated as markdown: it fixes line endings, BOM,
 *     and trailing/edge whitespace while PRESERVING case and inline spacing.
 *     It is what `toMarkdown` runs on `text/plain` / `text/markdown` bodies.
 *
 *   - `normalizeForFingerprint(text)` (in `fingerprint.ts`) is the *aggressive*
 *     formatting-insensitive normalization (collapse all whitespace, lowercase)
 *     used ONLY to compute the dedup fingerprint, so whitespace/case drift on a
 *     re-capture still dedups (§4.0 / §4.2). It must never be used as the stored
 *     body — it would destroy the document.
 *
 * `normalize` is deterministic and idempotent: `normalize(normalize(x))` equals
 * `normalize(x)`.
 */

/** Strip a leading UTF-8 BOM if present. */
const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/**
 * Normalize a raw text body for use as markdown (§4.3 text/plain + text/markdown
 * path): BOM-strip, CRLF/CR → LF, drop per-line trailing whitespace, collapse 3+
 * blank lines to a single blank line, and trim leading/trailing whitespace.
 */
export const normalize = (raw: string): string =>
  stripBom(raw)
    .replace(/\r\n?/g, "\n") // CRLF / lone CR → LF
    .replace(/[ \t]+$/gm, "") // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim() // leading/trailing whitespace

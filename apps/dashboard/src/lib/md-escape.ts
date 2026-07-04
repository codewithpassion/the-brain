/**
 * `@tiptap/markdown` escapes `[`/`]` in text output (so `[[slug]]` becomes `\[\[slug\]\]`), which
 * breaks wikilink round-trip AND the store's `\[\[…\]\]` extraction regex. Restore double-bracket
 * wikilinks after `getMarkdown()`. Single escaped brackets (a genuine literal `\[`) are left intact,
 * so ordinary markdown links `[text](url)` are unaffected. Verified against the real editor.
 *
 * Code is left VERBATIM: inside fenced blocks / inline spans, `@tiptap/markdown` emits content
 * unescaped, so a literal `\[\[` there is the user's own bytes (e.g. a regex `/\[\[/`) — un-escaping
 * it would silently corrupt their code. We split on code delimiters and only repair the prose.
 */
const unescapeSegment = (s: string): string =>
  s.replace(/\\\[\\\[/g, "[[").replace(/\\\]\\\]/g, "]]")

export const unescapeWikilinks = (md: string): string =>
  md
    // Capturing split keeps the delimiters: odd-indexed parts are fenced blocks / inline code.
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : unescapeSegment(seg)))
    .join("")

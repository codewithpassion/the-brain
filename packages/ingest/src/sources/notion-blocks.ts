/**
 * Notion block → Markdown converter (docs/notion-integration-plan.md §4) — the one genuinely new
 * piece of work for the Notion integration. Pure + deterministic (no I/O), so it is exhaustively
 * golden-file tested. The Notion API client fetches the block tree (paginated, recursive) and
 * attaches each block's `children`; this converter renders a fully-materialised tree to Markdown.
 *
 * Fidelity scope (v1, per plan §4):
 *   - Straightforward: headings, paragraphs, bulleted / numbered / to-do lists, quotes, code
 *     (with language), dividers, callouts (→ blockquote), toggles (→ bold line + nested body).
 *   - Structural: nested blocks (recurse children), tables (→ Markdown tables), child pages
 *     (→ link; the importer ingests the child as its own doc).
 *   - Lossy / links-only: images / files / embeds / bookmarks / video (keep URL + caption).
 *   - Unknown types: render their `rich_text` if present, else skip (never throw).
 */

// ── Notion API shapes (minimal; only what the converter reads) ──────────────────────────────────

export interface NotionAnnotations {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  code?: boolean
}

export interface NotionRichText {
  plain_text?: string
  annotations?: NotionAnnotations
  href?: string | null
}

/** A Notion block. The per-type payload lives under `block[block.type]`; children are pre-fetched. */
export interface NotionBlock {
  id?: string
  type: string
  has_children?: boolean
  children?: NotionBlock[]
  // The per-type payload (e.g. `paragraph`, `heading_1`, `code`, `table`, ...). Untyped by design:
  // the converter reads `rich_text`, `language`, `checked`, `caption`, `cells`, etc. defensively.
  [key: string]: unknown
}

// ── Rich text ────────────────────────────────────────────────────────────────────────────────────

const asRichText = (value: unknown): NotionRichText[] =>
  Array.isArray(value) ? (value as NotionRichText[]) : []

/** Render one rich-text run with its annotations + link. */
const renderRun = (run: NotionRichText): string => {
  let text = run.plain_text ?? ""
  if (text.length === 0) return ""
  const ann = run.annotations ?? {}
  if (ann.code) text = `\`${text}\``
  if (ann.bold) text = `**${text}**`
  if (ann.italic) text = `_${text}_`
  if (ann.strikethrough) text = `~~${text}~~`
  if (run.href) text = `[${text}](${run.href})`
  return text
}

/** Concatenate a rich-text array into an inline Markdown string. */
export const richTextToMarkdown = (rt: unknown): string => asRichText(rt).map(renderRun).join("")

// ── Block payload helpers ────────────────────────────────────────────────────────────────────────

const payload = (block: NotionBlock): Record<string, unknown> => {
  const p = block[block.type]
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {}
}

const blockText = (block: NotionBlock): string => richTextToMarkdown(payload(block).rich_text)

const indentLines = (text: string, indent: string): string =>
  text
    .split("\n")
    .map((line) => (line.length > 0 ? indent + line : line))
    .join("\n")

// ── Table rendering ────────────────────────────────────────────────────────────────────────────

const renderTable = (block: NotionBlock): string => {
  const rows = (block.children ?? []).filter((c) => c.type === "table_row")
  if (rows.length === 0) return ""
  const cellRows = rows.map((row) => {
    const cells = payload(row).cells
    const cellArr = Array.isArray(cells) ? (cells as unknown[]) : []
    return cellArr.map((cell) => richTextToMarkdown(cell).replace(/\|/g, "\\|") || " ")
  })
  const header = cellRows[0] ?? []
  const width = cellRows.reduce((max, r) => Math.max(max, r.length), 0)
  const pad = (r: string[]): string[] => {
    const out = [...r]
    while (out.length < width) out.push(" ")
    return out
  }
  const lines: string[] = []
  lines.push(`| ${pad(header).join(" | ")} |`)
  lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`)
  for (const r of cellRows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`)
  return lines.join("\n")
}

// ── Core renderer ──────────────────────────────────────────────────────────────────────────────

/** Render a materialised block tree to Markdown. `blocks` are siblings; children are pre-fetched. */
export const blocksToMarkdown = (blocks: readonly NotionBlock[]): string => {
  const parts: string[] = []
  let numberedCounter = 0

  for (const block of blocks) {
    // A run of numbered_list_item blocks must number sequentially; reset on any other block.
    if (block.type !== "numbered_list_item") numberedCounter = 0

    switch (block.type) {
      case "heading_1":
        parts.push(`# ${blockText(block)}`)
        break
      case "heading_2":
        parts.push(`## ${blockText(block)}`)
        break
      case "heading_3":
        parts.push(`### ${blockText(block)}`)
        break
      case "paragraph": {
        const text = blockText(block)
        const child = block.children ? blocksToMarkdown(block.children) : ""
        parts.push([text, child].filter((s) => s.length > 0).join("\n\n"))
        break
      }
      case "bulleted_list_item":
      case "numbered_list_item": {
        let marker = "-"
        if (block.type === "numbered_list_item") {
          numberedCounter += 1
          marker = `${numberedCounter}.`
        }
        const child = block.children ? indentLines(blocksToMarkdown(block.children), "  ") : ""
        parts.push([`${marker} ${blockText(block)}`, child].filter((s) => s.length > 0).join("\n"))
        break
      }
      case "to_do": {
        const checked = payload(block).checked === true
        const child = block.children ? indentLines(blocksToMarkdown(block.children), "  ") : ""
        parts.push(
          [`- [${checked ? "x" : " "}] ${blockText(block)}`, child]
            .filter((s) => s.length > 0)
            .join("\n"),
        )
        break
      }
      case "quote": {
        const body = [blockText(block), block.children ? blocksToMarkdown(block.children) : ""]
          .filter((s) => s.length > 0)
          .join("\n\n")
        parts.push(indentLines(body, "> "))
        break
      }
      case "callout": {
        // Callouts map to a blockquote (plan §4); prepend the icon emoji when present.
        const icon = payload(block).icon
        const emoji =
          typeof icon === "object" &&
          icon !== null &&
          typeof (icon as { emoji?: string }).emoji === "string"
            ? `${(icon as { emoji: string }).emoji} `
            : ""
        const body = [
          `${emoji}${blockText(block)}`,
          block.children ? blocksToMarkdown(block.children) : "",
        ]
          .filter((s) => s.length > 0)
          .join("\n\n")
        parts.push(indentLines(body, "> "))
        break
      }
      case "toggle": {
        // Toggles map to a bold summary line + the nested body (plan §4).
        const child = block.children ? blocksToMarkdown(block.children) : ""
        parts.push([`**${blockText(block)}**`, child].filter((s) => s.length > 0).join("\n\n"))
        break
      }
      case "code": {
        const lang = typeof payload(block).language === "string" ? payload(block).language : ""
        parts.push(`\`\`\`${lang}\n${blockText(block)}\n\`\`\``)
        break
      }
      case "divider":
        parts.push("---")
        break
      case "child_page": {
        // Link-only; the importer ingests the child page as its own doc.
        const title = typeof payload(block).title === "string" ? payload(block).title : "Untitled"
        parts.push(`[${title}](notion://${block.id ?? ""})`)
        break
      }
      case "child_database": {
        const title =
          typeof payload(block).title === "string" ? payload(block).title : "Untitled database"
        parts.push(`[${title}](notion://${block.id ?? ""})`)
        break
      }
      case "table":
        parts.push(renderTable(block))
        break
      case "image":
      case "file":
      case "video":
      case "pdf":
      case "embed":
      case "bookmark": {
        const p = payload(block)
        const ext = p.external as { url?: string } | undefined
        const file = p.file as { url?: string } | undefined
        const url = ext?.url ?? file?.url ?? (typeof p.url === "string" ? p.url : "")
        const caption = richTextToMarkdown(p.caption)
        const label = caption.length > 0 ? caption : block.type
        parts.push(url.length > 0 ? `[${label}](${url})` : label)
        break
      }
      case "table_row":
        // Rendered by the parent `table`; skip standalone.
        break
      default: {
        // Unknown / unsupported: render its rich_text if any, plus children; else skip.
        const text = blockText(block)
        const child = block.children ? blocksToMarkdown(block.children) : ""
        const merged = [text, child].filter((s) => s.length > 0).join("\n\n")
        if (merged.length > 0) parts.push(merged)
      }
    }
  }

  return parts.filter((s) => s.length > 0).join("\n\n")
}

// ── Page property helpers (title + tags) ─────────────────────────────────────────────────────────

type NotionProperty = Record<string, unknown> & { type?: string }

/** Extract the page title from its properties (the one `title`-typed property). */
export const pageTitle = (properties: Record<string, unknown> | undefined): string => {
  if (!properties) return ""
  for (const prop of Object.values(properties)) {
    const p = prop as NotionProperty
    if (p.type === "title") return richTextToMarkdown(p.title)
  }
  return ""
}

/** Collect tag-like property values (select / multi_select / status) from a page's properties. */
export const extractPageTags = (properties: Record<string, unknown> | undefined): string[] => {
  if (!properties) return []
  const tags: string[] = []
  for (const prop of Object.values(properties)) {
    const p = prop as NotionProperty
    if (p.type === "select") {
      const sel = p.select as { name?: string } | null
      if (sel?.name) tags.push(sel.name)
    } else if (p.type === "status") {
      const st = p.status as { name?: string } | null
      if (st?.name) tags.push(st.name)
    } else if (p.type === "multi_select") {
      const ms = Array.isArray(p.multi_select) ? (p.multi_select as { name?: string }[]) : []
      for (const opt of ms) if (opt?.name) tags.push(opt.name)
    }
  }
  return tags
}

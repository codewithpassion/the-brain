/**
 * Output rendering — the SINGLE sink every command writes through. Two modes:
 *   - `--json`  → pretty raw JSON (for piping / scripting).
 *   - default   → a compact, human "table-ish" view (key/value for objects, rows for arrays).
 *
 * It never serialises credentials: command results are server data (no tokens), and the only
 * credential-bearing view (`brain whoami`) hands this printer an ALREADY-redacted object
 * (`redactProfile`). Errors print `message` only — never a request/Authorization dump (invariant 17).
 */

export interface Printer {
  print: (value: unknown) => void
  error: (message: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

const renderObject = (record: Record<string, unknown>): string => {
  const keys = Object.keys(record)
  if (keys.length === 0) return "(empty)"
  const width = Math.max(...keys.map((key) => key.length))
  return keys.map((key) => `${key.padEnd(width)}  ${scalar(record[key])}`).join("\n")
}

const renderArray = (rows: readonly unknown[]): string => {
  if (rows.length === 0) return "(no results)"
  return rows
    .map((row, index) =>
      isRecord(row)
        ? `${index + 1}.\n${indent(renderObject(row))}`
        : `${index + 1}. ${scalar(row)}`,
    )
    .join("\n")
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")

/** Render any value to the human "table-ish" form. */
export const renderHuman = (value: unknown): string => {
  if (Array.isArray(value)) return renderArray(value)
  if (isRecord(value)) {
    // A single `{ hits: [...] }` / `{ facts: [...] }` wrapper renders as its inner rows.
    const keys = Object.keys(value)
    if (keys.length === 1) {
      const onlyKey = keys[0] as string
      const inner = value[onlyKey]
      if (Array.isArray(inner)) return `${onlyKey}:\n${indent(renderArray(inner))}`
    }
    return renderObject(value)
  }
  return scalar(value)
}

/** Build the printer bound to a `--json` flag and a pair of sinks (defaults to stdout/stderr). */
export const createPrinter = (
  json: boolean,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  err: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Printer => ({
  print: (value) => out(json ? JSON.stringify(value, null, 2) : renderHuman(value)),
  error: (message) => err(json ? JSON.stringify({ error: message }, null, 2) : `error: ${message}`),
})

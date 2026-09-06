/**
 * Map raw Commander option values → a typed op input, then validate it against the SAME Zod schema
 * the server uses (PRD §9.0.2 "cannot drift"). Commander hands every value back as a string (or a
 * string[] for variadic, `true` for a flag), but the ops use `z.number().int()` / booleans with NO
 * coercion — so a `--topK 12` must become the NUMBER `12` before it crosses the wire, or the
 * server's `.parse()` rejects it. Absent optionals are OMITTED (not set to `undefined`) so Zod
 * defaults apply and `exactOptionalPropertyTypes` stays satisfied (mirrors catalog.ts).
 */
import type { CliArgSpec } from "@brain/surface"
import type { z } from "zod"

/** Coerce one raw Commander value to the JSON-Schema primitive the op expects. */
export const coerceArg = (arg: CliArgSpec, raw: unknown): unknown => {
  switch (arg.type) {
    case "number":
    case "integer": {
      const value = Number(raw)
      if (Number.isNaN(value))
        throw new Error(`--${arg.name} must be a number (got "${String(raw)}")`)
      return value
    }
    case "boolean":
      return raw === true || raw === "true"
    case "array": {
      const parts = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
      // Object items (apply_corrections --changes, replace_in_document --replacements) travel as
      // one JSON object per value: `--replacements '{"find":"a","replaceWith":"b"}' '{...}'`.
      if (arg.itemType !== "object") return parts
      return parts.map((part) => {
        if (typeof part !== "string") return part
        try {
          return JSON.parse(part) as unknown
        } catch {
          throw new Error(
            `--${arg.name}: each value must be a JSON object (got "${part.slice(0, 60)}")`,
          )
        }
      })
    }
    default:
      return raw
  }
}

/** Build the raw input object from coerced option values, omitting any absent optional. */
export const buildRawInput = (
  args: readonly CliArgSpec[],
  opts: Record<string, unknown>,
): Record<string, unknown> => {
  const input: Record<string, unknown> = {}
  for (const arg of args) {
    const value = opts[arg.name]
    if (value === undefined) continue
    input[arg.name] = coerceArg(arg, value)
  }
  return input
}

/** Validate the coerced input against the op's Zod schema (client-side parity), returning the parsed value. */
export const validateInput = (schema: z.ZodTypeAny, raw: Record<string, unknown>): unknown => {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
      .join("; ")
    throw new Error(`invalid input — ${detail}`)
  }
  return result.data
}

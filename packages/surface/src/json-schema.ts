/**
 * Zod-input → JSON Schema (one source for the MCP `inputSchema` + the CLI arg specs).
 *
 * zod 3.25's runtime `z.toJSONSchema` is a v4 API absent from the classic v3 build this repo
 * imports (`import { z } from "zod"`), and `zod-to-json-schema` is not a workspace dependency. The
 * op inputs are a small, closed set of constructs — `z.object` of string / number(.int/.min/.max) /
 * boolean / enum / array / optional / default / union / literal — so a focused, dependency-free
 * walker is the robust choice. It introspects zod v3 `_def` (the stable internal shape) and emits
 * draft-07-style JSON Schema (object with `properties` + `required`), which is what MCP clients and
 * the CLI flag generator consume.
 */
import type { ZodTypeAny } from "zod"

export interface JsonSchema {
  type?: string
  description?: string
  enum?: unknown[]
  const?: unknown
  default?: unknown
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  anyOf?: JsonSchema[]
  minimum?: number
  maximum?: number
  minLength?: number
}

interface ZodDefShape {
  typeName: string
  checks?: { kind: string; value?: number }[]
  values?: readonly string[]
  type?: ZodTypeAny
  innerType?: ZodTypeAny
  options?: readonly ZodTypeAny[]
  value?: unknown
  defaultValue?: () => unknown
  description?: string
}

const defOf = (schema: ZodTypeAny): ZodDefShape => (schema as unknown as { _def: ZodDefShape })._def

/** Strip the outer `ZodOptional`/`ZodDefault` wrappers; report whether the field is required. */
const unwrap = (
  schema: ZodTypeAny,
): { inner: ZodTypeAny; required: boolean; default?: unknown } => {
  const def = defOf(schema)
  if (def.typeName === "ZodOptional" && def.innerType !== undefined) {
    return { ...unwrap(def.innerType), required: false }
  }
  if (def.typeName === "ZodDefault" && def.innerType !== undefined) {
    const fallback = def.defaultValue?.()
    return { inner: unwrap(def.innerType).inner, required: false, default: fallback }
  }
  return { inner: schema, required: true }
}

const stringSchema = (def: ZodDefShape): JsonSchema => {
  const min = def.checks?.find((check) => check.kind === "min")?.value
  return { type: "string", ...(min !== undefined ? { minLength: min } : {}) }
}

const numberSchema = (def: ZodDefShape): JsonSchema => {
  const isInt = def.checks?.some((check) => check.kind === "int") ?? false
  const min = def.checks?.find((check) => check.kind === "min")?.value
  const max = def.checks?.find((check) => check.kind === "max")?.value
  return {
    type: isInt ? "integer" : "number",
    ...(min !== undefined ? { minimum: min } : {}),
    ...(max !== undefined ? { maximum: max } : {}),
  }
}

const convert = (schema: ZodTypeAny): JsonSchema => {
  const def = defOf(schema)
  switch (def.typeName) {
    case "ZodString":
      return stringSchema(def)
    case "ZodNumber":
      return numberSchema(def)
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodEnum":
      return { type: "string", enum: [...(def.values ?? [])] }
    case "ZodArray":
      return { type: "array", items: def.type !== undefined ? convert(def.type) : {} }
    case "ZodLiteral":
      return { const: def.value }
    case "ZodUnion":
      return { anyOf: (def.options ?? []).map((option) => convert(option)) }
    case "ZodOptional":
    case "ZodDefault":
      return def.innerType !== undefined ? convert(def.innerType) : {}
    case "ZodObject":
      return objectSchema(schema)
    default:
      return {}
  }
}

const objectSchema = (schema: ZodTypeAny): JsonSchema => {
  const shapeFn = (schema as unknown as { _def: { shape: () => Record<string, ZodTypeAny> } })._def
    .shape
  const shape = shapeFn()
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(shape)) {
    const { inner, required: isRequired, default: fallback } = unwrap(field)
    const prop = convert(inner)
    const description = defOf(field).description ?? defOf(inner).description
    properties[key] = {
      ...prop,
      ...(fallback !== undefined ? { default: fallback } : {}),
      ...(description !== undefined ? { description } : {}),
    }
    if (isRequired) required.push(key)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

/** Convert a Zod schema to a JSON Schema object (draft-07-compatible). */
export const toJsonSchema = (schema: ZodTypeAny): Record<string, unknown> =>
  convert(schema) as Record<string, unknown>

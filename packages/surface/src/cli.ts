/**
 * `buildCliCommandSpecs` — project the catalog into DECLARATIVE command specs (PRD §9.3). Pure
 * data: NO Commander dependency lives here; the `brain` CLI (a tRPC client) turns each spec into a
 * Commander command + flag set, validating input against the SAME Zod schema before the tRPC call.
 * Only ops whose `surfaces` include `"cli"` are emitted (and "cli" ⊆ "rest", so every CLI command
 * has a tRPC procedure to call — asserted by the drift test).
 *
 * Args are derived from the op's Zod input via its JSON Schema, so a new flag is a schema edit,
 * never a hand-synced CLI change.
 */
import type { AnyOpDef, Capability, OpSurface } from "@brain/shared"
import { buildCatalog, type SurfaceOp } from "./catalog"
import { toJsonSchema } from "./json-schema"

/** One CLI argument/flag derived from a property of the op's Zod input. */
export interface CliArgSpec {
  name: string
  /** JSON-Schema primitive type (`string`|`number`|`integer`|`boolean`|`array`|`object`). */
  type: string
  required: boolean
  description: string
  default?: unknown
  /** Allowed values when the property is an enum. */
  enumValues?: string[]
}

/** One declarative CLI command generated from an `OpDef`. */
export interface CliCommandSpec {
  name: string
  description: string
  capability: Capability
  readOnly: boolean
  surfaces: readonly OpSurface[]
  args: CliArgSpec[]
}

interface JsonSchemaObject {
  properties?: Record<string, Record<string, unknown>>
  required?: string[]
}

const argFrom = (name: string, prop: Record<string, unknown>, required: boolean): CliArgSpec => {
  const type = typeof prop.type === "string" ? prop.type : "string"
  const description = typeof prop.description === "string" ? prop.description : ""
  return {
    name,
    type,
    required,
    description,
    ...(prop.default !== undefined ? { default: prop.default } : {}),
    ...(Array.isArray(prop.enum) ? { enumValues: prop.enum.map((value) => String(value)) } : {}),
  }
}

const toCommandSpec = (def: AnyOpDef): CliCommandSpec => {
  const schema = toJsonSchema(def.input) as JsonSchemaObject
  const required = new Set(schema.required ?? [])
  const args = Object.entries(schema.properties ?? {}).map(([name, prop]) =>
    argFrom(name, prop, required.has(name)),
  )
  return {
    name: def.name,
    description: def.description,
    capability: def.capability,
    readOnly: def.readOnly,
    surfaces: def.surfaces,
    args,
  }
}

/** Build the declarative CLI command specs for every `"cli"`-surface op in the catalog. */
export const buildCliCommandSpecs = (
  catalog: readonly SurfaceOp[] = buildCatalog(),
): CliCommandSpec[] =>
  catalog.filter((op) => op.def.surfaces.includes("cli")).map((op) => toCommandSpec(op.def))

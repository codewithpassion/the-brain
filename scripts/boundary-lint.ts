/**
 * boundary-lint — the security backstop that enforces invariant 2 (PRD §7.3 / top risk
 * "Security, PRD-lowest 71/100"): raw Cloudflare bindings (D1 / Vectorize / R2 / KV / AI)
 * may be named ONLY inside `packages/db`. Every other module reaches tenant data through
 * the `Scoped*` chokepoints + the `embed()/gen()/rerank()` wrappers, so a forgotten
 * tenant_id / namespace / re-check is impossible by construction.
 *
 * This is a deliberately SIMPLE line/regex scanner, not an AST/type-aware analyzer: it is a
 * cheap, un-foolable backstop that runs on every `bun check`. The raw-type-name rule
 * (`D1Database`/`Vectorize`/`R2Bucket`) is a token heuristic — it flags the identifiers
 * appearing anywhere outside `packages/db`, which is exactly where a leaked binding type
 * would first show up. It is paired with its own RED-proof test (`boundary-lint.test.ts`):
 * a lint that only ever passes is a no-op.
 *
 * SCOPE: scans the `apps` and `packages` trees. EXCLUDES (documented):
 *   - the `packages/db` subtree — the ONE sanctioned home of raw bindings (invariant 2).
 *   - any `test` directory + any `.test.ts` file — test SEEDING legitimately uses
 *                                 `env.DB` / `.prepare(` to set up fixtures (e.g.
 *                                 apps/api/test/isolation.canary.test.ts); the rule targets
 *                                 PRODUCTION handler code, not test scaffolding.
 *   - any `.d.ts` file         — generated ambient types (e.g. the 533KB
 *                                 apps/api/worker-configuration.d.ts) DECLARE the binding
 *                                 types; declaring is not using.
 *   - `node_modules`, `.turbo`, `dist`, `.wrangler`, `test-fixtures` — build/vendor noise.
 *
 * Exits NONZERO with `file:line:col [rule]` for every hit; prints `clean` and exits 0 otherwise.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

export interface Violation {
  file: string
  line: number
  col: number
  rule: string
  text: string
}

interface Rule {
  rule: string
  re: RegExp
}

/**
 * The forbidden-token rules. Word boundaries keep `env.DB` from matching `env.DEVICE_FLOW_SECRET`
 * and `env.AI` from matching `env.AI_GATEWAY_ID` (the `_` is a word char, so `\bAI\b` stops there).
 */
export const RULES: Rule[] = [
  { rule: "raw env.DB", re: /\benv\.DB\b/ },
  { rule: "raw env.BODIES", re: /\benv\.BODIES\b/ },
  { rule: "raw env.OAUTH_KV", re: /\benv\.OAUTH_KV\b/ },
  { rule: "raw env.AI", re: /\benv\.AI\b/ },
  { rule: "raw Vectorize binding", re: /\benv\.(?:CHUNK_INDEX|ENTITY_INDEX|VECTORIZE\w*)\b/ },
  { rule: "raw D1 .prepare()", re: /\.prepare\(/ },
  { rule: "raw drizzle(env.*)", re: /\bdrizzle\(\s*env\./ },
  // Destructure-from-env bypass: `const { CHUNK_INDEX } = env` then `CHUNK_INDEX.query(...)`
  // would dodge the `env.X` rules. The `= env` anchor keeps this from matching unrelated
  // destructures. (DB is also covered by the standalone `.prepare(` rule.)
  {
    rule: "raw binding destructured from env",
    re: /\{[^{}]*\b(?:DB|BODIES|OAUTH_KV|CHUNK_INDEX|ENTITY_INDEX|AI)\b[^{}]*\}\s*=\s*env\b/,
  },
  { rule: "raw binding type", re: /\b(?:D1Database|Vectorize|R2Bucket)\b/ },
]

const ROOTS = ["apps", "packages"]
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".turbo",
  "dist",
  ".wrangler",
  "test",
  "test-fixtures",
])
/** `packages/db` is the ONE module allowed to name raw bindings (invariant 2). */
const EXCLUDED_PREFIXES = [join("packages", "db")]

const isScannable = (relPath: string): boolean => {
  if (relPath.endsWith(".d.ts")) return false
  if (relPath.endsWith(".test.ts")) return false
  if (!(relPath.endsWith(".ts") || relPath.endsWith(".tsx") || relPath.endsWith(".js"))) {
    return false
  }
  const normalized = relPath.split(/[\\/]/).join("/")
  for (const prefix of EXCLUDED_PREFIXES) {
    if (normalized.startsWith(`${prefix.split(/[\\/]/).join("/")}/`)) return false
  }
  return true
}

/**
 * Blank out line/block comments and single/double-quoted string literals (replacing their
 * chars with spaces, newlines preserved so line/column numbers stay exact). Prose that
 * merely MENTIONS a binding type — e.g. a `/** … Vectorize … *␣/` doc comment — is not a
 * violation; only real code is. Template literals are deliberately left intact so an
 * interpolated `${env.DB…}` is still caught.
 */
export const stripCommentsAndStrings = (text: string): string => {
  const chars = [...text]
  type State = "code" | "line" | "block" | "single" | "double"
  let state: State = "code"
  const out: string[] = []
  const blank = (ch: string): string => (ch === "\n" ? "\n" : " ")
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? ""
    const next = chars[i + 1] ?? ""
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line"
        out.push(" ", " ")
        i++
      } else if (ch === "/" && next === "*") {
        state = "block"
        out.push(" ", " ")
        i++
      } else if (ch === "'") {
        state = "single"
        out.push(" ")
      } else if (ch === '"') {
        state = "double"
        out.push(" ")
      } else {
        out.push(ch)
      }
    } else if (state === "line") {
      if (ch === "\n") state = "code"
      out.push(blank(ch))
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code"
        out.push(" ", " ")
        i++
      } else {
        out.push(blank(ch))
      }
    } else if (state === "single") {
      if (ch === "\\") {
        out.push(" ", " ")
        i++
      } else {
        if (ch === "'") state = "code"
        out.push(blank(ch))
      }
    } else {
      if (ch === "\\") {
        out.push(" ", " ")
        i++
      } else {
        if (ch === '"') state = "code"
        out.push(blank(ch))
      }
    }
  }
  return out.join("")
}

/** Scan a single file's text. Pure — the unit the RED-proof test drives with a fixture. */
export const scanText = (file: string, text: string): Violation[] => {
  const out: Violation[] = []
  const original = text.split("\n")
  const stripped = stripCommentsAndStrings(text).split("\n")
  for (let i = 0; i < stripped.length; i++) {
    const codeLine = stripped[i] ?? ""
    for (const { rule, re } of RULES) {
      const match = re.exec(codeLine)
      if (match) {
        out.push({
          file,
          line: i + 1,
          col: match.index + 1,
          rule,
          text: (original[i] ?? "").trim(),
        })
      }
    }
  }
  return out
}

/** Recursively scan a root directory (relative to `cwd`), honoring the exclusion rules. */
export const scanTree = (root: string, cwd: string = process.cwd()): Violation[] => {
  const out: Violation[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(join(cwd, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        const normalized = rel.split(/[\\/]/).join("/")
        if (EXCLUDED_PREFIXES.some((p) => normalized === p.split(/[\\/]/).join("/"))) continue
        walk(rel)
      } else if (entry.isFile() && isScannable(rel)) {
        out.push(...scanText(rel, readFileSync(join(cwd, rel), "utf8")))
      }
    }
  }
  walk(root)
  return out
}

export const scanRepo = (cwd: string = process.cwd()): Violation[] =>
  ROOTS.flatMap((root) => scanTree(root, cwd))

if (import.meta.main) {
  const violations = scanRepo()
  if (violations.length > 0) {
    for (const v of violations) {
      const rel = relative(process.cwd(), v.file) || v.file
      console.error(`${rel}:${v.line}:${v.col} [${v.rule}] ${v.text}`)
    }
    console.error(
      `\nboundary-lint: ${violations.length} raw-binding violation(s) outside packages/db (invariant 2)`,
    )
    process.exit(1)
  }
  console.log("boundary-lint: clean — no raw bindings outside packages/db (invariant 2)")
}

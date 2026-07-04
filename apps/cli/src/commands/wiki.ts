/**
 * `brain wiki import <path>` — the ergonomic OKF-bundle import wrapper (v3/W5 fast-follow). The
 * GENERATED `wiki_import_bundle` command can't accept an array of file OBJECTS through Commander
 * flags, so this hand-written command reads the bundle CLIENT-SIDE (a `.okf.zip` OR a directory of
 * markdown) and calls the op with the parsed files. The untrusted-ingress posture is enforced
 * SERVER-SIDE (private+draft floor, `imported/<namespace>/…` confinement, caps) — this only marshals
 * files, so it adds no trust surface.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { Command } from "commander"
import { strFromU8, unzipSync } from "fflate"
import type { CliDeps } from "../deps"
import { addGlobalFlags } from "../flags"
import { createPrinter } from "../render"
import { resolveSession } from "../session"

interface OkfFile {
  path: string
  content: string
}

const MD_EXT = /\.(md|markdown)$/i

/** Recursively collect markdown files under a directory, keyed by their path relative to the root. */
const readDir = (root: string): OkfFile[] => {
  const out: OkfFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (MD_EXT.test(entry.name))
        out.push({ path: relative(root, full), content: readFileSync(full, "utf8") })
    }
  }
  walk(root)
  return out
}

/** Unzip a `.okf.zip` into its file entries (directory entries dropped; the op skips non-markdown). */
const readZip = (file: string): OkfFile[] =>
  Object.entries(unzipSync(new Uint8Array(readFileSync(file))))
    .filter(([name]) => !name.endsWith("/"))
    .map(([name, data]) => ({ path: name, content: strFromU8(data) }))

/** Read a bundle from a `.zip` file or a directory of markdown into OKF `{path,content}` files. */
const readBundle = (path: string): OkfFile[] => {
  const st = statSync(path) // throws a clear ENOENT if the path is missing
  if (st.isDirectory()) return readDir(path)
  if (/\.zip$/i.test(path)) return readZip(path)
  throw new Error(`expected a .zip bundle or a directory of markdown, got: ${path}`)
}

/** Register `brain wiki import <path>` (hand-written; not an op-registry command). */
export const registerWikiCommands = (program: Command, deps: CliDeps): void => {
  const wiki = program.command("wiki").description("Wiki bundle tools").helpGroup("wiki commands")
  addGlobalFlags(
    wiki
      .command("import <path>")
      .description("Import an OKF bundle (.okf.zip or a directory of markdown) into the wiki")
      .requiredOption(
        "--namespace <ns>",
        "confinement namespace — pages land under 'imported/<namespace>/…' as private drafts",
      ),
  ).action(async (path: string, _options: unknown, self: Command) => {
    const globals = self.optsWithGlobals()
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    try {
      const files = readBundle(path)
      if (files.length === 0) throw new Error(`no markdown files found in ${path}`)
      const session = resolveSession(deps.loadConfig(), globals, deps.env, deps.deviceDeps)
      const client = deps.createClient(session)
      printer.print(
        await client.call("wiki_import_bundle", false, { files, namespace: globals.namespace }),
      )
    } catch (error) {
      printer.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
}

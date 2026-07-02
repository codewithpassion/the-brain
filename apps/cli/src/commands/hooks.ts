/**
 * The Claude Code hook kit (v2 W2.3) — hand-written CLI commands (no op-registry entry) that wire a
 * repo's Claude sessions to the Brain:
 *
 *   - `brain context --snapshot`  print the tenant's current session-context snapshot markdown to
 *                                 stdout (raw, for a SessionStart hook to inject). Uses existing auth.
 *   - `brain capture`             read a turn from `--content` (or stdin) and `capture_turn` it — for
 *                                 a Stop hook. `--session` is the client session id; `--role` default 'user'.
 *   - `brain hooks install`       merge a SessionStart hook (`brain context --snapshot`) and a Stop
 *                                 hook (`brain capture`) into `<repo>/.claude/settings.json`, PRESERVING
 *                                 every existing key/hook; `--dry-run` prints the resulting JSON instead.
 *
 * The settings merge is deliberately a PURE function (`mergeClaudeSettings`) so it is unit-tested in
 * isolation — a clobber of a user's real settings is the failure mode we most want to prevent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Command } from "commander"
import type { CliDeps } from "../deps"
import { addGlobalFlags } from "../flags"
import { createPrinter } from "../render"
import type { GlobalFlags } from "../session"
import { resolveSession } from "../session"

/** One Claude hook entry we install. */
interface HookSpec {
  event: "SessionStart" | "Stop"
  command: string
}

/** The two hooks the kit installs. The Stop hook records the ASSISTANT reply (role attributed). */
const HOOKS: HookSpec[] = [
  { event: "SessionStart", command: "brain context --snapshot" },
  { event: "Stop", command: "brain capture --role assistant" },
]

type Json = Record<string, unknown>
interface HookInvocation {
  type: "command"
  command: string
}
interface HookMatcherGroup {
  hooks?: HookInvocation[]
  [k: string]: unknown
}

/**
 * PURE merge: return a NEW settings object with our hook commands ensured under `hooks[event]`,
 * preserving every existing top-level key, every existing event, and every existing hook entry.
 * A hook whose command is already present is NOT duplicated (idempotent re-install).
 */
export const mergeClaudeSettings = (existing: Json, hooks: HookSpec[] = HOOKS): Json => {
  const existingHooks = (existing.hooks ?? {}) as Record<string, HookMatcherGroup[]>
  const nextHooks: Record<string, HookMatcherGroup[]> = { ...existingHooks }
  for (const { event, command } of hooks) {
    const groups = Array.isArray(nextHooks[event]) ? [...nextHooks[event]] : []
    const already = groups.some((g) =>
      (g.hooks ?? []).some((h) => h.type === "command" && h.command === command),
    )
    if (!already) groups.push({ hooks: [{ type: "command", command }] })
    nextHooks[event] = groups
  }
  return { ...existing, hooks: nextHooks }
}

/** The fields we pull from a Claude Code Stop-hook stdin envelope (tolerant; all optional). */
export interface HookEnvelope {
  sessionId?: string
  transcriptPath?: string
  /** True when stdin WAS a hook envelope (has `hook_event_name`/`session_id`) — gates the no-op. */
  isEnvelope: boolean
}

/**
 * PURE parse of a Claude Code hook's stdin. A Stop/SessionStart hook delivers a JSON envelope —
 * documented fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`,
 * `effort`, `hook_event_name`, `stop_reason` (there is NO turn-text field). So `brain capture`
 * (a Stop hook invoked with a STATIC command string) takes its session id + transcript path here,
 * then reads the turn from the transcript. Tolerant: non-JSON → not an envelope (manual-pipe path).
 */
export const parseHookEnvelope = (stdin: string): HookEnvelope => {
  try {
    const p = JSON.parse(stdin) as Record<string, unknown>
    if (!p || typeof p !== "object") return { isEnvelope: false }
    return {
      isEnvelope: typeof p.hook_event_name === "string" || typeof p.session_id === "string",
      ...(typeof p.session_id === "string" ? { sessionId: p.session_id } : {}),
      ...(typeof p.transcript_path === "string" ? { transcriptPath: p.transcript_path } : {}),
    }
  } catch {
    return { isEnvelope: false }
  }
}

/**
 * PURE decision for `brain capture`'s content+role (returns null = NO-OP, store nothing). Precedence:
 * explicit `--content` → the transcript turn → (a hook envelope with NO extractable turn → NO-OP, so
 * we never store the envelope JSON as a turn) → raw stdin (a genuine non-envelope manual pipe).
 */
export const resolveCapture = (params: {
  explicitContent?: string
  explicitRole: string
  turn: TranscriptTurn | null
  isEnvelope: boolean
  raw: string
}): { content: string; role: string } | null => {
  if (params.explicitContent?.trim())
    return { content: params.explicitContent, role: params.explicitRole }
  if (params.turn?.content.trim()) return { content: params.turn.content, role: params.turn.role }
  if (params.isEnvelope) return null // hook envelope, no turn → no-op (never capture the envelope JSON)
  if (params.raw.trim()) return { content: params.raw, role: params.explicitRole } // manual pipe
  return null
}

/** Read stdin without blocking on a TTY (a Stop hook pipes JSON; an interactive run has no pipe). */
const readStdin = (): string => {
  if (process.stdin.isTTY) return ""
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

/** A parsed transcript turn (role attributed). */
export interface TranscriptTurn {
  role: "user" | "assistant"
  content: string
}

/** Flatten a transcript `content` (a string, or an array of `{type:'text',text}` blocks) to text. */
const textOf = (c: unknown): string => {
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("")
  }
  return ""
}

/**
 * PURE parse of ONE transcript JSONL line. The format is documented as version-unstable, so we
 * tolerate BOTH plausible shapes: `{type:'user_message'|'assistant_message', content}` AND
 * `{type:'user'|'assistant', message:{content}}` (content a string OR `{type:'text',text}[]`).
 * Returns null for any other/unparseable line (→ the caller keeps scanning, then falls back).
 */
export const parseTranscriptLine = (line: string): TranscriptTurn | null => {
  try {
    const o = JSON.parse(line) as { type?: unknown; content?: unknown; message?: unknown }
    const type = typeof o.type === "string" ? o.type : ""
    const role: TranscriptTurn["role"] | null =
      type === "user" || type === "user_message"
        ? "user"
        : type === "assistant" || type === "assistant_message"
          ? "assistant"
          : null
    if (role === null) return null
    const rawContent =
      o.content !== undefined
        ? o.content
        : o.message && typeof o.message === "object"
          ? (o.message as { content?: unknown }).content
          : undefined
    const content = textOf(rawContent).trim()
    return content ? { role, content } : null
  } catch {
    return null
  }
}

/** Best-effort: the LAST turn (role + text) from a transcript JSONL (any failure → null). */
const lastTurnFromTranscript = (path: string): TranscriptTurn | null => {
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const turn = parseTranscriptLine(lines[i] as string)
      if (turn) return turn
    }
  } catch {
    // unreadable → null (the action falls back to raw stdin)
  }
  return null
}

/**
 * Parse the CONTENTS of an existing settings file. Empty/whitespace → `{}` (a fresh file). MALFORMED
 * JSON THROWS — `hooks install` must REFUSE rather than silently overwrite a user's (recoverable)
 * settings. Exported for a direct unit test. (An ABSENT file is handled by `readSettings`, not here.)
 */
export const parseExistingSettings = (raw: string): Json => {
  if (raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      ".claude/settings.json is not valid JSON — fix or remove it (refusing to overwrite)",
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".claude/settings.json is not a JSON object (refusing to overwrite)")
  }
  return parsed as Json
}

/** Read existing settings: absent file → `{}` (create with just the hooks); malformed → throws. */
const readSettings = (path: string): Json =>
  existsSync(path) ? parseExistingSettings(readFileSync(path, "utf8")) : {}

const globalsOf = (command: Command): GlobalFlags => command.optsWithGlobals() as GlobalFlags

const registerContext = (program: Command, deps: CliDeps): void => {
  const command = program
    .command("context")
    .description(
      "Print brain context for injection (--snapshot: the session-context snapshot markdown)",
    )
    .helpGroup("session commands")
    .option("--snapshot", "print the tenant's current session-context snapshot markdown")
  addGlobalFlags(command)
  command.action(async (_opts, self: Command) => {
    const globals = globalsOf(self)
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    try {
      const session = resolveSession(deps.loadConfig(), globals, deps.env, deps.deviceDeps)
      const res = (await deps.createClient(session).call("get_context_snapshot", true, {})) as {
        content: string | null
      }
      // Raw markdown to stdout so a SessionStart hook can inject it verbatim (empty when none yet).
      deps.out(res.content ?? "")
    } catch (error) {
      printer.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
}

const registerCapture = (program: Command, deps: CliDeps): void => {
  const command = program
    .command("capture")
    .description(
      "Capture one conversation turn (Stop-hook friendly). Reads the hook's stdin JSON envelope for " +
        "session_id + transcript; --session/--content override for manual use.",
    )
    .helpGroup("session commands")
    .option("--session <id>", "client session id (else taken from the hook's stdin session_id)")
    .option("--role <role>", "turn role: user|assistant|system|tool", "user")
    .option("--content <text>", "turn content (else the last transcript turn, else raw stdin)")
    .option("--client <client>", "originating client", "cli")
  addGlobalFlags(command)
  command.action(async (_opts, self: Command) => {
    const globals = globalsOf(self)
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    const opts = self.opts<{ session?: string; role: string; content?: string; client: string }>()
    try {
      const raw = readStdin()
      const env = parseHookEnvelope(raw)
      const sessionId = opts.session ?? env.sessionId
      if (!sessionId) {
        printer.error("brain capture: no --session and no session_id on stdin")
        process.exitCode = 1
        return
      }
      const turn =
        !opts.content && env.transcriptPath ? lastTurnFromTranscript(env.transcriptPath) : null
      const decision = resolveCapture({
        ...(opts.content !== undefined ? { explicitContent: opts.content } : {}),
        explicitRole: opts.role,
        turn,
        isEnvelope: env.isEnvelope,
        raw,
      })
      // No-op: a hook envelope with NO extractable turn stores NOTHING (never the envelope JSON).
      if (!decision) return
      const session = resolveSession(deps.loadConfig(), globals, deps.env, deps.deviceDeps)
      const out = await deps.createClient(session).call("capture_turn", false, {
        sessionId,
        role: decision.role,
        content: decision.content,
        client: opts.client,
      })
      printer.print(out)
    } catch (error) {
      printer.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
}

const registerHooksInstall = (program: Command, deps: CliDeps): void => {
  const hooks = program.command("hooks").description("Manage Claude Code hooks for the Brain")
  const install = hooks
    .command("install")
    .description(
      "Install SessionStart + Stop hooks into <repo>/.claude/settings.json (merge, never clobber)",
    )
    .helpGroup("session commands")
    .option("--path <dir>", "target repo directory (default: current directory)")
    .option(
      "--shared",
      "write to .claude/settings.json (committed/shared) instead of the default personal settings.local.json",
    )
    .option("--dry-run", "print the resulting settings.json instead of writing it")
  addGlobalFlags(install)
  install.action((opts: { path?: string; shared?: boolean; dryRun?: boolean }, self: Command) => {
    const globals = globalsOf(self)
    const printer = createPrinter(Boolean(globals.json), deps.out, deps.err)
    try {
      // Default to the PERSONAL, git-ignored settings.local.json — these hooks depend on the
      // installer's private auth + a locally-installed `brain` CLI. `--shared` opts into the
      // committed settings.json (teammates then need the CLI + their own auth — warned below).
      const file = opts.shared ? "settings.json" : "settings.local.json"
      const settingsPath = join(opts.path ?? process.cwd(), ".claude", file)
      const merged = mergeClaudeSettings(readSettings(settingsPath))
      const json = `${JSON.stringify(merged, null, 2)}\n`
      if (opts.dryRun) {
        if (opts.shared)
          deps.err(
            "warning: --shared writes committed hooks; teammates need the brain CLI + their own auth",
          )
        deps.out(json)
        return
      }
      if (opts.shared)
        deps.err(
          "warning: --shared writes committed hooks; teammates need the brain CLI + their own auth",
        )
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, json)
      printer.print({ installed: true, path: settingsPath, hooks: HOOKS.map((h) => h.event) })
    } catch (error) {
      printer.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
}

/** Register the hand-written hook-kit commands (`context`, `capture`, `hooks install`). */
export const registerHookCommands = (program: Command, deps: CliDeps): void => {
  registerContext(program, deps)
  registerCapture(program, deps)
  registerHooksInstall(program, deps)
}

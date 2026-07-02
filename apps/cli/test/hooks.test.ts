import { describe, expect, test } from "bun:test"
import {
  mergeClaudeSettings,
  parseExistingSettings,
  parseHookEnvelope,
  parseTranscriptLine,
  resolveCapture,
} from "../src/commands/hooks"

/**
 * `brain hooks install` writes into an ARBITRARY user repo's `.claude/settings.json` — a clobber is
 * the failure mode we most want to prevent. These pin the pure merge: preserve every unknown key and
 * every pre-existing hook, add ours idempotently.
 */

describe("mergeClaudeSettings — merge, never clobber", () => {
  test("adds both hooks to an empty settings object", () => {
    const merged = mergeClaudeSettings({}) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(merged.hooks.SessionStart[0]?.hooks[0]?.command).toBe("brain context --snapshot")
    expect(merged.hooks.Stop[0]?.hooks[0]?.command).toBe("brain capture --role assistant")
  })

  test("preserves unrelated top-level keys and an unrelated hook event", () => {
    const existing = {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
      },
    }
    const merged = mergeClaudeSettings(existing) as Record<string, unknown> & {
      hooks: Record<string, unknown[]>
    }
    // unrelated keys untouched
    expect(merged.model).toBe("opus")
    expect(merged.permissions).toEqual({ allow: ["Bash"] })
    // unrelated hook event untouched
    expect(merged.hooks.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "echo pre" }] }])
    // ours added
    expect(merged.hooks.SessionStart).toBeDefined()
    expect(merged.hooks.Stop).toBeDefined()
  })

  test("preserves a pre-existing SessionStart hook and APPENDS ours (never clobbers)", () => {
    const existing = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "my custom hook" }] }],
      },
    }
    const merged = mergeClaudeSettings(existing) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = merged.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))
    expect(commands).toContain("my custom hook") // existing preserved
    expect(commands).toContain("brain context --snapshot") // ours appended
  })

  test("is idempotent — re-install does not duplicate our hooks", () => {
    const once = mergeClaudeSettings({})
    const twice = mergeClaudeSettings(once) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(twice.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([
      "brain context --snapshot",
    ])
    expect(twice.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual([
      "brain capture --role assistant",
    ])
  })
})

describe("parseTranscriptLine — tolerate both version-unstable JSONL shapes", () => {
  test("shape A: {type:'assistant_message', content:'...'} → assistant role", () => {
    expect(parseTranscriptLine('{"type":"assistant_message","content":"hi there"}')).toEqual({
      role: "assistant",
      content: "hi there",
    })
  })
  test("shape B: {type:'assistant', message:{content:[{type:'text',text}]}} → flattened text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "block one" },
          { type: "text", text: " two" },
        ],
      },
    })
    expect(parseTranscriptLine(line)).toEqual({ role: "assistant", content: "block one two" })
  })
  test("user shapes map to the user role", () => {
    expect(parseTranscriptLine('{"type":"user_message","content":"q"}')?.role).toBe("user")
    expect(parseTranscriptLine('{"type":"user","message":{"content":"q"}}')?.role).toBe("user")
  })
  test("unknown type / unparseable / empty content → null (caller keeps scanning / falls back)", () => {
    expect(parseTranscriptLine('{"type":"system","content":"x"}')).toBeNull()
    expect(parseTranscriptLine("not json")).toBeNull()
    expect(parseTranscriptLine('{"type":"assistant","message":{"content":""}}')).toBeNull()
  })
})

describe("parseHookEnvelope — the Stop-hook stdin JSON", () => {
  test("extracts session_id + transcript_path and flags isEnvelope", () => {
    const env = parseHookEnvelope(
      JSON.stringify({
        session_id: "sess-123",
        transcript_path: "/tmp/t.jsonl",
        hook_event_name: "Stop",
      }),
    )
    expect(env.sessionId).toBe("sess-123")
    expect(env.transcriptPath).toBe("/tmp/t.jsonl")
    expect(env.isEnvelope).toBe(true)
  })

  test("non-JSON / plain text → NOT an envelope (isEnvelope false → manual-pipe path)", () => {
    expect(parseHookEnvelope("")).toEqual({ isEnvelope: false })
    expect(parseHookEnvelope("just some piped text")).toEqual({ isEnvelope: false })
    expect(parseHookEnvelope("null")).toEqual({ isEnvelope: false })
  })
})

describe("resolveCapture — envelope-with-no-turn NO-OPs (never stores envelope JSON)", () => {
  const base = { explicitRole: "assistant", turn: null, raw: "" }
  test("hook envelope + NO extractable turn → null (no-op, stores nothing)", () => {
    expect(resolveCapture({ ...base, isEnvelope: true, raw: '{"session_id":"s"}' })).toBeNull()
  })
  test("genuine non-envelope manual pipe → captures the raw text", () => {
    expect(resolveCapture({ ...base, isEnvelope: false, raw: "hello from a pipe" })).toEqual({
      content: "hello from a pipe",
      role: "assistant",
    })
  })
  test("explicit --content wins with its role", () => {
    expect(
      resolveCapture({
        explicitContent: "x",
        explicitRole: "user",
        turn: null,
        isEnvelope: true,
        raw: "env",
      }),
    ).toEqual({ content: "x", role: "user" })
  })
  test("a transcript turn wins over raw, with the turn's attributed role", () => {
    expect(
      resolveCapture({
        explicitRole: "user",
        turn: { role: "assistant", content: "reply" },
        isEnvelope: true,
        raw: "env",
      }),
    ).toEqual({ content: "reply", role: "assistant" })
  })
})

describe("parseExistingSettings — never overwrite a malformed settings file", () => {
  test("empty/whitespace → {} (a fresh file to create)", () => {
    expect(parseExistingSettings("")).toEqual({})
    expect(parseExistingSettings("   \n")).toEqual({})
  })
  test("valid JSON object → parsed as-is", () => {
    expect(parseExistingSettings('{"model":"opus"}')).toEqual({ model: "opus" })
  })
  test("MALFORMED JSON throws (install refuses, never overwrites)", () => {
    expect(() => parseExistingSettings("{ not: valid")).toThrow(/not valid JSON/)
  })
  test("a non-object (array / scalar) throws", () => {
    expect(() => parseExistingSettings("[1,2,3]")).toThrow(/not a JSON object/)
    expect(() => parseExistingSettings("42")).toThrow(/not a JSON object/)
  })
})

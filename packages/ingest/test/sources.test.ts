import { describe, expect, test } from "bun:test"
import { createChatGptImporter } from "../src/sources/chatgpt"
import { createClaudeCodeImporter } from "../src/sources/claude-code"
import { runImporterContract } from "../src/sources/contract"

/**
 * ChatGPT + Claude-Code session importers (PRD §4.7.1). They parse UNTRUSTED exports defensively
 * (skip-record on drift, never throw), reconstruct the linear turn order, drop foreign embeddings
 * (`embeddingModel:'pending'`), and satisfy `runImporterContract` (terminal cursor null; no
 * empty-batch-with-non-null-cursor).
 */

describe("ChatGPT conversations.json importer", () => {
  // A mapping tree: root → user → assistant, with a dead edit-branch off root the parent-walk skips.
  const exportJson = JSON.stringify([
    {
      id: "conv-1",
      title: "Greeting",
      create_time: 1_700_000_000,
      current_node: "n3",
      mapping: {
        root: { id: "root", parent: null, children: ["n1", "branch"] },
        n1: {
          id: "n1",
          parent: "root",
          children: ["n3"],
          message: {
            author: { role: "user" },
            create_time: 1_700_000_001,
            content: { content_type: "text", parts: ["hello"] },
          },
        },
        branch: {
          id: "branch",
          parent: "root",
          children: [],
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["DISCARDED edit"] },
          },
        },
        n3: {
          id: "n3",
          parent: "n1",
          children: [],
          message: {
            author: { role: "assistant" },
            create_time: 1_700_000_002,
            content: { content_type: "text", parts: ["hi there"] },
          },
        },
      },
    },
  ])

  test("reconstructs the active-leaf parent-walk; drops the edit branch; emits pending embeddings", async () => {
    const sessions = await runImporterContract(createChatGptImporter(exportJson))
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    expect(session?.client).toBe("chatgpt")
    expect(session?.sourceSessionId).toBe("conv-1")
    expect(session?.embeddingModel).toBe("pending")
    expect(session?.embeddingDims).toBe(0)
    // Only the chosen path (root→n1→n3); the DISCARDED edit branch is not present.
    expect(session?.turns.map((t) => t.content)).toEqual(["hello", "hi there"])
    expect(session?.turns.map((t) => t.role)).toEqual(["user", "assistant"])
    expect(session?.turns.map((t) => t.idx)).toEqual([0, 1])
  })

  test("a corrupt export yields zero sessions, never throws", async () => {
    const sessions = await runImporterContract(createChatGptImporter("{not json"))
    expect(sessions).toHaveLength(0)
  })

  test("a conversation with no text turns is skipped without violating the contract", async () => {
    const empties = JSON.stringify([
      { id: "empty", mapping: { root: { id: "root", parent: null, children: [] } } },
      {
        id: "real",
        current_node: "m1",
        mapping: {
          m1: {
            id: "m1",
            parent: null,
            children: [],
            message: { author: { role: "user" }, content: { parts: ["only real"] } },
          },
        },
      },
    ])
    const sessions = await runImporterContract(createChatGptImporter(empties))
    expect(sessions.map((s) => s.sourceSessionId)).toEqual(["real"])
  })
})

describe("Claude-Code .jsonl transcript importer", () => {
  const jsonl = [
    JSON.stringify({ type: "summary", summary: "ignored" }),
    JSON.stringify({
      type: "user",
      sessionId: "cc-abc",
      timestamp: 1_700_000_000,
      message: { role: "user", content: "fix the bug" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "cc-abc",
      timestamp: 1_700_000_005,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", name: "Edit" },
        ],
      },
    }),
    "{ malformed",
  ].join("\n")

  test("keeps user/assistant text records; tool_use collapses to a marker; one session", async () => {
    const sessions = await runImporterContract(createClaudeCodeImporter(jsonl))
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    expect(session?.client).toBe("claude-code")
    expect(session?.sourceSessionId).toBe("cc-abc") // constant across the file
    expect(session?.embeddingModel).toBe("pending")
    expect(session?.turns[0]?.content).toBe("fix the bug")
    // The assistant turn keeps its text and summarizes the tool_use block inline.
    expect(session?.turns[1]?.content).toBe("on it\n[tool_use: Edit]")
    expect(session?.title).toBe("fix the bug")
  })

  test("an empty/garbage transcript yields zero sessions", async () => {
    const sessions = await runImporterContract(createClaudeCodeImporter("\n\n{bad\n"))
    expect(sessions).toHaveLength(0)
  })
})

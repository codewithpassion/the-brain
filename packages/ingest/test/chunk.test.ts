import { describe, expect, test } from "bun:test"
import { MAX_BODY_BYTES, MAX_CHUNKS_PER_DOC } from "@brain/shared"
import { type Chunk, chunkDocument, planParts } from "../src/chunk"

describe("chunkDocument — empty / trivial", () => {
  test("empty input yields no chunks (workflow empty-extraction branch, §4.11)", () => {
    expect(chunkDocument("")).toEqual([])
    expect(chunkDocument("   \n\n\t  ")).toEqual([])
  })

  test("a short document packs into a single chunk with sequential index", () => {
    const chunks = chunkDocument("alpha\n\nbeta\n\ngamma")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunkIndex).toBe(0)
    expect(chunks[0]?.content).toBe("alpha\n\nbeta\n\ngamma")
    expect(chunks[0]?.headingPath).toBeNull()
  })

  test("token_count is ceil(content.length / 4)", () => {
    const chunks = chunkDocument("# Guide", { contentType: "text/markdown" })
    expect(chunks[0]?.content).toBe("# Guide") // length 7
    expect(chunks[0]?.tokenCount).toBe(2) // ceil(7/4)
  })
})

describe("chunkDocument — heading-aware paragraph chunking", () => {
  const doc = [
    "# Guide",
    "",
    "Intro paragraph about the guide.",
    "",
    "## Setup",
    "",
    "Install the thing first.",
    "",
    "### Prerequisites",
    "",
    "You need Node and Bun.",
    "",
    "## Usage",
    "",
    "Run the command to start.",
  ].join("\n")

  test("produces correct chunk_index ordering and heading_path breadcrumbs", () => {
    // targetChars 30 forces one chunk per block so each breadcrumb is asserted.
    const chunks = chunkDocument(doc, { strategy: "paragraph", targetChars: 30 })
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(chunks.map((c) => c.headingPath)).toEqual([
      "Guide",
      "Guide",
      "Guide > Setup",
      "Guide > Setup",
      "Guide > Setup > Prerequisites",
      "Guide > Setup > Prerequisites",
      "Guide > Usage",
      "Guide > Usage",
    ])
    expect(chunks.map((c) => c.content)).toEqual([
      "# Guide",
      "Intro paragraph about the guide.",
      "## Setup",
      "Install the thing first.",
      "### Prerequisites",
      "You need Node and Bun.",
      "## Usage",
      "Run the command to start.",
    ])
  })

  test("sibling heading pops back up the level stack (Prerequisites does not leak into Usage)", () => {
    const chunks = chunkDocument(doc, { strategy: "paragraph", targetChars: 30 })
    const usage = chunks.find((c) => c.content === "## Usage")
    expect(usage?.headingPath).toBe("Guide > Usage")
  })

  test("greedy packing keeps each chunk near the target and never far over it", () => {
    const para = "Sentence number with several words here.\n\n"
    const big = para.repeat(200)
    const chunks = chunkDocument(big, { strategy: "paragraph", targetChars: 200 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(400) // ≤ 2× target
  })
})

describe("chunkDocument — oversized paragraph split (> 2× target)", () => {
  test("splits an oversized paragraph at whitespace into ≤ 2× target pieces", () => {
    const block = "word ".repeat(50).trim() // 249 chars, no blank lines → one paragraph
    const chunks = chunkDocument(block, { strategy: "paragraph", targetChars: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(40) // 2× target
    // every word survives the split
    expect(
      chunks
        .map((c) => c.content)
        .join(" ")
        .split(/\s+/)
        .filter(Boolean),
    ).toHaveLength(50)
  })

  test("hard-splits a no-whitespace oversized paragraph on a char boundary (no stall)", () => {
    const block = "x".repeat(50)
    const chunks = chunkDocument(block, { strategy: "paragraph", targetChars: 10 })
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(20)
    expect(chunks.map((c) => c.content).join("")).toBe(block)
  })
})

describe("chunkDocument — sliding (sentence-aware) strategy", () => {
  test("short text fits a single window", () => {
    const chunks = chunkDocument("Just one short sentence.", { strategy: "sliding" })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toBe("Just one short sentence.")
    expect(chunks[0]?.headingPath).toBeNull()
  })

  test("breaks at a sentence boundary past the halfway mark and overlaps", () => {
    const text = "Sentence one is here. Sentence two is here. Sentence three is final."
    const chunks = chunkDocument(text, { strategy: "sliding", maxTokens: 10, overlap: 2 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.content).toBe("Sentence one is here.") // broke at ". " boundary
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(40) // ≤ window chars
    expect(chunks.every((c) => c.headingPath === null)).toBe(true)
  })

  test("derives strategy from contentType — PDF prose routes to sliding (no breadcrumbs)", () => {
    const markdownish = "# Looks like a heading\n\nBut this is PDF prose extracted to text."
    const chunks = chunkDocument(markdownish, { contentType: "application/pdf" })
    expect(chunks.every((c) => c.headingPath === null)).toBe(true)
  })

  test("derives strategy from contentType — markdown routes to paragraph (breadcrumbs)", () => {
    const md = "# Real Heading\n\nBody under it."
    const chunks = chunkDocument(md, { contentType: "text/markdown", targetChars: 10 })
    expect(chunks.some((c) => c.headingPath === "Real Heading")).toBe(true)
  })
})

const makeChunks = (n: number, contentLength: number): Chunk[] =>
  Array.from({ length: n }, (_unused, i) => ({
    chunkIndex: i,
    content: "a".repeat(contentLength),
    headingPath: null,
    tokenCount: Math.ceil(contentLength / 4),
  }))

describe("planParts — deterministic split on chunk boundaries (§4.3)", () => {
  test("empty input yields no parts", () => {
    expect(planParts([])).toEqual([])
  })

  test("a document under both ceilings is a single part", () => {
    const parts = planParts(makeChunks(5, 100))
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ partIndex: 0, chunkStart: 0, chunkEnd: 5, chunkCount: 5 })
  })

  test("splits by max chunk count into contiguous parts", () => {
    const parts = planParts(makeChunks(25, 10), { maxChunks: 10 })
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => p.chunkCount)).toEqual([10, 10, 5])
    expect(parts.map((p) => p.partIndex)).toEqual([0, 1, 2])
    expect(parts.map((p) => [p.chunkStart, p.chunkEnd])).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ])
  })

  test("splits by max body bytes", () => {
    const parts = planParts(makeChunks(5, 100), { maxBytes: 250 })
    // 250 bytes ⇒ at most 2 chunks (200 bytes) per part before the next would exceed.
    expect(parts.map((p) => p.chunkCount)).toEqual([2, 2, 1])
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(250)
  })

  test("a single chunk larger than maxBytes occupies its own part (cannot split further)", () => {
    const parts = planParts(makeChunks(1, 500), { maxBytes: 100 })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ chunkCount: 1, byteLength: 500 })
  })

  test("defaults to the shared MAX_CHUNKS_PER_DOC / MAX_BODY_BYTES ceilings", () => {
    const parts = planParts(makeChunks(MAX_CHUNKS_PER_DOC + 1, 1))
    expect(parts).toHaveLength(2)
    expect(parts[0]?.chunkCount).toBe(MAX_CHUNKS_PER_DOC)
    expect(parts[1]?.chunkCount).toBe(1)
    expect(MAX_BODY_BYTES).toBeGreaterThan(0)
  })
})

describe("chunkDocument → planParts end-to-end", () => {
  test("a realistic multi-heading document chunks then plans to a single part", () => {
    const doc = [
      "# Project README",
      "",
      "This project does a thing. It is written in TypeScript and runs on Workers.",
      "",
      "## Installation",
      "",
      "Run the install command. Then configure your environment variables.",
      "",
      "## Usage",
      "",
      "Call the main function with your options to get started quickly.",
    ].join("\n")
    const chunks = chunkDocument(doc, { contentType: "text/markdown" })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // chunk_index is contiguous from 0
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_c, i) => i))
    // every chunk carries the README breadcrumb root
    for (const c of chunks) expect(c.headingPath?.startsWith("Project README")).toBe(true)
    const parts = planParts(chunks)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.chunkEnd).toBe(chunks.length)
  })
})

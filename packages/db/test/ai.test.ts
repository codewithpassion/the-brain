import { describe, expect, test } from "bun:test"
import { MONTHLY_COST_CEILING_USD } from "@brain/shared"
import { embed, embedForIndex } from "../src/ai/embed"
import {
  type AiDeps,
  aiGateway,
  GatewayBudgetError,
  isGatewayBudgetError,
  type OpenAiCompatConfig,
} from "../src/ai/gateway"
import { gen, genExtract } from "../src/ai/gen"
import { remapRerank, rerank } from "../src/ai/rerank"
import { TranscriptionError, transcribe } from "../src/ai/transcribe"
import { estimateWhisperNeurons, WHISPER_NEURONS_PER_SECOND } from "../src/search/ports"

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build `AiDeps` around a fake `run` implementation. */
const deps = (run: AiDeps["ai"]["run"]): AiDeps => ({
  ai: { run },
  gatewayId: "gw",
  tenantId: "t1",
})

/** Build `AiDeps` wired to the openai-compatible provider with a stub fetch. */
const openaiDeps = (
  fetchFn: typeof globalThis.fetch,
  cfg?: Partial<OpenAiCompatConfig>,
): AiDeps => ({
  ai: { run: () => Promise.reject(new Error("should not call Workers AI on openai path")) },
  gatewayId: "gw",
  tenantId: "t1",
  openaiConfig: {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    fetch: fetchFn,
    ...cfg,
  },
})

const vec1024 = (): number[] => Array.from({ length: 1024 }, () => 0)

// ── embed() — Workers AI path (invariants 12, 14) ────────────────────────────

describe("embed() (invariants 12, 14)", () => {
  test("READ path returns vectors on a valid 1024-dim response", async () => {
    const d = deps(() => Promise.resolve({ data: [vec1024()] }))
    const out = await embed(d, ["hello"])
    expect(out).not.toBeNull()
    expect(out?.[0]).toHaveLength(1024)
  })

  test("READ path returns null when the binding throws (degrade to keyword-only)", async () => {
    const d = deps(() => Promise.reject(new Error("AI down")))
    expect(await embed(d, ["hello"])).toBeNull()
  })

  test("READ path REFUSES a wrong-dimension vector (returns null, invariant 12)", async () => {
    const d = deps(() => Promise.resolve({ data: [[1, 2, 3]] }))
    expect(await embed(d, ["hello"])).toBeNull()
  })

  test("WRITE path THROWS on failure / wrong dim (triggers Workflow retry, invariant 14)", async () => {
    const down = deps(() => Promise.reject(new Error("AI down")))
    await expect(embedForIndex(down, ["hello"])).rejects.toThrow()

    const wrongDim = deps(() => Promise.resolve({ data: [[1, 2, 3]] }))
    await expect(embedForIndex(wrongDim, ["hello"])).rejects.toThrow()
  })

  test("WRITE path returns vectors on a valid 1024-dim response", async () => {
    const d = deps(() => Promise.resolve({ data: [vec1024()] }))
    expect(await embedForIndex(d, ["hello"])).toHaveLength(1)
  })
})

// ── embed() — openai-compatible path ─────────────────────────────────────────

describe("embed() — openai-compatible routing", () => {
  test("routes to /v1/embeddings with correct request shape", async () => {
    let capturedUrl = ""
    let capturedBody: unknown

    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      capturedUrl = typeof url === "string" ? url : url.toString()
      capturedBody = JSON.parse((init?.body as string) ?? "{}")
      return new Response(JSON.stringify({ data: [{ embedding: vec1024() }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const d = openaiDeps(fakeFetch)
    const out = await embed(d, ["hello world"])

    expect(capturedUrl).toBe("https://api.example.com/v1/embeddings")
    expect(capturedBody).toMatchObject({ input: ["hello world"] })
    expect(out?.[0]).toHaveLength(1024)
  })

  test("uses embedModel override when set", async () => {
    let capturedModel = ""

    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}")
      capturedModel = body.model as string
      return new Response(JSON.stringify({ data: [{ embedding: vec1024() }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const d = openaiDeps(fakeFetch, { embedModel: "text-embedding-3-large" })
    await embed(d, ["hello"])
    expect(capturedModel).toBe("text-embedding-3-large")
  })

  test("READ path returns null on non-ok response (degrade)", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => new Response(null, { status: 429 })
    const d = openaiDeps(fakeFetch)
    expect(await embed(d, ["hello"])).toBeNull()
  })

  test("WRITE path REFUSES wrong-dim on openai-compatible path (invariant 12)", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })

    const d = openaiDeps(fakeFetch)
    await expect(embedForIndex(d, ["hello"])).rejects.toThrow()
  })
})

// ── gateway spend enforcement (defense-in-depth) ─────────────────────────────

describe("AI Gateway spend enforcement (defense-in-depth)", () => {
  test("aiGateway() includes collectLog + tenant_id + cost_limit_usd attribution", () => {
    const opts = aiGateway("gw-123", "tenant-abc")
    expect(opts.gateway.id).toBe("gw-123")
    expect(opts.gateway.collectLog).toBe(true)
    expect(opts.gateway.metadata?.tenant_id).toBe("tenant-abc")
    expect(opts.gateway.metadata?.cost_limit_usd).toBe(MONTHLY_COST_CEILING_USD)
  })

  test("isGatewayBudgetError detects budget-related messages", () => {
    expect(isGatewayBudgetError(new Error("AI Gateway budget limit exceeded"))).toBe(true)
    expect(isGatewayBudgetError(new Error("spend limit reached"))).toBe(true)
    expect(isGatewayBudgetError(new Error("cost limit exceeded"))).toBe(true)
    expect(isGatewayBudgetError(new Error("AI down"))).toBe(false)
    expect(isGatewayBudgetError("not an error")).toBe(false)
  })

  test("WRITE path propagates GatewayBudgetError when Workers AI rejects for budget", async () => {
    const d = deps(() => Promise.reject(new Error("AI Gateway budget limit exceeded")))
    await expect(embedForIndex(d, ["hello"])).rejects.toBeInstanceOf(GatewayBudgetError)
  })

  test("READ path degrades to null (never throws) even on gateway budget error", async () => {
    const d = deps(() => Promise.reject(new Error("AI Gateway budget limit exceeded")))
    expect(await embed(d, ["hello"])).toBeNull()
  })
})

// ── rerank() + remapRerank — Workers AI path (invariants 14, 20) ──────────────

describe("rerank() + remapRerank (invariants 14, 20)", () => {
  test("remaps candidates by the model's index order", async () => {
    const d = deps(() =>
      Promise.resolve({
        response: [
          { id: 1, score: 0.9 },
          { id: 0, score: 0.8 },
        ],
      }),
    )
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }], 2)
    expect(hits).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.8 },
    ])
  })

  test("degrades to identity (RRF) order on malformed output — never throws", async () => {
    const d = deps(() => Promise.resolve({ garbage: true }))
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }], 2)
    expect(hits).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 },
    ])
  })

  test("degrades to identity order when the binding throws", async () => {
    const d = deps(() => Promise.reject(new Error("AI down")))
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }, { text: "c" }], 2)
    expect(hits).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 },
    ])
  })

  test("remapRerank drops rows whose id is out of range", () => {
    const remapped = remapRerank(2, {
      response: [
        { id: 5, score: 0.9 }, // out of range → dropped
        { id: 0, score: 0.8 },
      ],
    })
    expect(remapped).toEqual([{ index: 0, score: 0.8 }])
  })
})

// ── rerank() — openai-compatible path ────────────────────────────────────────

describe("rerank() — openai-compatible routing", () => {
  test("routes to /v1/rerank with correct Cohere-style request shape", async () => {
    let capturedUrl = ""
    let capturedBody: unknown

    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      capturedUrl = typeof url === "string" ? url : url.toString()
      capturedBody = JSON.parse((init?.body as string) ?? "{}")
      return new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.7 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const d = openaiDeps(fakeFetch)
    const hits = await rerank(d, "test query", [{ text: "a" }, { text: "b" }], 2)

    expect(capturedUrl).toBe("https://api.example.com/v1/rerank")
    expect(capturedBody).toMatchObject({
      query: "test query",
      documents: ["a", "b"],
      top_n: 2,
    })
    // Normalized through remapRerank (invariant 20: single remap)
    expect(hits).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.7 },
    ])
  })

  test("degrades to identity order on non-ok response", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => new Response(null, { status: 503 })
    const d = openaiDeps(fakeFetch)
    const hits = await rerank(d, "q", [{ text: "a" }, { text: "b" }], 2)
    expect(hits).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 },
    ])
  })
})

// ── gen() — openai-compatible path ───────────────────────────────────────────

describe("gen() + genExtract() — openai-compatible routing", () => {
  test("gen() routes to /v1/chat/completions and returns content", async () => {
    let capturedUrl = ""
    let capturedBody: unknown

    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      capturedUrl = typeof url === "string" ? url : url.toString()
      capturedBody = JSON.parse((init?.body as string) ?? "{}")
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "hello from openai" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const d = openaiDeps(fakeFetch)
    const out = await gen(d, "say hello", "you are helpful")

    expect(capturedUrl).toBe("https://api.example.com/v1/chat/completions")
    expect(capturedBody).toMatchObject({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "say hello" },
      ],
    })
    expect(out).toBe("hello from openai")
  })

  test("gen() returns null on non-ok response (degrade)", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => new Response(null, { status: 500 })
    const d = openaiDeps(fakeFetch)
    expect(await gen(d, "hello")).toBeNull()
  })

  test("genExtract() passes response_format: json_object", async () => {
    let capturedBody: unknown

    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}")
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"key":"val"}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const d = openaiDeps(fakeFetch)
    const out = await genExtract(d, "extract facts")

    expect(capturedBody).toMatchObject({ response_format: { type: "json_object" } })
    expect(out).toBe('{"key":"val"}')
  })

  test("genExtract() uses extractModel override when set", async () => {
    let capturedModel = ""

    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}")
      capturedModel = body.model as string
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const d = openaiDeps(fakeFetch, { extractModel: "gpt-4o-mini" })
    await genExtract(d, "extract")
    expect(capturedModel).toBe("gpt-4o-mini")
  })
})

// ── transcribe() — WRITE/ingest path over whisper (W3.2, invariant 14) ────────

describe("transcribe() (W3.2 — voice memos, whisper-large-v3-turbo)", () => {
  const audio = new Uint8Array(32_000) // 32 KB → 2 s at the byte-rate fallback

  test("sends BASE64 audio (turbo input shape), not the base model's number[]", async () => {
    let capturedModel = ""
    let capturedAudio: unknown
    const d = deps((model, inputs) => {
      capturedModel = model
      capturedAudio = (inputs as { audio?: unknown }).audio
      return Promise.resolve({ text: "ok", segments: [{ end: 1 }] })
    })
    await transcribe(d, audio)
    expect(capturedModel).toBe("@cf/openai/whisper-large-v3-turbo")
    // base64 of 32 KB of zeros is a non-empty string ("AAAA…"); the base model's shape was number[].
    expect(typeof capturedAudio).toBe("string")
    expect((capturedAudio as string).length).toBeGreaterThan(0)
  })

  test("returns the transcript + neuron estimate from segment timestamps (turbo output)", async () => {
    const d = deps(() =>
      Promise.resolve({ text: "  hello world  ", segments: [{ end: 1 }, { end: 5 }] }),
    )
    const out = await transcribe(d, audio)
    expect(out.text).toBe("hello world") // trimmed
    // Duration = last segment.end (5 s) → estimate ignores byteLength.
    expect(out.neurons).toBe(estimateWhisperNeurons(5))
    expect(out.neurons).toBe(5 * WHISPER_NEURONS_PER_SECOND)
  })

  test("falls back to words[].end when segments are absent (base-model defensive)", async () => {
    const d = deps(() => Promise.resolve({ text: "hi", words: [{ end: 3 }] }))
    const out = await transcribe(d, audio)
    expect(out.neurons).toBe(estimateWhisperNeurons(3))
  })

  test("falls back to a byte-rate duration estimate when no timestamps at all", async () => {
    const d = deps(() => Promise.resolve({ text: "no timestamps here" }))
    const out = await transcribe(d, audio)
    // 32_000 bytes / 16_000 B/s = 2 s.
    expect(out.neurons).toBe(estimateWhisperNeurons(2))
  })

  test("THROWS TranscriptionError when the binding fails (ingest must fail visibly)", async () => {
    const d = deps(() => Promise.reject(new Error("whisper down")))
    await expect(transcribe(d, audio)).rejects.toBeInstanceOf(TranscriptionError)
  })

  test("RE-THROWS GatewayBudgetError (429 path), NOT a generic TranscriptionError", async () => {
    const d = deps(() => Promise.reject(new Error("AI Gateway budget limit exceeded")))
    await expect(transcribe(d, audio)).rejects.toBeInstanceOf(GatewayBudgetError)
  })

  test("THROWS TranscriptionError on an empty / whitespace-only transcript", async () => {
    const empty = deps(() => Promise.resolve({ text: "   " }))
    await expect(transcribe(empty, audio)).rejects.toBeInstanceOf(TranscriptionError)

    const missing = deps(() => Promise.resolve({}))
    await expect(transcribe(missing, audio)).rejects.toBeInstanceOf(TranscriptionError)
  })
})

// ── whisper-large-v3-turbo live-shape gate (doc-verified, live-UNVERIFIED) ────

/**
 * Shape-lock gate for @cf/openai/whisper-large-v3-turbo (W3.2), mirroring the reranker gate above.
 *
 * ASSUMED (from rendered CF docs, NOT verified against the live model):
 *   INPUT:  { audio: <base64 string>, language?: string }
 *   OUTPUT: { text: string, word_count: number, segments: [{ end: number, ... }], vtt: string,
 *             transcription_info: {...} }   — NOTE: no top-level `words[]` (the base model had that).
 *
 * `transcribe()` reads `text` (the body) + the last `segments[].end` (duration → neuron estimate),
 * falling back to `words[].end` then a byte-rate. If the live model's field names differ, update
 * `transcribe.ts` (encoding + estimateSeconds) and this gate together.
 *
 * To run against the live model (real AI call, in apps/api miniflare): RUN_AI_GATES=1.
 */
describe.skipIf(process.env.RUN_AI_GATES !== "1")(
  "whisper turbo shape gate [RUN_AI_GATES=1 required]",
  () => {
    test("assumed { text, segments:[{end}] } output drives transcribe() correctly", async () => {
      const d = deps(() =>
        Promise.resolve({
          text: "assumed live transcript",
          word_count: 3,
          segments: [
            { end: 2.5, text: "assumed live" },
            { end: 4.1, text: "transcript" },
          ],
          vtt: "WEBVTT\n\n00:00.000 --> 00:04.100\nassumed live transcript",
        }),
      )
      const out = await transcribe(d, new Uint8Array(1000))
      expect(out.text).toBe("assumed live transcript")
      expect(out.neurons).toBe(estimateWhisperNeurons(4.1))
    })
  },
)

// ── Reranker live-shape gate ──────────────────────────────────────────────────

/**
 * Shape-lock gate for bge-reranker-base (invariant 20, PRD §10.6).
 *
 * ASSUMED shape (not pinned by rendered CF docs):
 *   { response: Array<{ id: number; score: number }> }
 * where `id` is the 0-based index into the input `contexts` array.
 *
 * This gate in packages/db locks the ASSUMED shape into a named test; it must be
 * corroborated by the live model before being fully trusted. The live verification
 * against the real bge-reranker-base model runs via apps/api/test (miniflare + Workers
 * AI) with `RUN_AI_GATES=1`. Once the live gate is green, this lock is confirmed.
 *
 * To run this gate:
 *   RUN_AI_GATES=1 bun test packages/db/test/ai.test.ts
 *
 * The live gate (real model call) runs in apps/api:
 *   RUN_AI_GATES=1 bun run test  (from apps/api, with wrangler miniflare)
 *
 * Shape unverified against live model — update this comment once locked.
 */
const RUN_AI_GATES = process.env.RUN_AI_GATES === "1"

describe.skipIf(!RUN_AI_GATES)("reranker shape gate [RUN_AI_GATES=1 required, PRD §10.6]", () => {
  test("assumed { response: [{ id, score }] } shape drives remapRerank correctly (invariant 20)", () => {
    // The assumed live output of bge-reranker-base for 3 candidates.
    // If the live gate (apps/api) shows different field names, update remapRerank
    // and this assumed shape together so there is one authoritative locked shape.
    const assumedLiveShape = {
      response: [
        { id: 2, score: 0.95 }, // candidate 2 ranked highest
        { id: 0, score: 0.82 }, // candidate 0 ranked second
        { id: 1, score: 0.71 }, // candidate 1 ranked lowest
      ],
    }

    const hits = remapRerank(3, assumedLiveShape)

    // Shape must produce valid hits — not null, not empty
    expect(hits).not.toBeNull()
    expect(hits).toHaveLength(3)

    // Index→candidate mapping must be correct (invariant 20)
    expect(hits?.[0]).toEqual({ index: 2, score: 0.95 })
    expect(hits?.[1]).toEqual({ index: 0, score: 0.82 })
    expect(hits?.[2]).toEqual({ index: 1, score: 0.71 })

    // All ids must resolve within the candidate range
    for (const hit of hits ?? []) {
      expect(hit.index).toBeGreaterThanOrEqual(0)
      expect(hit.index).toBeLessThan(3)
    }
  })

  test("remapRerank is resilient: out-of-range ids in live output are dropped safely", () => {
    // If the live model ever returns an out-of-range id (e.g., due to top_k > len),
    // remapRerank must drop it without indexing past the array (invariant 20).
    const withOutOfRange = {
      response: [
        { id: 99, score: 0.95 }, // must be dropped
        { id: 0, score: 0.82 },
      ],
    }
    const hits = remapRerank(3, withOutOfRange)
    expect(hits).toEqual([{ index: 0, score: 0.82 }])
  })
})

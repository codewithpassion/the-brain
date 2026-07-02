/**
 * `transcribe()` chokepoint over @cf/openai/whisper-large-v3-turbo (v2 W3.2 — voice memos). Same
 * shape as `embed()`/`gen()`: takes `AiDeps`, routes `env.AI.run` through the AI Gateway.
 *
 * ENCODING — the turbo model takes a BASE64 audio string. The base `@cf/openai/whisper` model's
 * `{ audio: number[] }` shape builds a multi-million-element JS array from the raw bytes and OOMs the
 * 128 MB isolate on a real memo; base64 is ~1.33× the byte length as a string, which fits. The caller
 * caps the audio at `AUDIO_MAX_BYTES` so the base64 string + gateway serialization stay well under
 * the isolate memory limit.
 *
 * DEGRADE CONTRACT — this is a WRITE/ingest path (audio → a document body), so unlike the read-path
 * `embed()`/`gen()` (which return null and degrade to keyword-only), `transcribe()` THROWS on any
 * failure or an empty transcript. A voice memo whose transcription failed must FAIL its ingest
 * pipeline VISIBLY (the caller creates no document + no audio blob) — never silently produce an empty
 * doc. A `GatewayBudgetError` is RE-THROWN as-is (mirrors embed/gen) so the caller's 429 cost path
 * fires; every other failure becomes a `TranscriptionError`. Whisper is priced in audio-SECONDS, so
 * it returns an estimated neuron count (from the model's segment/word timestamps when present, else a
 * byte-rate fallback) for the caller to record as `surface='ingest'` spend — the chokepoint itself is
 * db-free (matches the embed/gen seam).
 */
import { WHISPER_MODEL } from "@brain/shared"
import { estimateWhisperNeurons } from "../search/ports"
import { type AiDeps, aiGateway, GatewayBudgetError, isGatewayBudgetError } from "./gateway"

/** Thrown when transcription fails or yields no text (write-path: the ingest pipeline must fail). */
export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranscriptionError"
  }
}

/**
 * Defensive view of the whisper output. `whisper-large-v3-turbo` returns `text` + `segments[]` (with
 * end timestamps) + `vtt`; the base model returned `words[]`. We read either for a duration estimate.
 */
interface WhisperOutput {
  text?: unknown
  segments?: { end?: unknown }[]
  words?: { end?: unknown }[]
}

export interface Transcription {
  /** The transcript (becomes the document body). */
  text: string
  /** Coarse neuron estimate for `surface='ingest'` spend attribution (audio-seconds based). */
  neurons: number
}

/** Coarse fallback when whisper returns no timestamps: ~16 KB/s of compressed audio. Documented approx. */
const AUDIO_BYTES_PER_SECOND = 16_000

/** The last finite `end` timestamp across a list of timed spans (segments or words), else null. */
const lastEnd = (spans: { end?: unknown }[] | undefined): number | null => {
  if (!Array.isArray(spans)) return null
  for (let i = spans.length - 1; i >= 0; i--) {
    const end = spans[i]?.end
    if (typeof end === "number" && Number.isFinite(end)) return end
  }
  return null
}

/** Duration (seconds) from the last segment/word end timestamp, else a byte-rate estimate. */
const estimateSeconds = (out: WhisperOutput, byteLength: number): number =>
  lastEnd(out.segments) ?? lastEnd(out.words) ?? byteLength / AUDIO_BYTES_PER_SECOND

/** Base64-encode bytes in chunks (avoids a stack overflow from spreading a huge array into charCode). */
const toBase64 = (audio: Uint8Array): string => {
  let binary = ""
  const CHUNK = 8192
  for (let i = 0; i < audio.length; i += CHUNK) {
    binary += String.fromCharCode(...audio.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Transcribe audio bytes to text via whisper. RE-THROWS `GatewayBudgetError` (caller maps to 429);
 * THROWS `TranscriptionError` on any other failure or an empty transcript. Returns the transcript +
 * an audio-seconds-based neuron estimate.
 */
export const transcribe = async (deps: AiDeps, audio: Uint8Array): Promise<Transcription> => {
  let out: WhisperOutput
  try {
    out = (await deps.ai.run(
      WHISPER_MODEL,
      { audio: toBase64(audio) },
      aiGateway(deps.gatewayId, deps.tenantId),
    )) as WhisperOutput
  } catch (err) {
    // Budget/cost-ceiling errors must surface as a 429, not a generic transcription failure.
    if (isGatewayBudgetError(err)) throw new GatewayBudgetError()
    throw new TranscriptionError(
      `transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const text = typeof out.text === "string" ? out.text.trim() : ""
  if (text.length === 0) throw new TranscriptionError("transcription produced no text")
  return { text, neurons: estimateWhisperNeurons(estimateSeconds(out, audio.byteLength)) }
}

/**
 * Pure unit tests for the ingest route helpers (no BRAIN_API binding required).
 * The server fn itself cannot be tested in isolation (requires the BRAIN_API service
 * binding and Clerk auth), so we test the pure exported helpers.
 */
import { describe, expect, test } from "bun:test"
import { AUDIO_EXTS, EXT_TO_CONTENT_TYPE } from "../src/lib/content-types"

describe("EXT_TO_CONTENT_TYPE (ingest route helper)", () => {
  test("maps standard text extensions to correct MIME types", () => {
    expect(EXT_TO_CONTENT_TYPE.md).toBe("text/markdown")
    expect(EXT_TO_CONTENT_TYPE.txt).toBe("text/plain")
    expect(EXT_TO_CONTENT_TYPE.html).toBe("text/html")
    expect(EXT_TO_CONTENT_TYPE.htm).toBe("text/html")
  })

  test("maps binary document extensions to correct MIME types", () => {
    expect(EXT_TO_CONTENT_TYPE.pdf).toBe("application/pdf")
    expect(EXT_TO_CONTENT_TYPE.docx).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })

  test("maps image extensions to correct MIME types", () => {
    expect(EXT_TO_CONTENT_TYPE.jpg).toBe("image/jpeg")
    expect(EXT_TO_CONTENT_TYPE.jpeg).toBe("image/jpeg")
    expect(EXT_TO_CONTENT_TYPE.png).toBe("image/png")
    expect(EXT_TO_CONTENT_TYPE.gif).toBe("image/gif")
    expect(EXT_TO_CONTENT_TYPE.webp).toBe("image/webp")
  })

  test("maps audio (voice-memo) extensions + flags them as audio", () => {
    expect(EXT_TO_CONTENT_TYPE.m4a).toBe("audio/mp4")
    expect(EXT_TO_CONTENT_TYPE.mp3).toBe("audio/mpeg")
    expect(EXT_TO_CONTENT_TYPE.wav).toBe("audio/wav")
    // AUDIO_EXTS selects the larger cap in the UI; text/binary extensions are NOT in it.
    expect(AUDIO_EXTS.has("m4a")).toBe(true)
    expect(AUDIO_EXTS.has("mp3")).toBe(true)
    expect(AUDIO_EXTS.has("wav")).toBe(true)
    expect(AUDIO_EXTS.has("md")).toBe(false)
    expect(AUDIO_EXTS.has("pdf")).toBe(false)
  })

  test("unsupported extensions are absent (UI shows error for unknown ext)", () => {
    expect(EXT_TO_CONTENT_TYPE.exe).toBeUndefined()
    expect(EXT_TO_CONTENT_TYPE.csv).toBeUndefined()
    expect(EXT_TO_CONTENT_TYPE.zip).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { isPlaceholderEntityName } from "../src/entity-placeholders"

describe("isPlaceholderEntityName", () => {
  test("diarisation labels and role words are placeholders", () => {
    for (const name of [
      "Speaker 0",
      "speaker 12",
      "Speaker A",
      "SPEAKER m",
      "Them",
      "Me",
      "Me (Dominik)",
      "me(dom)",
      "You",
      "Unknown",
      "Guest",
      "Participant 3",
      "Attendee 1",
      "Presenter",
      "Host",
      "  Speaker 4  ",
      "",
    ]) {
      expect(isPlaceholderEntityName(name)).toBe(true)
    }
  })

  test("real names that merely contain the words are kept", () => {
    for (const name of [
      "Zoe Smith",
      "Speaker Bureau",
      "Me Too Movement",
      "The Host Company",
      "Guest Wifi Policy",
      "Speaker AB",
      "Dominik Fretz",
    ]) {
      expect(isPlaceholderEntityName(name)).toBe(false)
    }
  })
})

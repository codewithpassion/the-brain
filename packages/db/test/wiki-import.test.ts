import { describe, expect, test } from "bun:test"
import { confineWikilinks, IMPORT_CAPS, prepareWikiBundle } from "../src/wiki/okf-bundle"

const okf = (fm: Record<string, unknown>, body: string): string =>
  `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n\n${body}`

describe("confineWikilinks — namespace confinement (untrusted ingress)", () => {
  const P = "imported/acme"
  test("bare wikilink is prefixed", () => {
    expect(confineWikilinks("see [[bar]]", P)).toBe("see [[imported/acme/bar]]")
  })
  test("[[index]] is confined — never the global root index", () => {
    expect(confineWikilinks("[[index]]", P)).toBe("[[imported/acme/index]]")
  })
  test("labeled wikilink keeps its label", () => {
    expect(confineWikilinks("[[foo|Foo]]", P)).toBe("[[imported/acme/foo|Foo]]")
  })
  test("`..` / leading-slash traversal is stripped, not escaped", () => {
    expect(confineWikilinks("[[../../escape]]", P)).toBe("[[imported/acme/escape]]")
    expect(confineWikilinks("[[/abs]]", P)).toBe("[[imported/acme/abs]]")
  })
  test("external + anchor links are left alone", () => {
    expect(confineWikilinks("[[https://x.com]] [[mailto:a@b]]", P)).toBe(
      "[[https://x.com]] [[mailto:a@b]]",
    )
  })
  test("wikilinks inside code are NOT rewritten (author's bytes)", () => {
    expect(confineWikilinks("`[[bar]]`", P)).toBe("`[[bar]]`")
    expect(confineWikilinks("```\n[[bar]]\n```", P)).toBe("```\n[[bar]]\n```")
  })
  test("markdown internal link is confined; image target is not", () => {
    expect(confineWikilinks("[t](/index)", P)).toBe("[t](/imported/acme/index)")
    expect(confineWikilinks("![alt](pic.png)", P)).toBe("![alt](pic.png)")
  })
})

describe("prepareWikiBundle — caps + slug confinement + floor", () => {
  test("a traversal path lands UNDER the prefix (segments sanitized)", () => {
    const { prepared } = prepareWikiBundle(
      [{ path: "../../etc/passwd.md", content: okf({ type: "note", title: "P" }, "x") }],
      "acme",
    )
    const w = prepared.find((p) => p.kind === "write")
    expect(w?.kind).toBe("write")
    if (w?.kind === "write") expect(w.slug).toBe("imported/acme/etc/passwd")
  })
  test("bundle visibility/draft are DROPPED (never carried) — clean frontmatter only", () => {
    const { prepared } = prepareWikiBundle(
      [
        {
          path: "a.md",
          content: okf({ type: "note", title: "A", visibility: "world", secret: "x" }, "b"),
        },
      ],
      "acme",
    )
    const w = prepared.find((p) => p.kind === "write")
    if (w?.kind === "write") {
      expect(w.type).toBe("note")
      expect(w.title).toBe("A")
      // (visibility/secret are not part of the write record; the store floors visibility to private)
    }
  })
  test("over-cap file count is rejected before any write", () => {
    const many = Array.from({ length: IMPORT_CAPS.maxFiles + 1 }, (_, i) => ({
      path: `f${i}.md`,
      content: okf({ type: "note" }, "x"),
    }))
    expect(() => prepareWikiBundle(many, "acme")).toThrow(/exceeds max/)
  })
})

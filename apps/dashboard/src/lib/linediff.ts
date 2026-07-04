/**
 * A tiny LCS line diff for the wiki history panel (no heavy dep, per the phase brief). Produces a
 * flat op list (equal / add / remove) that a component renders as a unified diff. Good enough for
 * page-body revisions; not a full Myers implementation.
 */
export interface DiffLine {
  type: "eq" | "add" | "del"
  text: string
}

export const diffLines = (oldStr: string, newStr: string): DiffLine[] => {
  const a = oldStr.split("\n")
  const b = newStr.split("\n")
  const n = a.length
  const m = b.length
  const w = m + 1

  // LCS length table as a flat array (avoids 2D possibly-undefined indexing).
  const lcs = new Array<number>((n + 1) * w).fill(0)
  const get = (i: number, j: number): number => lcs[i * w + j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j] ? get(i + 1, j + 1) + 1 : Math.max(get(i + 1, j), get(i, j + 1))
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "eq", text: a[i] ?? "" })
      i++
      j++
    } else if (get(i + 1, j) >= get(i, j + 1)) {
      out.push({ type: "del", text: a[i] ?? "" })
      i++
    } else {
      out.push({ type: "add", text: b[j] ?? "" })
      j++
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] ?? "" })
  while (j < m) out.push({ type: "add", text: b[j++] ?? "" })
  return out
}

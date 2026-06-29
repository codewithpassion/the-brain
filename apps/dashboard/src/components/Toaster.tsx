/**
 * Minimal dependency-free toast. `toast(text)` shows a transient bottom-right notice; mount a
 * single `<Toaster/>` in the root layout. (Browser-only — `Date.now`/`Math.random` are fine here,
 * this never runs in the Workers/Workflow sandbox.)
 */
import { useEffect, useState } from "react"

interface ToastMsg {
  id: number
  text: string
}

let push: ((text: string) => void) | null = null

/** Show a toast. No-op if no `<Toaster/>` is mounted yet. */
export function toast(text: string): void {
  push?.(text)
}

export function Toaster() {
  const [msgs, setMsgs] = useState<ToastMsg[]>([])

  useEffect(() => {
    push = (text: string) => {
      const id = Date.now() + Math.random()
      setMsgs((m) => [...m, { id, text }])
      setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 2200)
    }
    return () => {
      push = null
    }
  }, [])

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex flex-col items-end gap-2">
      {msgs.map((m) => (
        <div
          key={m.id}
          className="pointer-events-auto rounded-md bg-neutral-900 px-3 py-2 text-sm text-white shadow-lg"
        >
          {m.text}
        </div>
      ))}
    </div>
  )
}

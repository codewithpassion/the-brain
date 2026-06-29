/**
 * A small nav dropdown for grouping secondary links (e.g. the admin/ops pages) so the top bar
 * stays a single clean row. Outside-click closes it (mirrors OrgSwitcher's pattern).
 */
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"

export function NavMenu({
  label,
  items,
}: {
  label: string
  items: readonly { to: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md px-3 py-1.5 text-neutral-600 text-sm hover:bg-neutral-100"
      >
        {label}
        <svg
          className="h-3 w-3 text-neutral-400"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-neutral-200 bg-white py-1 shadow-md">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 text-neutral-700 text-sm hover:bg-neutral-50"
              activeProps={{
                className: "block px-3 py-1.5 bg-neutral-100 font-medium text-neutral-900 text-sm",
              }}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

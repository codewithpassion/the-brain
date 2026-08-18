/**
 * Nav glyphs (UI v2) — a tiny hand-drawn 16px stroke set for the sidebar. `currentColor` +
 * consistent 1.5 stroke so every theme colors them through text utilities. No icon dependency.
 */
import type { ReactNode } from "react"

const glyph = (children: ReactNode) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4 shrink-0"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const ICONS = {
  search: glyph(
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M13.5 13.5 10 10" />
    </>,
  ),
  documents: glyph(
    <>
      <path d="M4 1.75h5.5L12.5 5v9.25h-8.5z" />
      <path d="M9.25 1.75V5h3.25" />
    </>,
  ),
  wiki: glyph(
    <>
      <path d="M2.5 2.75c1.8-.9 3.7-.9 5.5 0v10.5c-1.8-.9-3.7-.9-5.5 0z" />
      <path d="M13.5 2.75c-1.8-.9-3.7-.9-5.5 0v10.5c1.8-.9 3.7-.9 5.5 0z" />
    </>,
  ),
  memory: glyph(
    <>
      <path d="M8 1.75 14.25 5 8 8.25 1.75 5z" />
      <path d="M1.75 8.5 8 11.75l6.25-3.25" />
      <path d="M1.75 11.5 8 14.75l6.25-3.25" />
    </>,
  ),
  graph: glyph(
    <>
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="7" cy="12.5" r="2" />
      <path d="M5.8 4.9 10.2 5.6M5 10.8 4.4 6M8.5 11.2l2.4-3.4" />
    </>,
  ),
  sessions: glyph(
    <>
      <path d="M2 3.5h12v7.5H8.5L5 13.75V11H2z" />
      <path d="M5 6.5h6M5 8.5h4" />
    </>,
  ),
  add: glyph(
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 5.25v5.5M5.25 8h5.5" />
    </>,
  ),
  stats: glyph(<path d="M3 13.5V9M8 13.5V4.5M13 13.5V7M1.5 13.5h13" />),
  members: glyph(
    <>
      <circle cx="5.5" cy="5.5" r="2.25" />
      <path d="M1.75 13.5c.5-2.6 1.9-3.9 3.75-3.9s3.25 1.3 3.75 3.9" />
      <circle cx="11.5" cy="5" r="1.75" />
      <path d="M11 9.4c1.9 0 3 1.2 3.4 3.3" />
    </>,
  ),
  keys: glyph(
    <>
      <circle cx="5" cy="11" r="3.25" />
      <path d="M7.4 8.6 13.5 2.5M11 5l2 2M9 7l1.5 1.5" />
    </>,
  ),
  vault: glyph(
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <circle cx="8" cy="8" r="3" />
      <path d="M8 6.25V8l1.25.75" />
    </>,
  ),
  notion: glyph(
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 11V5l5 6V5" />
    </>,
  ),
  audit: glyph(
    <>
      <path d="M4 1.75h8v12.5H4z" />
      <path d="M6 5h4M6 7.5h4M6 10h2.5" />
    </>,
  ),
  jobs: glyph(
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>,
  ),
  dreams: glyph(<path d="M13.25 9.5A5.75 5.75 0 1 1 6.5 2.75a4.5 4.5 0 0 0 6.75 6.75z" />),
  facts: glyph(<path d="M8 1.75 9.5 6 14 7.5 9.5 9 8 13.25 6.5 9 2 7.5 6.5 6z" />),
  chevron: glyph(<path d="M6 3.5 10.5 8 6 12.5" />),
  folder: glyph(
    <path d="M2 4.25c0-.55.45-1 1-1h3l1.5 1.75H13c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z" />,
  ),
  page: glyph(
    <>
      <path d="M4 1.75h5.5L12.5 5v9.25h-8.5z" />
      <path d="M9.25 1.75V5h3.25" />
    </>,
  ),
} as const

export type IconName = keyof typeof ICONS

/**
 * /wiki/$ (W4a) — a single wiki/entity page in VIEW mode. Splat route (slugs are multi-segment, e.g.
 * `entities/person/ada-lovelace`), mirroring memory.$.tsx.
 *
 * Handles three shapes from `wiki_get_page`:
 *  • a real page → breadcrumbs, meta, tags, rendered markdown (with [[wikilink]] resolution), plus
 *    backlinks / entity sections / timeline / history panels;
 *  • a STUB (entity slug with no page yet: `stub:true`, empty `page.id`) → entity sections + a
 *    "Create this page" affordance. Never treats the empty id as a real page (no backlinks on "");
 *  • not found (`page:null`) → a not-found notice.
 */
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { Markdown } from "../components/Markdown"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { diffLines } from "../lib/linediff"
import { wikiGetPage, wikiPageHistory } from "../server/fns"
import type { WikiEntitySection, WikiPageDetail, WikiRevisionFull } from "../server/types"

export const Route = createFileRoute("/wiki/$")({
  loader: async ({ params }) => ({
    result: await wikiGetPage({ data: { target: params._splat ?? "" } }),
  }),
  component: WikiPageView,
})

function WikiPageView() {
  const slug = Route.useParams()._splat ?? ""
  const { result } = Route.useLoaderData()

  if (!result.ok) {
    return (
      <div className="flex flex-col gap-4">
        <BackHome />
        <p className="text-red-600 text-sm">Error loading page: {result.error}</p>
      </div>
    )
  }
  const detail = result.data.page
  if (detail === null) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs slug={slug} />
        <Card>
          <CardContent className="py-8">
            <p className="text-neutral-600 text-sm">
              Page <span className="font-mono">{slug}</span> not found.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }
  const isStub = detail.stub === true || detail.page.id === ""
  return isStub ? (
    <StubView slug={slug} detail={detail} />
  ) : (
    <PageView slug={slug} detail={detail} />
  )
}

// ── Real page ──────────────────────────────────────────────────────────────────────────

function PageView({ slug, detail }: { slug: string; detail: WikiPageDetail }) {
  const { page, body, tags, backlinks, timeline, revisions, links, entity } = detail
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <Breadcrumbs slug={slug} />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-semibold text-2xl tracking-tight">{page.title || page.slug}</h1>
          <Badge variant="secondary">{page.type}</Badge>
          <Badge variant={page.visibility === "private" ? "warning" : "outline"}>
            {page.visibility}
          </Badge>
          {page.ingestedVia && page.ingestedVia !== "wiki" && (
            <Badge variant="outline">{page.ingestedVia}</Badge>
          )}
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Link
                key={t}
                to="/wiki"
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600 text-xs hover:bg-neutral-200"
              >
                #{t}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <Card>
        <CardContent className="py-5">
          {body.trim() === "" ? (
            <p className="text-neutral-400 text-sm">This page has no body yet.</p>
          ) : (
            <Markdown body={body} pending={links.pending} />
          )}
        </CardContent>
      </Card>

      {entity && <EntitySections entity={entity} />}
      <Backlinks backlinks={backlinks} pending={links.pending} />
      <Timeline timeline={timeline} />
      <History slug={page.slug} revisions={revisions} />
    </div>
  )
}

// ── Entity stub (no page yet) ────────────────────────────────────────────────────────────

function StubView({ slug, detail }: { slug: string; detail: WikiPageDetail }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <Breadcrumbs slug={slug} />
        <h1 className="mt-1 font-semibold text-2xl tracking-tight">
          {detail.entity?.canonicalName || slug}
        </h1>
        <p className="mt-1 text-neutral-500 text-sm">
          No page exists for this entity yet — its live graph sections are shown below.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-6">
          <p className="text-neutral-600 text-sm">
            Create a page to add an agent- or human-authored summary. (Editing lands in the next
            phase; for now this is a read-only view.)
          </p>
          <span className="cursor-not-allowed rounded-md bg-neutral-200 px-4 py-2 font-medium text-neutral-500 text-sm">
            + Create this page (coming in edit mode)
          </span>
        </CardContent>
      </Card>
      {detail.entity && <EntitySections entity={detail.entity} />}
    </div>
  )
}

// ── Panels ───────────────────────────────────────────────────────────────────────────────

function EntitySections({ entity }: { entity: WikiEntitySection }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Entity · {entity.kind} · <span className="font-normal">{entity.canonicalName}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h4 className="mb-1 font-semibold text-neutral-500 text-xs uppercase tracking-wide">
            Relations ({entity.relations.length})
          </h4>
          {entity.relations.length === 0 ? (
            <p className="text-neutral-400 text-sm">No relations.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {entity.relations.map((r) => (
                <li key={`${r.direction}-${r.kind}-${r.entityId}`} className="text-sm">
                  <span className="text-neutral-400">{r.direction === "out" ? "→" : "←"}</span>{" "}
                  <span className="text-neutral-500">{r.kind}</span>{" "}
                  <Link
                    to="/wiki/$"
                    params={{ _splat: r.slug }}
                    className="text-blue-700 hover:underline"
                  >
                    {r.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-1 font-semibold text-neutral-500 text-xs uppercase tracking-wide">
            Mentions ({entity.mentions.length})
          </h4>
          {entity.mentions.length === 0 ? (
            <p className="text-neutral-400 text-sm">No mentions.</p>
          ) : (
            <p className="text-neutral-500 text-sm">
              Referenced by {entity.mentions.length} source
              {entity.mentions.length === 1 ? "" : "s"} across the corpus.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Backlinks({
  backlinks,
  pending,
}: {
  backlinks: WikiPageDetail["backlinks"]
  pending: string[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Backlinks ({backlinks.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {backlinks.length === 0 ? (
          <p className="text-neutral-400 text-sm">Nothing links here yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {backlinks.map((b, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: (fromId,linkType) can repeat; index disambiguates
              <li key={`${b.fromId}-${b.linkType}-${i}`} className="text-sm">
                {b.fromSlug ? (
                  <Link
                    to="/wiki/$"
                    params={{ _splat: b.fromSlug }}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {b.fromTitle || b.fromSlug}
                  </Link>
                ) : (
                  <Badge variant="outline">{b.linkType}</Badge>
                )}{" "}
                {b.context && <span className="text-neutral-500">— {b.context}</span>}
              </li>
            ))}
          </ul>
        )}
        {pending.length > 0 && (
          <p className="mt-3 border-neutral-100 border-t pt-2 text-neutral-400 text-xs">
            {pending.length} outbound red link{pending.length === 1 ? "" : "s"} awaiting creation.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function Timeline({ timeline }: { timeline: WikiPageDetail["timeline"] }) {
  if (timeline.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline ({timeline.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {timeline.map((t) => (
            <li key={t.id} className="text-sm">
              <span className="font-mono text-neutral-400 text-xs">{t.date.slice(0, 10)}</span>{" "}
              <span className="text-neutral-700">{t.summary}</span>
              {t.detail && <span className="text-neutral-500"> — {t.detail}</span>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** Author label: a `system`/dream revision (null or "system" authorUserId) shows as an agent badge. */
function AuthorBadge({ authorUserId }: { authorUserId: string | null }) {
  if (authorUserId === null || authorUserId === "system") {
    return <Badge variant="secondary">🤖 dream/agent</Badge>
  }
  return <Badge variant="outline">{authorUserId.slice(0, 12)}</Badge>
}

/**
 * History panel. The revision LIST (version, author, reason, date) comes free from `wiki_get_page`.
 * "Load diffs" fetches `wiki_page_history` (bodies) once, then each revision (except the oldest) can
 * expand to a unified line-diff vs the version before it. Bodies stay gated server-side.
 */
function History({ slug, revisions }: { slug: string; revisions: WikiPageDetail["revisions"] }) {
  const [bodies, setBodies] = useState<WikiRevisionFull[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)

  const loadBodies = async () => {
    setLoading(true)
    setError(null)
    const res = await wikiPageHistory({ data: { target: slug } })
    setLoading(false)
    if (!res.ok) return setError(res.error)
    if (res.data.revisions === null) return setError("History is not available for this page.")
    setBodies(res.data.revisions)
  }

  const bodyByVersion = new Map<number, string>((bodies ?? []).map((r) => [r.version, r.body]))

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>History ({revisions.length})</CardTitle>
        {revisions.length > 1 && bodies === null && (
          <Button variant="outline" size="sm" onClick={loadBodies} disabled={loading}>
            {loading ? "Loading…" : "Load diffs"}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {error !== null && <p className="mb-2 text-red-600 text-sm">{error}</p>}
        {revisions.length === 0 ? (
          <p className="text-neutral-400 text-sm">No revisions.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {revisions.map((r) => {
              const prevBody = bodyByVersion.get(r.version - 1)
              const thisBody = bodyByVersion.get(r.version)
              const canDiff = bodies !== null && thisBody !== undefined && prevBody !== undefined
              const isOpen = openId === r.revisionId
              return (
                <li key={r.revisionId} className="py-1.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="w-10 shrink-0 font-mono text-neutral-400 text-xs">
                      v{r.version}
                    </span>
                    <span className="shrink-0">
                      <AuthorBadge authorUserId={r.authorUserId} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-neutral-600">
                      {r.reason ?? "—"}
                    </span>
                    <span className="hidden shrink-0 text-neutral-400 text-xs sm:inline">
                      {r.createdAt.slice(0, 10)}
                    </span>
                    {canDiff && (
                      <button
                        type="button"
                        onClick={() => setOpenId(isOpen ? null : r.revisionId)}
                        className="shrink-0 text-blue-700 text-xs hover:underline"
                      >
                        {isOpen ? "hide diff" : "diff"}
                      </button>
                    )}
                  </div>
                  {isOpen && thisBody !== undefined && prevBody !== undefined && (
                    <DiffView oldBody={prevBody} newBody={thisBody} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** A unified line diff (removed = red, added = green) between two revision bodies. */
function DiffView({ oldBody, newBody }: { oldBody: string; newBody: string }) {
  const lines = diffLines(oldBody, newBody)
  return (
    <pre className="mt-2 overflow-x-auto rounded-md border border-neutral-100 bg-neutral-50 p-3 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows have no stable id
          key={i}
          className={
            l.type === "add"
              ? "bg-green-50 text-green-800"
              : l.type === "del"
                ? "bg-red-50 text-red-800"
                : "text-neutral-500"
          }
        >
          {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
          {l.text || " "}
        </div>
      ))}
    </pre>
  )
}

// ── Bits ─────────────────────────────────────────────────────────────────────────────────

function Breadcrumbs({ slug }: { slug: string }) {
  const segments = slug.split("/").filter((s) => s.length > 0)
  let acc = ""
  return (
    <nav
      className="flex flex-wrap items-center gap-1 text-neutral-400 text-xs"
      aria-label="Breadcrumb"
    >
      <Link to="/wiki" className="hover:text-neutral-700 hover:underline">
        wiki
      </Link>
      {segments.map((seg, i) => {
        acc = acc === "" ? seg : `${acc}/${seg}`
        const isLast = i === segments.length - 1
        return (
          <span key={acc} className="flex items-center gap-1">
            <span>/</span>
            {isLast ? (
              <span className="text-neutral-600">{seg}</span>
            ) : (
              <Link
                to="/wiki/$"
                params={{ _splat: acc }}
                className="hover:text-neutral-700 hover:underline"
              >
                {seg}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}

function BackHome() {
  return (
    <Link to="/wiki" className="text-neutral-500 text-sm hover:underline">
      ← Wiki
    </Link>
  )
}

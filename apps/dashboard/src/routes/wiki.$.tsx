/**
 * /wiki/$ (W4a) — a single wiki/entity page in VIEW mode. Splat route (slugs are multi-segment, e.g.
 * `entities/person/ada-lovelace`), mirroring memory.$.tsx.
 *
 * Handles three shapes from `wiki_get_page`:
 *  • a real page → breadcrumbs, meta, tags, rendered markdown (with [[wikilink]] resolution), plus
 *    backlinks / entity sections / timeline / history panels;
 *  • a STUB (entity slug with no page yet: `stub:true`, empty `page.id`) → entity sections + a
 *    "Create this page" affordance. Never treats the empty id as a real page (no backlinks on "");
 *  • not found (`page:null`) → if descendant pages exist under the slug, a NAMESPACE landing view
 *    (child listing + a secondary "create a page here" link); otherwise the not-found + create card.
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { WikiEditor, type WikiEditorInitial } from "../components/editor/WikiEditor"
import { Markdown } from "../components/Markdown"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { downloadBundle } from "../lib/download-bundle"
import { diffLines } from "../lib/linediff"
import {
  wikiExportBundle,
  wikiGetPage,
  wikiListPages,
  wikiPageHistory,
  wikiSavePage,
} from "../server/fns"
import type {
  WikiEntitySection,
  WikiListEntry,
  WikiPageDetail,
  WikiRevisionFull,
} from "../server/types"

/** Editor initial state from an existing page's detail (edit mode). */
const editInitial = (detail: WikiPageDetail): WikiEditorInitial => ({
  slug: detail.page.slug,
  type: detail.page.type,
  title: detail.page.title,
  tags: detail.tags,
  body: detail.body,
  visibility: detail.page.visibility,
  draft: detail.frontmatter?.draft === true,
})

/**
 * Entity pages are minted through the entity path (inheriting the entity's `{world,team}` tier +
 * graph linkage) — creating one ad-hoc through the generic editor would write a `private`,
 * `entity_id`-less page at an `entities/…` slug (a W2 violation that collides with later minting).
 * So the generic create flow is refused for `entities/…` slugs, both here and on the not-found path.
 */
const isEntitySlug = (slug: string) => slug.startsWith("entities/")

/** Page metadata carried into the History panel so a rollback re-save preserves it (never wipes it). */
interface PageMetaSnapshot {
  title: string
  tags: string[]
  draft: boolean
  description?: string
}

/** Editor initial state for a brand-new page at `slug` (create mode). */
const createInitial = (slug: string, detail: WikiPageDetail | null): WikiEditorInitial => {
  const isEntity = slug.startsWith("entities/")
  const last = slug.split("/").filter(Boolean).pop() ?? slug
  return {
    slug,
    type: isEntity ? "entity" : "note",
    title: detail?.entity?.canonicalName ?? last,
    tags: [],
    body: "",
    visibility: "private", // create defaults to private (WikiEditor omits unless changed)
    draft: false,
  }
}

export const Route = createFileRoute("/wiki/$")({
  validateSearch: (s: Record<string, unknown>): { new?: boolean } => ({
    new: s.new === true || s.new === "1" || s.new === 1,
  }),
  loader: async ({ params }) => {
    const target = params._splat ?? ""
    const result = await wikiGetPage({ data: { target } })
    // Namespace-landing data: only when the slug resolves to NO page (page:null) do we probe the
    // tree for descendant pages under `<slug>/`. Non-empty → render a namespace listing instead of
    // the not-found/create state. (Skipped for real pages + the empty splat — no wasted API call.)
    let descendants: WikiListEntry[] | null = null
    if (result.ok && result.data.page === null && target !== "") {
      const listed = await wikiListPages({ data: { namespacePrefix: target } })
      if (listed.ok) descendants = listed.data.pages
    }
    return { result, descendants }
  },
  component: WikiPageView,
})

function WikiPageView() {
  const slug = Route.useParams()._splat ?? ""
  const { result, descendants } = Route.useLoaderData()
  const search = Route.useSearch()
  const [mode, setMode] = useState<"view" | "edit" | "create">(search.new ? "create" : "view")

  if (!result.ok) {
    return (
      <div className="flex flex-col gap-4">
        <BackHome />
        <p className="text-danger text-sm">Error loading page: {result.error}</p>
      </div>
    )
  }
  const detail = result.data.page
  const isStub = detail !== null && (detail.stub === true || detail.page.id === "")

  // ── Create / edit modes ──
  if (mode === "create") {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <Breadcrumbs slug={slug} />
        <h1 className="font-semibold text-xl tracking-tight">Create page</h1>
        {isEntitySlug(slug) ? (
          <Card>
            <CardContent className="py-6">
              <EntityMintNote />
            </CardContent>
          </Card>
        ) : (
          <WikiEditor
            mode="create"
            initial={createInitial(slug, detail)}
            onCancel={() => setMode("view")}
            onSaved={() => setMode("view")}
          />
        )}
      </div>
    )
  }
  if (mode === "edit" && detail !== null && !isStub) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <Breadcrumbs slug={slug} />
        <h1 className="font-semibold text-xl tracking-tight">
          Editing <span className="font-mono text-base">{detail.page.slug}</span>
        </h1>
        <WikiEditor
          mode="edit"
          initial={editInitial(detail)}
          onCancel={() => setMode("view")}
          onSaved={() => setMode("view")}
        />
      </div>
    )
  }

  // ── View modes ──
  if (detail === null) {
    // A namespace-only node (no page of its own, but descendant pages exist) → landing listing,
    // not the not-found state. A truly empty slug keeps the not-found + create card unchanged.
    if (descendants !== null && descendants.length > 0) {
      return (
        <NamespaceView slug={slug} descendants={descendants} onCreate={() => setMode("create")} />
      )
    }
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs slug={slug} />
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-muted text-sm">
              Page <span className="font-mono">{slug}</span> not found.
            </p>
            {isEntitySlug(slug) ? (
              <EntityMintNote />
            ) : (
              <Button onClick={() => setMode("create")}>+ Create this page</Button>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }
  return isStub ? (
    <StubView slug={slug} detail={detail} />
  ) : (
    <PageView slug={slug} detail={detail} onEdit={() => setMode("edit")} />
  )
}

// ── Real page ──────────────────────────────────────────────────────────────────────────

function PageView({
  slug,
  detail,
  onEdit,
}: {
  slug: string
  detail: WikiPageDetail
  onEdit: () => void
}) {
  const { page, body, tags, backlinks, timeline, revisions, links, entity } = detail
  // Only wiki-lane pages are editable here (memory pages edit via the Memory screen).
  const editable = page.ingestedVia === "wiki" || page.ingestedVia === "entity"
  // Snapshot of the current metadata so a rollback re-save preserves title/tags/draft/description.
  const description = detail.frontmatter?.description
  const currentMeta: PageMetaSnapshot = {
    title: page.title,
    tags,
    draft: detail.frontmatter?.draft === true,
    ...(typeof description === "string" ? { description } : {}),
  }
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
          <div className="ml-auto flex items-center gap-2">
            <ExportBundleButton namespace={slug.split("/")[0] ?? ""} />
            {editable && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
            )}
          </div>
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Link
                key={t}
                to="/wiki"
                className="rounded-full bg-raised px-2 py-0.5 text-muted text-xs hover:bg-accent/15 hover:text-accent"
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
            <p className="text-faint text-sm">This page has no body yet.</p>
          ) : (
            <Markdown body={body} pending={links.pending} />
          )}
        </CardContent>
      </Card>

      {entity && <EntitySections entity={entity} />}
      <Backlinks backlinks={backlinks} pending={links.pending} />
      <Timeline timeline={timeline} />
      <History
        slug={page.slug}
        pageType={page.type}
        editable={editable}
        revisions={revisions}
        current={currentMeta}
      />
    </div>
  )
}

/** "Share as bundle" — export a namespace as OKF and zip+download it client-side (W5/2a). */
function ExportBundleButton({ namespace }: { namespace: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    const res = await wikiExportBundle({ data: namespace ? { namespace } : {} })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    downloadBundle(res.data.files, namespace || "wiki")
  }
  return (
    <span className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={run}
        disabled={busy}
        title="Export this namespace as an OKF bundle (.zip)"
      >
        {busy ? "Exporting…" : "Export bundle"}
      </Button>
      {error !== null && <span className="text-danger text-xs">{error}</span>}
    </span>
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
        <p className="mt-1 text-muted text-sm">
          No page exists for this entity yet — its live graph sections are shown below.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-start gap-2 py-6">
          <p className="text-muted text-sm">This entity's live graph sections are shown below.</p>
          <p className="text-faint text-xs">
            Authoring a dedicated entity page (with the entity's tier + linkage) lands via the
            entity-mint path — creating one here would produce a mis-scoped, unlinked page.
          </p>
        </CardContent>
      </Card>
      {detail.entity && <EntitySections entity={detail.entity} />}
    </div>
  )
}

/** Why the generic create flow is refused for an `entities/…` slug (shown on create + not-found). */
function EntityMintNote() {
  return (
    <p className="text-muted text-sm">
      Entity pages are authored via the entity-mint path — inheriting the entity's tier and graph
      linkage. Creating one here would produce a mis-scoped, unlinked page.
    </p>
  )
}

// ── Namespace landing (no page at the slug, but descendants exist) ─────────────────────────

/** One DIRECT child under a namespace slug — a page, a sub-namespace, or a page that also nests. */
interface NamespaceChild {
  /** Full slug to link to (`<base>/<segment>`). */
  slug: string
  label: string
  /** Something sits deeper than `<base>/<segment>` (renders another namespace landing when opened). */
  isNamespace: boolean
  /** The page entry when a page exists exactly at `slug`; null for a pure sub-namespace. */
  entry: WikiListEntry | null
}

/**
 * Reduce the flat subtree listing (`wiki_list_pages` with `namespacePrefix=base` → every descendant
 * under `<base>/`) to its DIRECT children, grouped by the first path segment under `base`. A group is
 * a page when a descendant's slug equals `<base>/<seg>`, a namespace when anything sits deeper — it
 * can be both (a page that also nests). Mirrors the sidebar's namespaces-first, then alpha ordering.
 */
const directChildren = (base: string, descendants: WikiListEntry[]): NamespaceChild[] => {
  const prefix = `${base}/`
  const byKey = new Map<string, NamespaceChild>()
  for (const d of descendants) {
    if (!d.slug.startsWith(prefix)) continue // defensive: skip the base row / unrelated slugs
    const seg = d.slug.slice(prefix.length).split("/")[0] ?? ""
    if (seg === "") continue
    const childSlug = `${base}/${seg}`
    const isDirectPage = d.slug === childSlug
    const existing = byKey.get(seg)
    if (existing) {
      if (isDirectPage) {
        existing.entry = d
        existing.label = d.title || seg
      } else {
        existing.isNamespace = true
      }
    } else {
      byKey.set(seg, {
        slug: childSlug,
        label: isDirectPage ? d.title || seg : seg,
        isNamespace: !isDirectPage,
        entry: isDirectPage ? d : null,
      })
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const an = a.isNamespace ? 0 : 1
    const bn = b.isNamespace ? 0 : 1
    return an !== bn ? an - bn : a.label.localeCompare(b.label)
  })
}

function NamespaceView({
  slug,
  descendants,
  onCreate,
}: {
  slug: string
  descendants: WikiListEntry[]
  onCreate: () => void
}) {
  const items = directChildren(slug, descendants)
  const name = slug.split("/").filter(Boolean).pop() ?? slug
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <Breadcrumbs slug={slug} />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-semibold text-2xl tracking-tight">{name}</h1>
          <Badge variant="outline">namespace</Badge>
        </div>
        <p className="mt-1 text-muted text-sm">
          No page exists at this slug — it groups {items.length} child page
          {items.length === 1 ? "" : "s"}.
        </p>
      </div>
      <Card>
        <CardContent className="py-1">
          <ul className="flex flex-col divide-y divide-border">
            {items.map((it) => (
              <li key={it.slug}>
                <Link
                  to="/wiki/$"
                  params={{ _splat: it.slug }}
                  className="flex items-center gap-2 py-2 text-sm text-ink hover:text-accent"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {it.label}
                    {it.isNamespace && <span className="text-faint"> /…</span>}
                  </span>
                  {it.entry?.draft && <Badge variant="warning">draft</Badge>}
                  {it.entry ? (
                    <Badge variant="secondary">{it.entry.type}</Badge>
                  ) : (
                    <Badge variant="outline">namespace</Badge>
                  )}
                  {it.entry && (
                    <span className="hidden shrink-0 text-faint text-xs sm:inline">
                      {it.entry.updatedAt.slice(0, 10)}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {!isEntitySlug(slug) && (
        <button
          type="button"
          onClick={onCreate}
          className="self-start text-muted text-sm hover:text-accent hover:underline"
        >
          + Create a page at <span className="font-mono">{slug}</span>
        </button>
      )}
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
          <h4 className="mb-1 font-semibold text-muted text-xs uppercase tracking-wide">
            Relations ({entity.relations.length})
          </h4>
          {entity.relations.length === 0 ? (
            <p className="text-faint text-sm">No relations.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {entity.relations.map((r) => (
                <li key={`${r.direction}-${r.kind}-${r.entityId}`} className="text-sm">
                  <span className="text-faint">{r.direction === "out" ? "→" : "←"}</span>{" "}
                  <span className="text-muted">{r.kind}</span>{" "}
                  <Link
                    to="/wiki/$"
                    params={{ _splat: r.slug }}
                    className="text-accent hover:underline"
                  >
                    {r.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-1 font-semibold text-muted text-xs uppercase tracking-wide">
            Mentions ({entity.mentions.length})
          </h4>
          {entity.mentions.length === 0 ? (
            <p className="text-faint text-sm">No mentions.</p>
          ) : (
            <p className="text-muted text-sm">
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
          <p className="text-faint text-sm">Nothing links here yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {backlinks.map((b, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: (fromId,linkType) can repeat; index disambiguates
              <li key={`${b.fromId}-${b.linkType}-${i}`} className="text-sm">
                {b.fromSlug ? (
                  <Link
                    to="/wiki/$"
                    params={{ _splat: b.fromSlug }}
                    className="font-medium text-accent hover:underline"
                  >
                    {b.fromTitle || b.fromSlug}
                  </Link>
                ) : (
                  <Badge variant="outline">{b.linkType}</Badge>
                )}{" "}
                {b.context && <span className="text-muted">— {b.context}</span>}
              </li>
            ))}
          </ul>
        )}
        {pending.length > 0 && (
          <p className="mt-3 border-border border-t pt-2 text-faint text-xs">
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
              <span className="font-mono text-faint text-xs">{t.date.slice(0, 10)}</span>{" "}
              <span className="text-muted">{t.summary}</span>
              {t.detail && <span className="text-muted"> — {t.detail}</span>}
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
function History({
  slug,
  pageType,
  editable,
  revisions,
  current,
}: {
  slug: string
  pageType: string
  editable: boolean
  revisions: WikiPageDetail["revisions"]
  current: PageMetaSnapshot
}) {
  const router = useRouter()
  const [bodies, setBodies] = useState<WikiRevisionFull[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<number | null>(null)
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

  // Rollback = save an older revision's body as a NEW revision (client-side; no rollback op needed).
  // `wiki_save_page` is a full upsert, so we MUST resend the page's current metadata — title, tags,
  // draft, description — or they'd be wiped. Visibility is OMITTED so the page keeps its current tier.
  const restore = async (version: number, body: string) => {
    setRestoring(version)
    setError(null)
    const res = await wikiSavePage({
      data: {
        slug,
        type: pageType,
        body,
        title: current.title,
        tags: current.tags,
        draft: current.draft,
        ...(current.description !== undefined ? { description: current.description } : {}),
      },
    })
    setRestoring(null)
    if (!res.ok) return setError(res.error)
    await router.invalidate()
    setBodies(null) // force a fresh diff load against the new head
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
        {error !== null && <p className="mb-2 text-danger text-sm">{error}</p>}
        {revisions.length === 0 ? (
          <p className="text-faint text-sm">No revisions.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {revisions.map((r) => {
              const prevBody = bodyByVersion.get(r.version - 1)
              const thisBody = bodyByVersion.get(r.version)
              const canDiff = bodies !== null && thisBody !== undefined && prevBody !== undefined
              const isOpen = openId === r.revisionId
              return (
                <li key={r.revisionId} className="py-1.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="w-10 shrink-0 font-mono text-faint text-xs">v{r.version}</span>
                    <span className="shrink-0">
                      <AuthorBadge authorUserId={r.authorUserId} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted">{r.reason ?? "—"}</span>
                    <span className="hidden shrink-0 text-faint text-xs sm:inline">
                      {r.createdAt.slice(0, 10)}
                    </span>
                    {canDiff && (
                      <button
                        type="button"
                        onClick={() => setOpenId(isOpen ? null : r.revisionId)}
                        className="shrink-0 text-accent text-xs hover:underline"
                      >
                        {isOpen ? "hide diff" : "diff"}
                      </button>
                    )}
                    {editable && thisBody !== undefined && (
                      <button
                        type="button"
                        onClick={() => restore(r.version, thisBody)}
                        disabled={restoring !== null}
                        className="shrink-0 text-muted text-xs hover:text-ink hover:underline"
                      >
                        {restoring === r.version ? "restoring…" : "restore"}
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
    <pre className="mt-2 overflow-x-auto rounded-ui border border-border bg-raised p-3 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows have no stable id
          key={i}
          className={
            l.type === "add"
              ? "bg-ok/10 text-ok"
              : l.type === "del"
                ? "bg-danger/10 text-danger"
                : "text-muted"
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
    <nav className="flex flex-wrap items-center gap-1 text-faint text-xs" aria-label="Breadcrumb">
      <Link to="/wiki" className="hover:text-muted hover:underline">
        wiki
      </Link>
      {segments.map((seg, i) => {
        acc = acc === "" ? seg : `${acc}/${seg}`
        const isLast = i === segments.length - 1
        return (
          <span key={acc} className="flex items-center gap-1">
            <span>/</span>
            {isLast ? (
              <span className="text-muted">{seg}</span>
            ) : (
              <Link
                to="/wiki/$"
                params={{ _splat: acc }}
                className="hover:text-muted hover:underline"
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
    <Link to="/wiki" className="text-muted text-sm hover:underline">
      ← Wiki
    </Link>
  )
}

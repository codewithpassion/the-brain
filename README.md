# The Brain — Cloudflare-native multi-tenant memory platform

A unified, multi-tenant "company brain" memory platform built entirely on Cloudflare primitives
(Workers, D1, R2, Vectorize V2, Workers AI, AI Gateway, Workflows, Queues, KV, Durable Objects —
**no Convex**). It fuses the best of three existing projects:

- **gbrain-cf** — cited synthesis (`think`), hybrid search, hot-fact memory, typed graph
- **openbrains** — multi-tenant isolation, trust grades, audit/recall traces
- **cf-graph** — durable, resumable document ingestion + knowledge-graph extraction

## Status

Specification phase. The PRD was hardened over **8 adversarial review→integrate rounds**
(three lenses: Cloudflare-primitive correctness, completeness/consistency, multi-tenant
security/isolation), landing at **78/100** — cf-correctness 83 / completeness 79 / security 71,
all "accept-with-changes". v1 is right-sized to the confirmed target: **1–2 tenants** (internal
dogfood), single D1, horizontal scale-out deferred to Phase-N, Clerk auth, Workers Paid plan,
`MONTHLY_COST_CEILING_USD = 400`.

This is a **draft for human architectural review** — the next step is building the v1 skeleton
against it and measuring real numbers, not more automated review.

## Read this first

- **`brain-platform-PRD.html`** — the full PRD + layered architecture (rendered; open in a browser)
- **`brain-platform-review-history.html`** — the 8-round review journey, scores, and remaining items
- **`memory-systems-report.html`** — the original analysis comparing the three source projects

## Layout

```
the-brain/
  PRD.md                          assembled PRD (source of truth, markdown)
  brain-platform-PRD.html         rendered PRD
  brain-platform-review-history.html   rendered review journey
  memory-systems-report.html      original 3-project comparison
  sources/                        per-section markdown the PRD is assembled from
    s01.md … s10.md, appendix.md  the 10 sections + appendix
    coderefs.json                 per-section "code references" (cited source files)
  scripts/                        deterministic build tooling (Python, uses `markdown`)
    build.py                      sources/ + coderefs.json  ->  PRD.md
    convert.py                    PRD.md  ->  brain-platform-PRD.html
    build_journey_html.py         reviews/iter8.json  ->  brain-platform-review-history.html
  reviews/                        adversarial-review data per round (iter4–iter8.json)
  workflows/                      the multi-agent orchestration scripts that produced this
    brain-platform.workflow.js    initial analyze -> plan -> PRD -> harden
    loop4–loop8.workflow.js       the review/integration loops
```

## Regenerate

The HTML is generated from the markdown; edit `sources/*.md`, then:

```bash
cd scripts
python3 build.py          # reassemble sources/ -> PRD.md
python3 convert.py        # PRD.md -> brain-platform-PRD.html   (needs: pip install markdown)
python3 build_journey_html.py   # reviews/iter8.json -> review history
```

Paths are resolved relative to the script location, so the folder is portable.

## Source projects (cited throughout the PRD)

- `~/devel/gbrain-cf`
- `~/devel/openbrains`
- `~/devel/cf-graph`

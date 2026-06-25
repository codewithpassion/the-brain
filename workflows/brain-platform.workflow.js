export const meta = {
  name: 'brain-platform-prd',
  description: 'Deep-analyze cf-graph/gbrain-cf/openbrains, design a CF-native unified multi-tenant memory platform (no Convex), write a cited PRD + layered architecture, harden it over 3 scored adversarial review loops, and emit HTML reports',
  phases: [
    { title: 'Analyze' },
    { title: 'Research' },
    { title: 'Plan' },
    { title: 'PlanReview' },
    { title: 'PRD' },
    { title: 'Harden' },
    { title: 'Report' },
  ],
}

const j = (o) => JSON.stringify(o)

const SEED = `Three existing projects to mine (read their real code; verify paths):
- cf-graph (/home/roboto/devel/cf-graph): Cloudflare Workers doc + knowledge-graph engine. D1 + R2 + Vectorize + Workers AI (embed bge-m3 1024d, llama-3.1-8b). Durable Cloudflare Workflows for ingestion (apps/graph/src/api/workflows/ingestion.ts, kg-extraction.ts). Hybrid search vector+FTS5+RRF (apps/graph/src/api/search/rrf.ts, fts.ts; services/documents.ts, knowledge-graph.ts). Schema apps/graph/src/api/db/schema.ts. cfg CLI (apps/cli) + MCP Durable Object (apps/graph/src/mcp/). Workspaces + per-user app-level scoping, API keys, read-only MCP.
- gbrain-cf (/home/roboto/devel/gbrain-cf): GBrain reimplementation, single Cloudflare Worker MCP server (47 tools). D1 + Vectorize (gbrain-chunks 1024d bge-m3) + Workers AI (gen llama-3.3-70b). Markdown-first pages, page_versions, typed link graph + BFS traverse_graph (depth 10), facts hot-memory (extract_facts/recall/forget_fact, typed/confidence/notability/visibility/validity), think op = hybrid search + LLM query expansion + synthesis + slug citations + gap/no-evidence reporting (src/ops/search.ts, src/search.ts, src/ai.ts, src/ops/facts.ts). OAuth2.1 via Clerk + machine tokens. Cron job runner (jobs table), GitHub source sync (src/sync.ts), webhook /ingest. Migrations migrations/0001_init.sql..0009_sync.sql. SINGLE-TENANT (no per-user RLS).
- openbrains (/home/roboto/devel/openbrains): multi-tenant governed memory. Backend is Convex (DO NOT REUSE CONVEX in the new project) + Vectorize (thoughts-v1, namespace=userId, V2) + Workers AI (qwen3-embedding-0.6b 1024d). STRICT per-user isolation: requireUserId (packages/convex/convex/_lib/identity.ts) + namespace=userId enforced in VectorizeClient (packages/services/src/deps/vectorize.ts). Trust grades instruction/evidence/draft (packages/convex/convex/memory/writeback.ts, recall.ts), memory_audit + memory_recall_traces, projects/scope (Phase H), entity graph (entities/entity_mentions/entity_relations), brain-dump split, importer interface + Gmail + OB1 importers (packages/ingest/src/sources/). MCP server apps/mcp (25 tools) + CLI ob + dashboard (apps/dashboard, TanStack Start + shadcn). Schema packages/convex/convex/schema.ts. Internal-secret trust boundary (X-OpenBrains-Internal-Secret) for Convex<->Worker.

THE NEW PROJECT ("Brain Platform"): a unified, MULTI-TENANT company-brain memory platform built ENTIRELY on Cloudflare primitives (NO Convex). It must combine: document loading/ingestion, vector embedding + semantic search, hybrid search + reranking, graph extraction + traversal, a multi-tenant company brain (users/teams/clients with enforced isolation + trust grades + audit), backfilling workflows, and an easy way to store sessions from multiple sources, users, and teams. Same shape as the existing projects (CF Workers backend, a frontend, an MCP server). Frontend default: TanStack Start + shadcn on Workers.`

const COMPONENTS = [
  { key: 'ingestion', title: 'Document loading & ingestion', focus: 'How each project loads/parses/normalizes content (PDF/DOCX/HTML/CSV/markdown/json), text extraction (Workers AI toMarkdown), chunking strategy + params, dedup/fingerprint, pre-chunked ingest, webhook/source-sync ingest. What to grab; how to build CF-native.' },
  { key: 'embedding', title: 'Vector embedding & semantic search', focus: 'Embedding models/dims, Vectorize index design, namespaces, metadata indexes, upsert/query patterns, staleness tracking, re-embedding/migration across models, thresholds. Recommend ONE embedding strategy for the unified platform.' },
  { key: 'hybrid', title: 'Hybrid search & reranking', focus: 'Keyword (FTS5/bm25) + vector fusion (RRF), boosts, query expansion, top-k, and the missing rerank stage. Design the unified hybrid+rerank+cited-synthesis (think) pipeline.' },
  { key: 'graph', title: 'Graph extraction & traversal', focus: 'Entity/relationship extraction (LLM), typed links, backlinks, BFS traversal, tags, timeline, orphan detection, dedup. Reconcile cf-graph KG-from-docs vs gbrain typed-links vs openbrains entity graph into one model.' },
  { key: 'tenancy', title: 'Multi-tenant company brain (scoping/RLS/trust/auth)', focus: 'Per-user/team/client isolation enforced at a single choke-point, Vectorize namespace strategy, RLS-on-D1 (since D1 has no native RLS), trust grades instruction/evidence/draft, audit + recall traces, auth (OAuth2.1 + machine tokens + API keys), token to identity to scope resolution. This is the hardest, security-critical part.' },
  { key: 'backfill', title: 'Backfilling workflows', focus: 'Turning existing history (old sessions, GitHub repos, docs, Gmail/OB1) into memory via durable, resumable Cloudflare Workflows + Queues; cursors, retries, idempotency, batching, embedding compatibility (bge-m3 vs qwen3 1024d). Design the backfill engine.' },
  { key: 'sessions', title: 'Session storage from multiple sources/users/teams', focus: 'How to capture and store conversation/session transcripts from multiple clients (Claude Code, Desktop, ChatGPT, CLI), promote durable facts (stop-hook semantics), short-term hot memory + long-term searchable, and frozen-snapshot injection — all scoped per user/team. Design the session-capture + promote/embed model.' },
]

const PRD_SECTIONS = [
  { key: 'overview', title: '1. Vision, Goals, Personas & Scope', focus: 'Product vision, goals/non-goals, target personas (solo power-user, team, multi-client agency), the four memory pillars (citations, injection, semantic search, scoping), success criteria.' },
  { key: 'architecture', title: '2. Layered Services Architecture', focus: 'A detailed services-layered architecture entirely on Cloudflare primitives. Define each layer (edge/API, MCP, orchestration/Workflows+Queues, services/domain, data/D1+Vectorize+R2+KV+DO, AI/Workers AI+AI Gateway). Component responsibilities, data-flow diagrams (ASCII), request lifecycles for capture/search/think/ingest/backfill. Cite which existing project each component derives from.' },
  { key: 'datamodel', title: '3. Data Model & Storage', focus: 'Full D1 schema (tables, columns, indexes, FTS5 virtual tables + triggers), Vectorize index design + namespaces + metadata, R2 layout, KV usage, Durable Objects usage. Include tenancy/owner/scope columns and trust-grade/audit tables. Provide CREATE TABLE-level detail. Cite the source schemas (cf-graph schema.ts, gbrain migrations, openbrains schema.ts).' },
  { key: 'ingestion', title: '4. Ingestion & Document Loading', focus: 'Ingestion pipeline as durable Cloudflare Workflows + Queues: parse/extract->chunk->embed->KG-extract->index. Multi-source connectors. Pre-chunked path. Idempotency/dedup. Cite cf-graph ingestion.ts/kg-extraction.ts.' },
  { key: 'search', title: '5. Embedding, Hybrid Search, Rerank & Cited Synthesis', focus: 'Embedding strategy, vector + FTS5 + RRF fusion, query expansion, a real rerank stage, and the think op (evidence-only synthesis with citations + gap/no-evidence). Cite gbrain search.ts/ops/search.ts/ai.ts and cf-graph rrf.ts/fts.ts.' },
  { key: 'graph', title: '6. Graph Extraction & Traversal', focus: 'Unified entity/relationship model, extraction, typed links/backlinks, BFS traversal, tags, timeline, dedup, orphan cleanup. Cite gbrain links/traverse_graph and cf-graph kg + openbrains entity tables.' },
  { key: 'tenancy', title: '7. Multi-Tenant Company Brain: Auth, Scoping, Trust & Audit', focus: 'Identity model (org/team/user/client), auth (OAuth2.1 + machine tokens + API keys), single choke-point isolation enforcement, Vectorize namespace strategy, application-level RLS on D1, trust grades, audit + recall traces, scope filtering. Cite openbrains identity.ts/vectorize.ts/writeback.ts/recall.ts and gbrain auth/oauth.' },
  { key: 'sessions', title: '8. Session Capture, Hot Memory & Backfill', focus: 'Multi-source/user/team session storage, stop-hook promote-to-fact + embed-everything loop, frozen-snapshot injection (soul/user/memory/today), and durable backfill Workflows for old sessions/repos/docs. Cite gbrain facts/recall + cf-graph workflows + openbrains importers.' },
  { key: 'api', title: '9. API, MCP Server, CLI & Frontend', focus: 'HTTP/tRPC API surface, MCP tool catalog (the unified tool set), CLI, and frontend/dashboard (TanStack Start + shadcn on Workers): routes, key screens (search/think, inspector/review, graph, audit, admin/tenancy). Cite gbrain 47-tool MCP, openbrains 25-tool MCP + dashboard routes, cf-graph cfg CLI + tRPC.' },
  { key: 'ops', title: '10. Deployment, Observability, Testing & Rollout', focus: 'wrangler.jsonc bindings, environments, secrets, cron triggers, migrations, observability (Analytics Engine/logs, mcp_request_log), test strategy (incl. isolation tests that prove cross-tenant access fails), and a phased rollout plan with milestones.' },
]

const COMPONENT_SCHEMA = {
  type: 'object',
  required: ['component', 'comparison', 'recommendation', 'fileReferences', 'risks'],
  additionalProperties: false,
  properties: {
    component: { type: 'string' },
    comparison: { type: 'string', description: 'Detailed markdown: how each of the 3 projects implements this, with concrete strengths/weaknesses and specifics (model names, params, table/function names).' },
    recommendation: { type: 'string', description: 'Markdown: exactly what to grab from where, and how to build it CF-native (no Convex) for the unified multi-tenant platform.' },
    fileReferences: { type: 'array', items: { type: 'object', required: ['project', 'path', 'provides'], additionalProperties: false, properties: { project: { type: 'string' }, path: { type: 'string' }, provides: { type: 'string' } } } },
    risks: { type: 'string', description: 'Markdown: integration risks, conflicts between the three approaches, and CF-primitive limits to respect.' },
  },
}

const CF_RESEARCH_SCHEMA = {
  type: 'object',
  required: ['services', 'summary'],
  additionalProperties: false,
  properties: {
    services: { type: 'array', items: { type: 'object', required: ['name', 'whatItIs', 'relevance', 'recommendation'], additionalProperties: false, properties: { name: { type: 'string' }, whatItIs: { type: 'string' }, relevance: { type: 'string' }, recommendation: { type: 'string' }, limitsOrGotchas: { type: 'string' }, sourceUrl: { type: 'string' } } } },
    summary: { type: 'string', description: 'Markdown summary of the recommended Cloudflare stack and notable recent capabilities (Vectorize metadata filtering, AutoRAG, AI Gateway, D1 read replication, DO SQLite storage, Queues, Workflows, Containers, Pipelines, Analytics Engine).' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['planMarkdown', 'keyDecisions', 'openQuestions'],
  additionalProperties: false,
  properties: {
    planMarkdown: { type: 'string', description: 'A detailed, structured implementation plan in markdown for the CF-native unified platform.' },
    keyDecisions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['lens', 'score', 'verdict', 'weaknesses', 'summary'],
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '0-100. Be harsh but fair. 100 = flawless and complete.' },
    verdict: { type: 'string', enum: ['accept', 'accept-with-changes', 'major-revision', 'reject'] },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'object', required: ['issue', 'severity', 'recommendation'], additionalProperties: false, properties: { issue: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, recommendation: { type: 'string' } } } },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const PRD_SECTION_SCHEMA = {
  type: 'object',
  required: ['section', 'contentMarkdown', 'codeReferences', 'openQuestions'],
  additionalProperties: false,
  properties: {
    section: { type: 'string' },
    contentMarkdown: { type: 'string', description: 'The full, detailed PRD section in markdown. Concrete: interfaces, schemas, pseudo-code, edge cases. Reference existing code inline as project:path.' },
    codeReferences: { type: 'array', items: { type: 'object', required: ['project', 'path', 'whatToReuse'], additionalProperties: false, properties: { project: { type: 'string' }, path: { type: 'string' }, whatToReuse: { type: 'string' } } } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  required: ['prdMarkdown', 'changelog', 'residualIssues'],
  additionalProperties: false,
  properties: {
    prdMarkdown: { type: 'string', description: 'The COMPLETE updated PRD markdown with all review fixes applied inline. Do NOT truncate or summarize; preserve every section, code reference, schema, and diagram, improving them.' },
    changelog: { type: 'array', items: { type: 'string' }, description: 'Each change made in response to a specific review finding.' },
    residualIssues: { type: 'array', items: { type: 'string' }, description: 'Findings consciously deferred, with rationale.' },
  },
}

// ---------- Analyze (components) + Research (CF) in parallel ----------
phase('Analyze')
const analysisPromises = COMPONENTS.map((c) => () =>
  agent(
    `You are a senior architect doing a deep, code-level analysis of ONE capability across three existing projects, to design a new unified CF-native platform.\n\nCAPABILITY: ${c.title}\nFOCUS: ${c.focus}\n\n${SEED}\n\nRead the actual source in all three repos for this capability. Be concrete (model names, dimensions, table/column names, function names, file paths, params). Compare the three approaches, then recommend exactly what to grab and how to build it Cloudflare-native (NO Convex) for a multi-tenant platform. Cite every relevant file as a fileReference. Return the structured object.`,
    { label: `analyze:${c.key}`, phase: 'Analyze', schema: COMPONENT_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
  )
)

phase('Research')
const researchPromise = () =>
  agent(
    `Research the CURRENT (2026) Cloudflare developer platform to recommend the best primitives for a multi-tenant AI memory platform. Use ToolSearch to load WebSearch and the Cloudflare docs search tool (mcp__cloudflare-docs__search_cloudflare_documentation), then research.\n\nCover at least: Workers, D1 (limits, read replication, batching), Vectorize (V2, dimensions, namespaces, metadata indexes/filtering, limits), R2 (+ R2 SQL / Data Catalog if relevant), Workers AI (current embedding + LLM models, rerank models if any), AI Gateway, AutoRAG, Durable Objects (SQLite storage), Workflows, Queues, KV, Containers, Hyperdrive, Pipelines, Analytics Engine, Workers OAuth provider. For each: what it is, relevance to this platform, a concrete recommendation, and limits/gotchas with a source URL. Then a summary recommending the stack. Return the structured object.`,
    { label: 'research:cloudflare', phase: 'Research', schema: CF_RESEARCH_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
  )

const analyzeResults = (await parallel([...analysisPromises, researchPromise])).filter(Boolean)
const cfResearch = analyzeResults.find((r) => r && r.services) || { services: [], summary: 'CF research unavailable.' }
const components = analyzeResults.filter((r) => r && r.component)
const componentsBrief = components.map((c) => ({ component: c.component, recommendation: c.recommendation, fileReferences: c.fileReferences }))
log(`Analyzed ${components.length} components; CF research found ${cfResearch.services.length} services.`)

// ---------- Plan ----------
phase('Plan')
const planV1 = await agent(
  `You are the lead architect. Synthesize a DETAILED implementation plan for the new CF-native, multi-tenant "Brain Platform" that unifies the best parts of cf-graph, gbrain-cf, and openbrains. NO Convex.\n\n${SEED}\n\nCOMPONENT ANALYSES (what to grab + file refs):\n${j(components)}\n\nCLOUDFLARE STACK RESEARCH:\n${j(cfResearch)}\n\nProduce a structured plan: the chosen CF stack, the layered architecture, data model direction, how each of the seven capabilities is delivered, the multi-tenant isolation approach, the session/backfill model, and a phased build order. Be concrete and opinionated. Return the structured object.`,
  { label: 'plan:synthesize', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'high' }
)
const planText = planV1 ? planV1.planMarkdown : 'PLAN MISSING'

// ---------- PlanReview (adversarial + integrate) ----------
phase('PlanReview')
const planReview = await agent(
  `You are a ruthless adversarial reviewer. Critically assess this implementation plan for a CF-native multi-tenant memory platform. Attack: CF-primitive feasibility/limits, multi-tenant isolation correctness, completeness vs the seven required capabilities, and over/under-engineering. Score 0-100. Set lens to "plan". Return the structured review.\n\nPLAN:\n${planText}`,
  { label: 'plan:review', phase: 'PlanReview', schema: REVIEW_SCHEMA, effort: 'high' }
)
const planV2 = await agent(
  `You are a fresh lead architect. Re-analyze the adversarial review below and integrate its valid findings into the plan, producing an improved plan. Reject any finding that is wrong, but justify rejections in residualIssues.\n\nORIGINAL PLAN:\n${planText}\n\nADVERSARIAL REVIEW:\n${j(planReview)}\n\nReturn the structured object (prdMarkdown = the revised PLAN markdown).`,
  { label: 'plan:integrate', phase: 'PlanReview', schema: INTEGRATE_SCHEMA, effort: 'high' }
)
const integratedPlan = planV2 ? planV2.prdMarkdown : planText
log(`Plan reviewed (score ${planReview ? planReview.score : 'n/a'}/100) and integrated.`)

// ---------- PRD (team writes sections, then assemble) ----------
phase('PRD')
const sectionResults = await parallel(
  PRD_SECTIONS.map((s) => () =>
    agent(
      `You are a PRD author on a team writing ONE section of a detailed PRD for the new CF-native, multi-tenant "Brain Platform". NO Convex.\n\nSECTION: ${s.title}\nFOCUS: ${s.focus}\n\n${SEED}\n\nINTEGRATED PLAN (authoritative direction):\n${integratedPlan}\n\nCOMPONENT RECOMMENDATIONS + FILE REFS:\n${j(componentsBrief)}\n\nCLOUDFLARE STACK:\n${j(cfResearch.summary)}\n\nWrite a thorough, concrete section: interfaces, schemas (SQL/TS types), pseudo-code, request flows, edge cases. CITE the existing code you reuse or adapt as project:path inline AND in codeReferences (verify the files exist by reading the repos when unsure). Return the structured object.`,
      { label: `prd:${s.key}`, phase: 'PRD', schema: PRD_SECTION_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
    )
  )
)
const sections = sectionResults.filter(Boolean)
const prdAssembled = await agent(
  `You are the PRD editor. Assemble these sections into ONE coherent, well-structured PRD markdown document for the CF-native multi-tenant "Brain Platform". Add a title, a table of contents, and ensure consistent heading levels and cross-references. Under each section preserve a "Code references" list (project:path - whatToReuse). Do not drop content; smooth transitions and remove duplication.\n\nSECTIONS:\n${j(sections)}\n\nReturn the structured object (prdMarkdown = the full assembled PRD; changelog = ['assembled N sections']; residualIssues = aggregated openQuestions).`,
  { label: 'prd:assemble', phase: 'PRD', schema: INTEGRATE_SCHEMA, effort: 'high' }
)
let curPRD = prdAssembled ? prdAssembled.prdMarkdown : sections.map((s) => `## ${s.section}\n\n${s.contentMarkdown}`).join('\n\n')
log(`PRD assembled from ${sections.length} sections.`)

// ---------- Harden (3 scored adversarial review -> integrate loops) ----------
phase('Harden')
const LENSES = [
  { key: 'cf-correctness', prompt: 'Cloudflare-primitive correctness & feasibility: are D1, Vectorize, R2, Durable Objects, Workflows, Queues, KV, Workers AI, AI Gateway used correctly and within real limits/quotas? Flag anything that cannot work on Cloudflare, misuses a primitive, ignores limits, or where a better primitive exists. Verify the architecture is actually buildable.' },
  { key: 'completeness', prompt: 'Requirements coverage & completeness: does the PRD fully and concretely deliver document ingestion, embedding + semantic search, hybrid search + rerank, graph extraction + traversal, multi-tenant company brain, backfill workflows, and multi-source/user/team session storage? Flag gaps, hand-waving, undefined interfaces, missing schema fields, unstated edge cases. Verify code references cite real files in the repos (read them).' },
  { key: 'security-isolation', prompt: 'Multi-tenant security & isolation: can one org/team/user/client EVER read data belonging to another tenant? Is isolation enforced at a single choke-point or scattered and forgettable? Scrutinize auth, token-to-identity-to-scope resolution, Vectorize namespacing, application-level RLS on D1, trust grades, and audit. Flag any silent cross-tenant leak path and any missing isolation test.' },
]
const reviewIterations = []
const ITERATIONS = 3
for (let i = 1; i <= ITERATIONS; i++) {
  const iterReviews = (await parallel(
    LENSES.map((lens) => () =>
      agent(
        `You are a ruthless adversarial reviewer of a PRD for a CF-native multi-tenant memory platform. Iteration ${i}. Your lens:\n${lens.prompt}\n\nScore 0-100 (be harsh; a PRD with any critical flaw scores below 60). Provide specific, actionable weaknesses with severity and a concrete fix. You MAY read the three repos (/home/roboto/devel/cf-graph, /home/roboto/devel/gbrain-cf, /home/roboto/devel/openbrains) to verify claims and code references. Set lens to "${lens.key}". Return the structured review.\n\nPRD:\n${curPRD}`,
        { label: `review-${i}:${lens.key}`, phase: 'Harden', schema: REVIEW_SCHEMA, agentType: 'general-purpose', effort: 'high' }
      )
    )
  )).filter(Boolean)
  const agg = iterReviews.length ? Math.round(iterReviews.reduce((s, r) => s + (r.score || 0), 0) / iterReviews.length) : 0
  const integrated = await agent(
    `You are a fresh lead architect (you did NOT write the PRD). Integrate the valid findings from these adversarial reviews into the PRD, producing the COMPLETE improved PRD. Apply every critical/high fix; for medium/low use judgment; reject wrong findings but justify in residualIssues. Do NOT truncate — return the entire PRD with fixes applied inline, preserving all sections, schemas, diagrams, and code references.\n\nCURRENT PRD:\n${curPRD}\n\nADVERSARIAL REVIEWS (iteration ${i}):\n${j(iterReviews)}\n\nReturn the structured object.`,
    { label: `integrate-${i}`, phase: 'Harden', schema: INTEGRATE_SCHEMA, effort: 'high' }
  )
  if (integrated && integrated.prdMarkdown) curPRD = integrated.prdMarkdown
  reviewIterations.push({
    iteration: i,
    aggregateScore: agg,
    reviews: iterReviews.map((r) => ({ lens: r.lens, score: r.score, verdict: r.verdict, strengths: r.strengths || [], weaknesses: r.weaknesses || [], missing: r.missing || [], summary: r.summary })),
    changelog: integrated ? integrated.changelog : [],
    residualIssues: integrated ? integrated.residualIssues : [],
  })
  log(`Harden iteration ${i}: aggregate score ${agg}/100 (${LENSES.length} lenses).`)
}
const finalScore = reviewIterations.length ? reviewIterations[reviewIterations.length - 1].aggregateScore : 0

// ---------- Report (write polished HTML) ----------
phase('Report')
const STYLE = `Self-contained HTML5, inline <style>, NO external assets, NO required JS. GitHub-dark aesthetic: bg #0d1117, panels #161b22, lines #2b3340, ink #e6edf3, muted #9aa7b4; accents blue #7c9eff, teal #5eead4, purple #bc8cff, orange #f0883e, good #56d364, warn #f0b429, bad #ff6b6b. System font stack. Sticky translucent top nav (table of contents) linking to each section. Rounded cards (radius 12px), bordered tables with sticky headers and row hover, code styled on dark. Score badges colored by value (>=85 good, 70-84 warn, <70 bad). Render score progression across iterations as inline CSS bars. Gradient on the H1. Polished and genuinely readable, not generic.`

const reports = await parallel([
  () =>
    agent(
      `Write a polished, comprehensive HTML report to ABSOLUTE PATH /home/roboto/devel/brain-platform-PRD.html using the Write tool.\n\nIt is the PRD + layered architecture for the new CF-native, multi-tenant "Brain Platform". Render the full PRD markdown faithfully as rich HTML (convert markdown headings/lists/tables/code blocks to proper HTML; do not dump raw markdown). Add a sticky table-of-contents nav, a short executive summary at top (final hardened score ${finalScore}/100), and a "Source projects & code references" treatment so cited files (project:path) are visually distinct. Append a compact appendix summarizing the Cloudflare stack used.\n\nSTYLE GUIDE: ${STYLE}\n\nFULL PRD MARKDOWN:\n${curPRD}\n\nCLOUDFLARE STACK (for appendix):\n${j(cfResearch)}\n\nAfter writing, verify the file exists and is well-formed (balanced tags, ends with </html>). Return ONLY the absolute path and a one-line confirmation.`,
      { label: 'report:prd', phase: 'Report', agentType: 'general-purpose', model: 'sonnet' }
    ),
  () =>
    agent(
      `Write a polished HTML report to ABSOLUTE PATH /home/roboto/devel/brain-platform-review-history.html using the Write tool.\n\nIt documents the adversarial hardening process for the Brain Platform PRD. Include: (1) an overview of the methodology (component analysis -> CF research -> plan -> plan review+integrate -> PRD team -> 3 scored adversarial review/integrate loops); (2) the plan-stage review with its score; (3) a score-progression visualization across the 3 hardening iterations (inline CSS bars) ending at ${finalScore}/100; (4) per-iteration detail: each lens (cf-correctness, completeness, security-isolation) with its score badge, verdict, key weaknesses (with severity), and what the integrator changed (changelog) + residual issues. Color-code scores and severities.\n\nSTYLE GUIDE: ${STYLE}\n\nPLAN REVIEW:\n${j(planReview)}\n\nHARDENING ITERATIONS:\n${j(reviewIterations)}\n\nAfter writing, verify the file exists and is well-formed. Return ONLY the absolute path and a one-line confirmation.`,
      { label: 'report:reviews', phase: 'Report', agentType: 'general-purpose', model: 'sonnet' }
    ),
])

return {
  finalScore,
  scoreProgression: reviewIterations.map((r) => ({ iteration: r.iteration, score: r.aggregateScore })),
  planReviewScore: planReview ? planReview.score : null,
  componentsAnalyzed: components.length,
  cfServices: cfResearch.services.length,
  prdSections: sections.length,
  reports,
  prdReport: '/home/roboto/devel/brain-platform-PRD.html',
  reviewReport: '/home/roboto/devel/brain-platform-review-history.html',
  residualIssuesFinal: reviewIterations.length ? reviewIterations[reviewIterations.length - 1].residualIssues : [],
}

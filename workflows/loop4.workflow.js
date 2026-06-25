export const meta = {
  name: 'brain-platform-loop4',
  description: 'Iteration 4: adversarial review of the full Brain Platform PRD, then per-section integration (no whole-doc rewrite, avoiding the output-ceiling truncation that capped iteration 3)',
  phases: [
    { title: 'Review4' },
    { title: 'Integrate4' },
  ],
}

const j = (o) => JSON.stringify(o)
const BASE = '/tmp/claude-1000/-home-roboto-devel/de8de32f-fcde-4884-89d9-eeaaf43cb4da/scratchpad'
const PRD_PATH = `${BASE}/PRD.md`

const SECTIONS = {
  s01: '1. Vision, Goals, Personas & Scope',
  s02: '2. Layered Services Architecture',
  s03: '3. Data Model & Storage',
  s04: '4. Ingestion & Document Loading',
  s05: '5. Embedding, Hybrid Search, Rerank & Cited Synthesis',
  s06: '6. Graph Extraction & Traversal',
  s07: '7. Multi-Tenant Company Brain: Auth, Scoping, Trust & Audit',
  s08: '8. Session Capture, Hot Memory & Backfill',
  s09: '9. API, MCP Server, CLI & Frontend',
  s10: '10. Deployment, Observability, Testing & Rollout',
  appendix: 'Appendix: Open Questions & Residual Issues',
}
const SECTION_KEYS = Object.keys(SECTIONS)
const fileFor = (k) => `${BASE}/${k === 'appendix' ? 'appendix' : k}.md`

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['lens', 'score', 'verdict', 'weaknesses', 'summary'],
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '0-100. Harsh but fair. This is iteration 4; iter-3 scored 61 — only raise it if genuinely improved.' },
    verdict: { type: 'string', enum: ['accept', 'accept-with-changes', 'major-revision', 'reject'] },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['section', 'issue', 'severity', 'recommendation'],
        additionalProperties: false,
        properties: {
          section: { type: 'string', enum: SECTION_KEYS, description: 'The single best-fit section key this fix belongs in. Map cross-cutting isolation issues to s07; cross-cutting architecture issues to s02.' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          recommendation: { type: 'string', description: 'A concrete, section-local fix the integrator can apply.' },
        },
      },
    },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  required: ['section', 'appliedCount', 'changelog', 'residual'],
  additionalProperties: false,
  properties: {
    section: { type: 'string' },
    appliedCount: { type: 'number' },
    changelog: { type: 'array', items: { type: 'string' } },
    residual: { type: 'array', items: { type: 'string' } },
  },
}

const LENSES = [
  { key: 'cf-correctness', prompt: 'Cloudflare-primitive correctness & feasibility: are D1 (limits, batching, sharding), Vectorize V2 (10M vectors/index, 50k namespaces/index, dims), R2, Durable Objects, Workflows, Queues, KV, Workers AI (model availability + rate limits), AI Gateway used correctly and within real limits? Flag anything that cannot work on Cloudflare, misuses a primitive, ignores a quota, or where a better primitive exists.' },
  { key: 'completeness', prompt: 'Requirements coverage & internal consistency: does the PRD fully and concretely deliver document ingestion, embedding+semantic search, hybrid search+rerank, graph extraction+traversal, multi-tenant company brain, backfill workflows, and multi-source/user/team session storage? Now that a consolidated §3 data model exists, check §3 does NOT contradict the inline DDL in §4/§6/§7/§8 (column names, types, ownership annotations). Flag gaps, undefined interfaces, dangling cross-references, and §-numbering inconsistencies.' },
  { key: 'security-isolation', prompt: 'Multi-tenant security & isolation: can one org/team/user/client EVER read data belonging to another tenant? Is isolation enforced at a single choke-point (ScopedDB/ScopedVectorize/ScopedR2) or scattered and forgettable? Scrutinize the FTS5-tables-carry-no-tenant_id exception and its JOIN re-check, Vectorize namespace=tenant, token-to-identity-to-scope resolution, trust grades, admin recall over private memory, and audit. Flag any silent cross-tenant leak path and any missing isolation test.' },
]

// ---------- Review4 ----------
phase('Review4')
const reviews = (await parallel(
  LENSES.map((lens) => () =>
    agent(
      `You are a ruthless adversarial reviewer of a Product Requirements Document for a Cloudflare-native, multi-tenant "Brain Platform" memory system. This is iteration 4 of hardening (prior aggregate scores: 26 -> 68 -> 61).\n\nYOUR LENS:\n${lens.prompt}\n\nRead the FULL PRD at: ${PRD_PATH}\nYou MAY also read the three source repos to verify code references and claims: /home/roboto/devel/cf-graph, /home/roboto/devel/gbrain-cf, /home/roboto/devel/openbrains.\n\nSection keys for routing each weakness (pick the single best-fit): ${j(SECTIONS)}.\n\nScore 0-100 (be harsh; any unresolved critical caps the score below 60). For every weakness give: the section key, a concrete severity, and a section-LOCAL recommendation an integrator can apply by editing only that section. Set lens to "${lens.key}". Return the structured review.`,
      { label: `review4:${lens.key}`, phase: 'Review4', schema: REVIEW_SCHEMA, agentType: 'general-purpose', effort: 'high' }
    )
  )
)).filter(Boolean)

const scores = reviews.map((r) => r.score || 0)
const aggregate = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
log(`Iteration 4 review scores: ${reviews.map((r) => `${r.lens}=${r.score}`).join(', ')} -> aggregate ${aggregate}/100`)

// group weaknesses by section
const bySection = {}
for (const r of reviews) {
  for (const w of r.weaknesses || []) {
    const k = SECTION_KEYS.includes(w.section) ? w.section : 's02'
    if (!bySection[k]) bySection[k] = []
    bySection[k].push({ lens: r.lens, issue: w.issue, severity: w.severity, recommendation: w.recommendation })
  }
}
const sectionsToFix = SECTION_KEYS.filter((k) => bySection[k] && bySection[k].length)
log(`Findings routed to ${sectionsToFix.length} sections: ${sectionsToFix.join(', ')}`)

// ---------- Integrate4 (per-section, parallel) ----------
phase('Integrate4')
const integrations = (await parallel(
  sectionsToFix.map((k) => () =>
    agent(
      `You are a fresh lead architect integrating adversarial-review findings into ONE section of the Brain Platform PRD. Edit ONLY this section.\n\nSECTION: ${k} — ${SECTIONS[k]}\nFILE TO EDIT (read it, rewrite it, write it back to the SAME path with the Write tool): ${fileFor(k)}\n\nFINDINGS TO APPLY (from 3 adversarial lenses):\n${j(bySection[k])}\n\nRULES:\n- Apply every critical and high finding; apply medium where sound; for low/wrong findings, use judgment and record them in "residual" with a one-line rationale.\n- Preserve the section heading line EXACTLY (e.g. "## ${SECTIONS[k]}") and keep all sub-headings, tables, code blocks, and schemas — improve them in place, do not delete content wholesale.\n- Do NOT add or remove a "#### Code references" block (the build step adds those automatically for every section except §3; if this is s03, keep its embedded Code references).\n- Keep edits consistent with the rest of the PRD (don't rename shared types like ScopedDB/ScopedVectorize/ScopedR2, table names, or §-cross-references unless a finding specifically requires it).\n- You MAY read /home/roboto/devel/cf-graph, /home/roboto/devel/gbrain-cf, /home/roboto/devel/openbrains to ground a fix.\n\nAfter writing the file, return the structured object (section="${k}").`,
      { label: `integrate4:${k}`, phase: 'Integrate4', schema: INTEGRATE_SCHEMA, agentType: 'general-purpose', effort: 'high' }
    )
  )
)).filter(Boolean)

const totalApplied = integrations.reduce((a, i) => a + (i.appliedCount || 0), 0)
log(`Integrated ${totalApplied} fixes across ${integrations.length} sections.`)

return {
  iteration: 4,
  priorProgression: [26, 68, 61],
  aggregateScore: aggregate,
  reviews: reviews.map((r) => ({ lens: r.lens, score: r.score, verdict: r.verdict, strengths: r.strengths || [], weaknesses: r.weaknesses || [], missing: r.missing || [], summary: r.summary })),
  sectionsFixed: sectionsToFix,
  integrations,
  totalApplied,
}

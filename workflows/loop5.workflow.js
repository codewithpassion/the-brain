export const meta = {
  name: 'brain-platform-loop5',
  description: 'Integrate the 4 product decisions (break-glass private read; doc=world; row-scoping; entity vector search in v1), rebuild, then re-score with 3 adversarial lenses',
  phases: [
    { title: 'Apply' },
    { title: 'Rebuild' },
    { title: 'Rescore' },
  ],
}

const j = (o) => JSON.stringify(o)
const BASE = '/tmp/claude-1000/-home-roboto-devel/de8de32f-fcde-4884-89d9-eeaaf43cb4da/scratchpad'
const PRD_PATH = `${BASE}/PRD.md`

const SECTIONS = {
  s01: '1. Vision', s02: '2. Architecture', s03: '3. Data Model', s04: '4. Ingestion',
  s05: '5. Search', s06: '6. Graph', s07: '7. Tenancy/Auth/Scoping/Trust/Audit',
  s08: '8. Sessions/Backfill', s09: '9. API/MCP/CLI/Frontend', s10: '10. Ops', appendix: 'Appendix',
}
const SECTION_KEYS = Object.keys(SECTIONS)

const INTEGRATE_SCHEMA = {
  type: 'object', required: ['filesEdited', 'changelog', 'residual'], additionalProperties: false,
  properties: {
    filesEdited: { type: 'array', items: { type: 'string' } },
    changelog: { type: 'array', items: { type: 'string' } },
    residual: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', required: ['lens', 'score', 'verdict', 'weaknesses', 'summary'], additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '0-100. Harsh but fair. Prior aggregate progression: 26,68,61,62 (pre-integration of iter-4 fixes + these decisions).' },
    verdict: { type: 'string', enum: ['accept', 'accept-with-changes', 'major-revision', 'reject'] },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'object', required: ['section', 'issue', 'severity', 'recommendation'], additionalProperties: false, properties: { section: { type: 'string', enum: SECTION_KEYS }, issue: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, recommendation: { type: 'string' } } } },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const RULES = `RULES: Edit files in place with Write/Edit, same path. Preserve every section heading line and sub-structure; change only what the decision requires; keep shared type/table names consistent (ScopedDB, ScopedVectorize, brain-chunks, documents, chunks, entities, pages, memory_use_policy, memory_audit). Do NOT add/remove "#### Code references" blocks (build step adds them; except s03 which embeds its own). You MAY read /home/roboto/devel/cf-graph, /home/roboto/devel/gbrain-cf, /home/roboto/devel/openbrains to ground a change.`

// ---------- Apply (2 integrators, no file overlap) ----------
phase('Apply')
const integ = (await parallel([
  () => agent(
    `You are integrating a PRODUCT DECISION into the Brain Platform PRD. Decision: an org owner/admin MAY read members' memory marked 'private', but ONLY as a FULL AUDITED BREAK-GLASS surface — never the default path, never silent.\n\nEDIT ONLY these files (read them first): ${BASE}/s07.md and ${BASE}/s10.md.\n\nrequired design:\n- s07 (§7.3/§7.5/§7.6): TODAY the doc says owner/admin do NOT bypass the visibilityPredicate and admin reach is 'compliance over the memory_audit/memory_recall_traces LOGS only'. CHANGE this to define an explicit admin-only BREAK-GLASS READ over the private CONTENT itself (private chunks + private facts), with ALL of: (a) gated on the admin/owner role (org scope), (b) invoked only via an explicit signal (e.g. an admin-only tool or a breakGlass:true param that fails closed for non-admins), (c) every break-glass read writes a distinct memory_audit row (action='breakglass_read', actor, target principal, query) AND emits an alert to an alert sink, (d) the DEFAULT recall/think path still EXCLUDES private (non-bypassing) — break-glass is a separate, explicit, logged call. Make the visibilityPredicate / ScopedDB contract state this exception precisely.\n- s10 (§10.6 isolation canaries): add/extend required canary tests: (i) a NON-admin principal still cannot read another user's private memory via ANY path (recall/think/graph/break-glass-without-admin-role) — fails closed; (ii) an admin break-glass read DOES return private content AND writes the audit+alert row. Number them consistently with the existing canary table.\n\nDo NOT edit any other file (the appendix decision-log is handled by the other integrator). ${RULES}\n\nReturn the structured object.`,
    { label: 'apply:breakglass', phase: 'Apply', schema: INTEGRATE_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
  ),
  () => agent(
    `You are integrating a PRODUCT DECISION into the Brain Platform PRD. Decision: ENTITY VECTOR SEARCH is pulled INTO v1 (previously deferred to Phase 3.5). Cross-session SEMANTIC FACT DEDUP stays deferred; trust-grade tiers stay. Also record three confirmed decisions in the appendix.\n\nEDIT ONLY these files (read them first): ${BASE}/s03.md, ${BASE}/s06.md, ${BASE}/s09.md, ${BASE}/appendix.md.\n\nrequired changes:\n- s03 (§3.2): TODAY it says 'v1 has exactly one index: brain-chunks; brain-entities is deferred / not provisioned'. CHANGE to: v1 provisions TWO Vectorize indexes — brain-chunks AND brain-entities (both 1024-dim cosine, namespace=tenant). Update ceiling math: each index independently bounded by 10M vectors / 50k namespaces; note the added cost and the second index's metadata-index budget. Keep the trust_grade-not-indexed invariant and the canonical chunk upsert-metadata shape unchanged.\n- s06 (§6.6/§6.7): UN-DEFER entity vectors + search_entities. Specify: entities are embedded (canonical name + description) into brain-entities on upsert (same staleness/per-row embedding-model tracking as chunks); search_entities does scoped (tenant + node scope/visibility gate) vector search over brain-entities, optionally fused with entity_fts. EXPLICITLY KEEP cross-session semantic fact dedup deferred to Phase 3.5 (state it remains out of v1; v1 dedup stays deterministic supersede-by-session + exact-text).\n- s09 (§9.2.2): remove the '(deferred Phase 3.5 ...)' marker on search_entities; list it as a v1 Graph tool with its scoped-search contract.\n- appendix: update the decision/residual log to mark RESOLVED: (1) admin-vs-private posture = FULL AUDITED+ALERTABLE BREAK-GLASS READ (decided; see §7.6); (2) ingested-document default visibility = 'world'/tenant-wide (decided, intended model); (3) org = tenant with row-scoping for intra-tenant clients (decided); (4) entity vector search now IN v1. Note cross-session semantic fact dedup REMAINS deferred to Phase 3.5.\n\nDo NOT edit any other file. ${RULES}\n\nReturn the structured object.`,
    { label: 'apply:entity-v1', phase: 'Apply', schema: INTEGRATE_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
  ),
])).filter(Boolean)
log(`Applied decisions: ${integ.reduce((a, i) => a + (i.changelog ? i.changelog.length : 0), 0)} edits across ${integ.flatMap((i) => i.filesEdited || []).length} file-touches.`)

// ---------- Rebuild (deterministic, in-workflow so reviewers see fresh PRD.md) ----------
phase('Rebuild')
const rebuilt = await agent(
  `Run this exact command with the Bash tool and report its stdout verbatim:\n\ncd ${BASE} && python3 build.py\n\nThen confirm ${PRD_PATH} exists and report its byte size (wc -c). Return only the stdout + byte size. Do nothing else.`,
  { label: 'rebuild:prd', phase: 'Rebuild', agentType: 'general-purpose', model: 'sonnet', effort: 'low' }
)
log(`Rebuilt PRD.md: ${rebuilt}`)

// ---------- Rescore (3 adversarial lenses on the rebuilt doc) ----------
phase('Rescore')
const LENSES = [
  { key: 'cf-correctness', prompt: 'Cloudflare-primitive correctness & feasibility within real limits (D1, Vectorize V2 incl. the now-TWO indexes against 10M/50k ceilings, R2, DO, Workflows incl. 1MiB step-output + step caps, Queues, Workers AI model availability + rate limits, AI Gateway).' },
  { key: 'completeness', prompt: 'Requirements coverage & internal consistency, including: is entity vector search now coherently specified end-to-end (index provisioning in §3.2, embed-on-upsert + search_entities in §6, tool in §9)? Are the resolved decisions reflected consistently? Any dangling deferred markers or contradicting DDL?' },
  { key: 'security-isolation', prompt: 'Multi-tenant + intra-tenant isolation. SPECIAL FOCUS: the new admin BREAK-GLASS read over private memory — is it fail-closed for non-admins, role-gated, and does EVERY break-glass read force an audit + alert row while the default recall/think path still excludes private? Can any non-admin reach private content via recall/think/graph/entity-search/break-glass? Verify the brain-entities (entity) search arm carries the same tenant + scope/visibility gate as the chunk arm (new index = new leak surface).' },
]
const reviews = (await parallel(
  LENSES.map((lens) => () =>
    agent(
      `You are a ruthless adversarial reviewer of the Brain Platform PRD (a Cloudflare-native multi-tenant memory platform). This is a re-score AFTER integrating iteration-4 fixes, a cross-section reconciliation, and four product decisions (admin audited break-glass read of private memory; doc default visibility=world; org=tenant row-scoping; entity vector search pulled into v1). Prior aggregate progression: 26 -> 68 -> 61 -> 62 (those scored EARLIER, less-complete drafts).\n\nYOUR LENS: ${lens.prompt}\n\nRead the FULL current PRD at: ${PRD_PATH}. You MAY read /home/roboto/devel/cf-graph, /home/roboto/devel/gbrain-cf, /home/roboto/devel/openbrains to verify claims/code refs. Section keys for routing weaknesses: ${j(SECTIONS)}.\n\nScore 0-100 (any unresolved critical caps below 60). Tag each weakness with its section key, a severity, and a concrete section-local fix. Set lens to "${lens.key}". Return the structured review.`,
      { label: `rescore:${lens.key}`, phase: 'Rescore', schema: REVIEW_SCHEMA, agentType: 'general-purpose', effort: 'high' }
    )
  )
)).filter(Boolean)
const scores = reviews.map((r) => r.score || 0)
const aggregate = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
log(`Re-score: ${reviews.map((r) => `${r.lens}=${r.score}`).join(', ')} -> aggregate ${aggregate}/100`)

return {
  iteration: 5,
  priorProgression: [26, 68, 61, 62],
  aggregateScore: aggregate,
  decisionsApplied: integ,
  reviews: reviews.map((r) => ({ lens: r.lens, score: r.score, verdict: r.verdict, strengths: r.strengths || [], weaknesses: r.weaknesses || [], missing: r.missing || [], summary: r.summary })),
}

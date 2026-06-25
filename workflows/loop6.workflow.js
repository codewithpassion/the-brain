export const meta = {
  name: 'brain-platform-loop6',
  description: 'Consistency sweep: propagate entity-vectors-in-v1 everywhere the doc still says deferred, fix two security/schema stragglers, rebuild, re-score',
  phases: [
    { title: 'Sweep' },
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
    lens: { type: 'string' }, score: { type: 'number' },
    verdict: { type: 'string', enum: ['accept', 'accept-with-changes', 'major-revision', 'reject'] },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'object', required: ['section', 'issue', 'severity', 'recommendation'], additionalProperties: false, properties: { section: { type: 'string', enum: SECTION_KEYS }, issue: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, recommendation: { type: 'string' } } } },
    missing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const RULES = `RULES: This is a CONSISTENCY SWEEP — propagate already-decided facts, no new design. Edit files in place (Write/Edit), same path. Preserve all headings/structure; change only the lines the punch-list names (and any identical stale phrasing you find in the SAME file). Keep shared names consistent (brain-chunks, brain-entities, ENTITY_INDEX/CHUNKS_INDEX, tenant_shards, api_keys.allowed_scopes, memory_use_policy). Do NOT add/remove "#### Code references" blocks. After editing, GREP-VERIFY your file(s) no longer contain the stale phrases. Return the structured object.`

// ---------- Sweep (3 integrators, no file overlap) ----------
phase('Sweep')
const sweep = (await parallel([
  () => agent(
    `CONSISTENCY SWEEP — deploy + pipeline truth for "entity vector search is IN v1". EDIT ONLY: ${BASE}/s10.md and ${BASE}/s04.md.\n\nPUNCH-LIST:\n1) s10 §10.1 wrangler.jsonc (CRITICAL): the manifest declares only {binding:'CHUNKS_INDEX', index_name:'brain-chunks'} and comments that brain-entities is NOT provisioned in v1. ADD a second Vectorize binding {binding:'ENTITY_INDEX', index_name:'brain-entities'} and DELETE/replace the not-provisioned comment.\n2) s10 §10.4 Vectorize provisioning (CRITICAL): only brain-chunks is created. ADD the brain-entities create + metadata-index commands mirroring §3.2: 'wrangler vectorize create brain-entities --dimensions=1024 --metric=cosine' then create-metadata-index for scope, team_id, visibility, embedding_model. Put them in the same deploy-ordering step as brain-chunks (before first filtered upsert).\n3) s04 §4.4/§4.5 (~line 1409) (CRITICAL): the KG-extraction Workflow text says 'entity vectors and semantic-dedup are deferred to Phase 3.5; the Workflow does NOT embed entities or upsert to brain-entities in v1'. FLIP it: in v1 the Workflow DOES embed entities (canonical_name + description via bge-m3) and upserts to brain-entities (the embed-entities step, §6.2); ONLY cross-session SEMANTIC dedup remains deferred to Phase 3.5.\nDo not edit other files. ${RULES}`,
    { label: 'sweep:deploy', phase: 'Sweep', schema: INTEGRATE_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
  ),
  () => agent(
    `CONSISTENCY SWEEP — remove stale "entity vectors deferred" language from the overview/prose. EDIT ONLY: ${BASE}/s01.md, ${BASE}/s02.md, ${BASE}/s05.md.\n\nPUNCH-LIST:\n1) s01 §1.3 Non-Goals table (~line 75) and §1.7 scope-boundary table (~line 196): they list 'No entity vectors / semantic dedup in v1 — brain-entities index ... deferred to Phase 3.5'. EDIT so entity vector search / brain-entities are IN v1; keep ONLY cross-session SEMANTIC FACT DEDUP as the deferred Phase 3.5 non-goal (reword so the index + search are not called deferred).\n2) s02 §2.7 and the §2 substrate line (~line 381): 'brain-entities deferred to Phase 3+' → 'brain-entities (1024d/cosine) provisioned in v1' (two indexes: brain-chunks + brain-entities).\n3) s05 §5.2 (~line 1692): 'Entity vectors are deferred to Phase 3.5; v1 search is one index (brain-chunks)' → v1 has TWO indexes; chunk search uses brain-chunks, entity search (search_entities) uses brain-entities (§6.6/§6.7).\nThen grep each file to confirm no remaining 'entity vectors ... deferred' / 'brain-entities ... deferred' / 'one index' phrasing survives (except where it correctly refers ONLY to semantic fact dedup). Do not edit other files. ${RULES}`,
    { label: 'sweep:overview', phase: 'Sweep', schema: INTEGRATE_SCHEMA, agentType: 'general-purpose', model: 'sonnet', effort: 'high' }
  ),
  () => agent(
    `CONSISTENCY SWEEP — tenancy/API consistency + two security/schema stragglers. EDIT ONLY: ${BASE}/s07.md and ${BASE}/s09.md.\n\nPUNCH-LIST:\n1) s07 §7.1/§7.2 Drizzle tenant_shards.entityIndex comment "'brain-entities' (deferred, Phase 3.5)" → "'brain-entities' in v1" (match the already-correct §3.1 copy).\n2) s07 §7.4 create-metadata-index block (~line 3116) + budget note (~line 3119) (schema bug): it provisions trust_grade as a brain-chunks Vectorize metadata index — this CONTRADICTS the sidecar-only invariant (trust_grade lives ONLY in memory_use_policy, §3.2/§5.2). REMOVE trust_grade from the metadata-index set; the indexed set is scope, team_id, visibility, embedding_model.\n3) s07 §7.5 prose (~line 3200): facts visibility 'visibility ∈ {private,world}' (stale 2-value) → '{private,team,world}' to match the DDL CHECK.\n4) s09 §9.2.2 admin tool catalog (~line 3865, the 'Admin (admin scope only)' list): ADD the admin-only tool 'memory.break_glass_read' (defined in §7.6, exercised by canaries #14/#15) with a one-line scoped contract.\n5) s09 §9.0.1 surface-layer edge-resolver (CRITICAL security): the machine-token branch AND the api-key branch both say "allowedScopes defaults to '*'" (stale pre-iter-3 copy). FIX both to resolve allowedScopes/teamIds from the STORED api_keys.allowed_scopes (and token scopes) — matching the §7.2 fix that removed the '*' privilege-escalation. A restricted key must NOT resolve to '*'.\nDo not edit other files. ${RULES}`,
    { label: 'sweep:tenancy-api', phase: 'Sweep', schema: INTEGRATE_SCHEMA, agentType: 'general-purpose', model: 'opus', effort: 'high' }
  ),
])).filter(Boolean)
log(`Sweep applied ${sweep.reduce((a, i) => a + (i.changelog ? i.changelog.length : 0), 0)} edits across ${sweep.flatMap((i) => i.filesEdited || []).length} files.`)

// ---------- Rebuild ----------
phase('Rebuild')
const rebuilt = await agent(
  `Run with the Bash tool and report stdout verbatim:\n\ncd ${BASE} && python3 build.py\n\nThen report ${PRD_PATH} byte size (wc -c). Return only that. Do nothing else.`,
  { label: 'rebuild:prd', phase: 'Rebuild', agentType: 'general-purpose', model: 'sonnet', effort: 'low' }
)
log(`Rebuilt: ${rebuilt}`)

// ---------- Rescore ----------
phase('Rescore')
const LENSES = [
  { key: 'cf-correctness', prompt: 'Cloudflare-primitive correctness within real V2 limits (esp. the now-TWO Vectorize indexes brain-chunks + brain-entities: bindings in §10.1, provisioning in §10.4, ceilings in §3.2; Workflows 1MiB step-output + step caps; Workers AI; D1).' },
  { key: 'completeness', prompt: 'Requirements coverage & internal consistency. Verify entity vector search is now coherent AND consistent end-to-end with NO surviving "deferred to Phase 3.5" contradictions for the index/search (only cross-session SEMANTIC fact dedup may remain deferred). Check §10.1 wrangler declares brain-entities, §10.4 provisions it, §4 KG workflow embeds entities, §1/§2/§5 no longer call it deferred.' },
  { key: 'security-isolation', prompt: 'Multi-tenant + intra-tenant isolation. Verify: (a) the §9.0.1 surface edge-resolver no longer defaults allowedScopes to "*" for machine-token/api-key branches (reads stored api_keys.allowed_scopes); (b) the admin break-glass read is fail-closed/role-gated/audited and present in the §9.2.2 admin tool catalog; (c) the brain-entities (entity) search arm carries the same tenant + scope/visibility gate as the chunk arm; (d) no trust_grade leaks into a Vectorize metadata index.' },
]
const reviews = (await parallel(
  LENSES.map((lens) => () =>
    agent(
      `Ruthless adversarial re-score of the Brain Platform PRD (Cloudflare-native multi-tenant memory platform) AFTER a consistency sweep that propagated the entity-vectors-in-v1 decision everywhere and fixed two stragglers. Prior aggregate progression: 26,68,61,62,57 (the 57 was dragged down by exactly the internal contradictions this sweep targeted).\n\nYOUR LENS: ${lens.prompt}\n\nRead the FULL current PRD at ${PRD_PATH}. You MAY read /home/roboto/devel/{cf-graph,gbrain-cf,openbrains}. Section keys: ${j(SECTIONS)}. Score 0-100 (any unresolved critical caps below 60). Tag each weakness with section key + severity + a concrete fix. Set lens to "${lens.key}". Return the structured review.`,
      { label: `rescore:${lens.key}`, phase: 'Rescore', schema: REVIEW_SCHEMA, agentType: 'general-purpose', effort: 'high' }
    )
  )
)).filter(Boolean)
const scores = reviews.map((r) => r.score || 0)
const aggregate = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
log(`Re-score: ${reviews.map((r) => `${r.lens}=${r.score}`).join(', ')} -> aggregate ${aggregate}/100`)

return {
  iteration: 6,
  priorProgression: [26, 68, 61, 62, 57],
  aggregateScore: aggregate,
  sweepApplied: sweep,
  reviews: reviews.map((r) => ({ lens: r.lens, score: r.score, verdict: r.verdict, strengths: r.strengths || [], weaknesses: r.weaknesses || [], missing: r.missing || [], summary: r.summary })),
}

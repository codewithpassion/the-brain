import json, html, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE=os.path.join(ROOT,'reviews')
OUT=os.path.join(ROOT,'brain-platform-review-history.html')
cur=json.load(open(f'{BASE}/iter8.json'))
def esc(x): return html.escape(str(x))
def sc_cls(n): return 's-good' if n>=85 else ('s-warn' if n>=70 else 's-bad')
def sev_cls(s): return {'critical':'sev-crit','high':'sev-high','medium':'sev-med','low':'sev-low'}.get(s,'sev-low')

# Full journey: (round label, score, what happened)
JOURNEY=[
 (1,26,'Initial harden pass (whole-doc rewrite) — structural holes everywhere.'),
 (2,68,'First integration fixed the big structural gaps.'),
 (3,61,'Whole-doc rewrite hit the structured-output ceiling and truncated — regressed.'),
 (4,62,'Per-section integration (16 fixes): 1 MiB step cap, topK 100, bge-m3 60k, API-key escalation, graph-arm leak.'),
 (5,57,'Integrated 4 product decisions (break-glass, doc=world, row-scoping, entity-vectors-in-v1) — DROPPED: the entity-vectors change left "deferred" debris in ~10 places (incl. the deploy manifest).'),
 (6,68,'Consistency sweep propagated entity-vectors everywhere + fixed 2 stragglers — recovered.'),
 (7,67,'Invariant sweep (trust_grade sidecar-only everywhere; brain-entities per-env; api_keys.allowed_scopes aligned). All lenses "accept-with-changes"; automated-review plateau.'),
 (8,78,'Integrated the confirmed deployment facts (1-2 tenants, Workers Paid, Clerk, $400/mo) + deferred horizontal scale-out to Phase-N + cleared R7 debris. Right-sizing to the real v1 target removed the "unknown-scale" hedging — cleared the 70 line.'),
]
maxs=100
bars=''
for rnd,sc,note in JOURNEY:
    cls=sc_cls(sc)
    bars+=f'''<div class="barrow"><span class="barlab">R{rnd}</span>
      <div class="bartrack"><div class="barfill {cls}" style="width:{sc}%"></div></div>
      <span class="barval {cls}">{sc}</span>
      <span class="barnote">{esc(note)}</span></div>'''

lens_titles={'cf-correctness':'Cloudflare-primitive correctness','completeness':'Completeness & consistency','security-isolation':'Multi-tenant security & isolation'}
lens_cards=''
for r in cur['reviews']:
    sc=r['score']; cls=sc_cls(sc)
    wk=''
    for w in r['weaknesses']:
        wk+=f'''<tr><td><span class="sev {sev_cls(w['severity'])}">{esc(w['severity'])}</span></td><td><code>{esc(w['section'])}</code></td><td>{esc(w['issue'])}<div class="rec">→ {esc(w['recommendation'])}</div></td></tr>'''
    lens_cards+=f'''<div class="card"><div class="card-h"><h3>{esc(lens_titles.get(r['lens'],r['lens']))}</h3><span class="scorebadge {cls}">{sc}<small>/100</small></span></div>
      <div class="verdict">verdict: <b>{esc(r['verdict'])}</b></div><p class="summary">{esc(r['summary'])}</p>
      <table class="wk"><thead><tr><th>Sev</th><th>§</th><th>Open item &amp; fix</th></tr></thead><tbody>{wk}</tbody></table></div>'''

CSS="""
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2230;--line:#2b3340;--ink:#e6edf3;--muted:#9aa7b4;--dim:#6e7d8d;--accent:#7c9eff;--teal:#5eead4;--purple:#bc8cff;--orange:#f0883e;--good:#56d364;--warn:#f0b429;--bad:#ff6b6b;}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:0 26px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:.85em;background:#0b0f14;border:1px solid var(--line);border-radius:5px;padding:.06em .4em;color:#cbe2ff}
header.hero{padding:54px 0 28px;border-bottom:1px solid var(--line);background:radial-gradient(900px 320px at 15% -10%,rgba(124,158,255,.14),transparent)}
.eyebrow{letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:var(--teal);font-weight:600}
h1{font-size:32px;margin:12px 0 6px;letter-spacing:-.02em;background:linear-gradient(90deg,var(--orange),var(--accent) 55%,var(--purple));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--muted);max-width:780px}
section{padding:36px 0;border-bottom:1px solid var(--line)}
h2{font-size:23px;margin:0 0 14px}
h3{font-size:17px;margin:0}
.barrow{display:flex;align-items:center;gap:12px;margin:9px 0}
.barlab{width:32px;font-size:12.5px;color:var(--muted);font-weight:700}
.bartrack{flex:0 0 220px;height:20px;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
.barfill{height:100%}
.barfill.s-good{background:linear-gradient(90deg,#2ea043,#56d364)}.barfill.s-warn{background:linear-gradient(90deg,#bb8009,#f0b429)}.barfill.s-bad{background:linear-gradient(90deg,#cf3b3b,#ff6b6b)}
.barval{width:28px;font-weight:700}.barnote{flex:1;font-size:12.5px;color:var(--muted)}
.s-good{color:var(--good)}.s-warn{color:var(--warn)}.s-bad{color:var(--bad)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(3,1fr)}@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.scorebadge{font-weight:800;font-size:22px;border-radius:9px;padding:4px 12px;border:1px solid var(--line);background:#0b0f14}
.scorebadge small{font-size:12px;color:var(--dim)}
.scorebadge.s-good{color:var(--good)}.scorebadge.s-warn{color:var(--warn)}.scorebadge.s-bad{color:var(--bad)}
.verdict{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}.verdict b{color:var(--ink)}
.summary{font-size:13px;color:var(--muted);margin:0 0 12px}
table.wk{width:100%;border-collapse:collapse;font-size:12.5px}
table.wk th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--line)}
table.wk td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.rec{color:var(--muted);margin-top:4px}
.sev{font-size:10.5px;font-weight:800;text-transform:uppercase;padding:2px 7px;border-radius:5px}
.sev-crit{background:rgba(255,107,107,.17);color:var(--bad)}.sev-high{background:rgba(240,136,62,.17);color:var(--orange)}.sev-med{background:rgba(240,180,41,.16);color:var(--warn)}.sev-low{background:rgba(110,125,141,.18);color:var(--muted)}
.callout{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:16px 18px;margin:10px 0}
.callout.warn{border-left-color:var(--warn)}.callout.good{border-left-color:var(--good)}
.callout h4{margin:0 0 8px}
.metarow{display:flex;gap:9px;flex-wrap:wrap;margin-top:18px}
.badge{font-size:12px;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:5px 12px;color:var(--muted)}.badge b{color:var(--ink)}
ul{padding-left:20px}li{margin:6px 0;font-size:13.5px;color:var(--muted)}
footer{padding:34px 0 70px;color:var(--dim);font-size:12.5px}
"""

bucketC=[
 "<b>Scale targets</b> — RESOLVED: v1 = 1-2 tenants (internal dogfood). Single D1, horizontal sharding deferred to Phase-N, Vectorize ceilings non-binding. Exact vector/session counts to be <i>measured during dogfood</i>.",
 "<b>Workers AI rate limits</b> — RESOLVED: Workers Paid ($5/mo); informed, labeled conservative assumptions (embed ~300, gen ~100, rerank ~300 req/min), non-binding at this scale; AI Gateway + BYO/OpenAI-compatible models as the documented upgrade path.",
 "<b>Auth / IdP</b> — RESOLVED: Clerk (OAuth 2.1 upstream).",
 "<b>Per-tenant cost ceiling</b> — RESOLVED: <code>MONTHLY_COST_CEILING_USD = 400</code>, configurable/per-tenant-overridable, wired to the token_spend 429 enforcer.",
 "<b>Tuning data</b> (rerank/cosine thresholds, trust-boost weights, idle-promotion window) — still empirical; lock against real ranking/load data once the dogfood deployment is running.",
]
remaining=[
 "<b>Cleared post-measurement</b> (after the 78 score): the §2 trust_grade code-reference debris (in coderefs.json) and the §5/§10 rate-limit number mismatch were fixed deterministically by hand — so two of the round-8 lows/mediums below are already resolved in the shipped doc.",
 "FTS arm (§5.3.1) filters tenant_id + scope but not visibility inline — visibility is enforced on the post-hydration D1 re-check; tightening it inline would be defense-in-depth.",
 "<code>visibilityPredicate</code> team branch nuance (§7.3) when teamIds is empty — correct, but worth an explicit test.",
 "Workflow-instance retention note still mentions '3 days Free / 30 days Paid' (§4) — cosmetic now that Paid is confirmed.",
 "Internal revision tags (iter-2/iter-3…) remain in the body prose — cosmetic; strip before sharing externally.",
]

html_out=f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brain Platform — Adversarial Review Journey</title><style>{CSS}</style></head><body>
<header class="hero"><div class="wrap">
<div class="eyebrow">Adversarial Hardening · 7 rounds</div>
<h1>Brain Platform PRD — review journey &amp; current state</h1>
<p class="sub">The PRD was hardened over seven scored adversarial review→integrate rounds (three independent lenses: Cloudflare-primitive correctness, completeness/consistency, and multi-tenant security/isolation). This report shows the full score trajectory, the current per-lens state, what remains, and the external inputs needed to push past the current plateau.</p>
<div class="metarow">
<span class="badge">Latest aggregate <b class="{sc_cls(cur['aggregateScore'])}">{cur['aggregateScore']}/100</b></span>
<span class="badge">All lenses <b>accept-with-changes</b> (no criticals)</span>
<span class="badge"><a href="brain-platform-PRD.html">→ full PRD</a></span>
</div></div></header>

<section><div class="wrap"><h2>Score trajectory (7 rounds)</h2>
{bars}
<div class="callout good" style="margin-top:18px"><h4>How to read this</h4><p class="sub" style="font-size:13px;margin:0">The dip at R5 (68→57) was not the design getting worse — integrating four product decisions left "deferred"-language debris across ~10 sections (incl. an undeployable wrangler manifest); R6–R7 swept that out. R1–R7 plateaued at ~67–68 because automated review trades one debris layer for a smaller one within ±5 variance. <b>R8 broke the plateau the way predicted — not with more sweeps, but with the external facts.</b> Confirming v1 = 1-2 tenants let the design shed "unknown-scale" hedging (single D1, sharding deferred), and Clerk / Paid-plan / $400-ceiling resolved three "pending confirmation" residuals at once. cf-correctness jumped 64→83.</p></div>
</div></section>

<section><div class="wrap"><h2>Current per-lens state (round 7)</h2>
<div class="grid">{lens_cards}</div></div></section>

<section><div class="wrap"><h2>What still caps the score</h2>
<div class="callout"><h4>Remaining open items (all medium/low; no criticals)</h4><ul>{''.join(f'<li>{x}</li>' for x in remaining)}</ul></div>
</div></section>

<section><div class="wrap"><h2>Deployment facts — now resolved (the R8 unlock)</h2>
<div class="callout good"><h4>Bucket C — supplied and integrated</h4>
<p class="sub" style="font-size:13px;margin:0 0 8px">These were "pending confirmation" and structurally capped the score; they are now decided and threaded through the PRD:</p>
<ul>{''.join(f'<li>{x}</li>' for x in bucketC)}</ul></div>
</div></section>

<footer><div class="wrap">7 adversarial rounds · model: Opus (high effort) for all analysis, authoring, review &amp; integration. PRD rebuilt deterministically from per-section files via build.py + convert.py. Latest data: iter7.json (run wf_aaf4ae88-56f).</div></footer>
</body></html>"""
open(OUT,'w').write(html_out)
print('wrote',OUT,len(html_out),'chars; ends ok:',html_out.rstrip().endswith('</html>'))

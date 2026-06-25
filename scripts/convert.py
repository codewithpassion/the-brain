import re, markdown, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = ROOT
OUT = os.path.join(ROOT, 'brain-platform-PRD.html')

def github_slug(value, sep):
    v = value.strip().lower()
    v = re.sub(r'[^\w\s-]', '', v)   # drop punctuation except word chars, whitespace, hyphen
    v = re.sub(r'\s', sep, v)        # each whitespace char -> separator (preserves count -> '--')
    return v

with open(f'{BASE}/PRD.md') as f:
    md = f.read()

# Strip the in-document TOC list (we render our own sticky nav); keep the title + blurb + convention note.
body_html = markdown.markdown(
    md,
    extensions=['tables', 'fenced_code', 'sane_lists', 'attr_list', 'toc'],
    extension_configs={'toc': {'slugify': github_slug, 'permalink': False}},
)

NAV = [
    ('1-vision-goals-personas--scope', '1 · Vision'),
    ('2-layered-services-architecture', '2 · Architecture'),
    ('3-data-model--storage', '3 · Data Model'),
    ('4-ingestion--document-loading', '4 · Ingestion'),
    ('5-embedding-hybrid-search-rerank--cited-synthesis', '5 · Search'),
    ('6-graph-extraction--traversal', '6 · Graph'),
    ('7-multi-tenant-company-brain-auth-scoping-trust--audit', '7 · Tenancy'),
    ('8-session-capture-hot-memory--backfill', '8 · Sessions'),
    ('9-api-mcp-server-cli--frontend', '9 · API/MCP/FE'),
    ('10-deployment-observability-testing--rollout', '10 · Ops'),
    ('appendix-open-questions--residual-issues', 'Appendix'),
]
nav_html = '\n'.join(f'<a href="#{a}">{t}</a>' for a, t in NAV)

CSS = """
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2230;--line:#2b3340;--ink:#e6edf3;--muted:#9aa7b4;--dim:#6e7d8d;--accent:#7c9eff;--teal:#5eead4;--purple:#bc8cff;--orange:#f0883e;--good:#56d364;--warn:#f0b429;--bad:#ff6b6b;}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1060px;margin:0 auto;padding:0 26px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
nav.toc{position:sticky;top:0;z-index:30;background:rgba(13,17,23,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
nav.toc .wrap{display:flex;gap:4px;flex-wrap:wrap;padding:9px 26px}
nav.toc a{font-size:12.5px;color:var(--muted);padding:5px 9px;border-radius:7px;white-space:nowrap}
nav.toc a:hover{background:var(--panel);color:var(--ink);text-decoration:none}
main{padding:18px 0 80px}
h1{font-size:34px;line-height:1.15;letter-spacing:-.02em;margin:34px 0 8px;background:linear-gradient(90deg,var(--orange),var(--accent) 50%,var(--purple));-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:25px;margin:46px 0 10px;padding-top:14px;border-top:1px solid var(--line);letter-spacing:-.01em;scroll-margin-top:60px}
h3{font-size:19px;margin:30px 0 8px;color:#dbe6f2;scroll-margin-top:60px}
h4{font-size:15.5px;margin:22px 0 6px;color:var(--teal);text-transform:none;letter-spacing:.01em;scroll-margin-top:60px}
h5,h6{font-size:13.5px;margin:16px 0 4px;color:var(--muted)}
p{margin:0 0 13px}
ul,ol{margin:8px 0 16px;padding-left:22px}
li{margin:4px 0}
li::marker{color:var(--dim)}
code{font-family:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;background:#0b0f14;border:1px solid var(--line);border-radius:5px;padding:.08em .4em;color:#cbe2ff}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:10px;padding:15px 16px;overflow-x:auto;margin:14px 0;font-size:13px;line-height:1.5}
pre code{background:none;border:none;padding:0;color:#c9d6e3}
blockquote{margin:16px 0;padding:12px 16px;background:var(--panel2);border-left:3px solid var(--accent);border-radius:8px;color:var(--muted)}
blockquote p:last-child{margin-bottom:0}
table{width:100%;border-collapse:collapse;font-size:13px;margin:14px 0;display:block;overflow-x:auto}
th,td{text-align:left;padding:9px 12px;border:1px solid var(--line);vertical-align:top}
th{background:var(--panel);color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tbody tr:nth-child(even){background:rgba(255,255,255,.015)}
hr{border:none;border-top:1px solid var(--line);margin:34px 0}
strong{color:#f2f6fb}
.lede{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 6px}
.badge{font-size:12px;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:6px 13px;color:var(--muted)}
.badge b{color:var(--ink)}
.score{font-weight:800}
.s-good{color:var(--good)}.s-warn{color:var(--warn)}.s-bad{color:var(--bad)}
/* highlight code-reference lists */
h4#code-references + ul, h4[id^="code-references"] + ul{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 14px 14px 34px;font-size:13px}
"""

HEADER = f"""<div class="wrap">
<div class="lede">
  <span class="badge">Latest hardened score <b class="score s-warn">78/100</b> · all lenses "accept-with-changes" (cf 83 / complete 79 / security 71)</span>
  <span class="badge">Adversarial loops <b>8</b> · progression <b>26 → 68 → 61 → 62 → 57 → 68 → 67 → 78</b></span>
  <span class="badge">Plan review <b>78</b></span>
  <span class="badge">7 components · 16 CF services · 10 sections</span>
  <span class="badge">Stack <b>Cloudflare-native, no Convex</b></span>
</div>
<p style="color:var(--muted);font-size:13.5px;max-width:760px">Source projects mined: <b>gbrain-cf</b> (search/citation depth), <b>openbrains</b> (multi-tenant isolation &amp; governance), <b>cf-graph</b> (durable CF-native ingestion). This document is rendered faithfully from the full 412&nbsp;KB hardened PRD; the 78/100 score, the full 8-round progression, and remaining open items are tracked in the companion <a href="brain-platform-review-history.html">review-journey report</a>.</p>
</div>
"""

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Brain Platform — PRD &amp; Layered Architecture</title>
<style>{CSS}</style>
</head>
<body>
<nav class="toc"><div class="wrap">{nav_html}</div></nav>
<main>
{HEADER}
<div class="wrap">
{body_html}
</div>
</main>
</body>
</html>
"""

with open(OUT, 'w') as f:
    f.write(html)

print('wrote', OUT, len(html), 'chars')
print('h2 count:', html.count('<h2'))
print('table count:', html.count('<table'))
print('ends ok:', html.rstrip().endswith('</html>'))

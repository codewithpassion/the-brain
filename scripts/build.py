import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'sources')
BASE = SRC
with open(f'{BASE}/coderefs.json') as f:
    refs = json.load(f)

order = ['s01','s02','s03','s04','s05','s06','s07','s08','s09','s10']

out = []
out.append("# Brain Platform — Product Requirements Document")
out.append("")
out.append("> A Cloudflare-native, multi-tenant \"company brain\": a governed memory layer that every agent, client, and human in an organization reads from and writes to, built entirely on Cloudflare primitives (Workers, D1, R2, Vectorize V2, Workers AI, AI Gateway, Workflows, Queues, KV, Durable Objects) with no Convex. It fuses the epistemic/search depth of gbrain-cf, the structural multi-tenant isolation and governance of openbrains, and the durable CF-native ingestion of cf-graph onto one pure-Cloudflare stack.")
out.append("")
out.append("## Table of contents")
out.append("")
out.append("1. [Vision, Goals, Personas & Scope](#1-vision-goals-personas--scope)")
out.append("2. [Layered Services Architecture](#2-layered-services-architecture)")
out.append("3. [Data Model & Storage](#3-data-model--storage)")
out.append("4. [Ingestion & Document Loading](#4-ingestion--document-loading)")
out.append("5. [Embedding, Hybrid Search, Rerank & Cited Synthesis](#5-embedding-hybrid-search-rerank--cited-synthesis)")
out.append("6. [Graph Extraction & Traversal](#6-graph-extraction--traversal)")
out.append("7. [Multi-Tenant Company Brain: Auth, Scoping, Trust & Audit](#7-multi-tenant-company-brain-auth-scoping-trust--audit)")
out.append("8. [Session Capture, Hot Memory & Backfill](#8-session-capture-hot-memory--backfill)")
out.append("9. [API, MCP Server, CLI & Frontend](#9-api-mcp-server-cli--frontend)")
out.append("10. [Deployment, Observability, Testing & Rollout](#10-deployment-observability-testing--rollout)")
out.append("- [Appendix: Open Questions & Residual Issues](#appendix-open-questions--residual-issues)")
out.append("")
out.append("> **Section-numbering & cross-reference convention.** Sections are numbered to match the master plan's scheme. Inline `§N` citations throughout (e.g. \"plan §4.1\", \"§5e\", \"§5g\", \"§5i\", \"§5f\", \"§0\") refer to that **master-plan numbering, not to this document's headings** — they are preserved verbatim from the source sections. Two referenced plan sections are not reproduced as standalone sections here: **§0** (scale ceilings — roughly 6 GB per shard D1, and per Vectorize index a hard **10 M vectors** shared across all tenant namespaces — the binding ceiling, with a 7 M headroom alert and 50k namespaces/index as the secondary cap). **§3 is now included as a full consolidated data-model section.** The data model is also reproduced where each section owns it inline — documents/chunks in §4 (the **authoritative** `documents`/`chunks` DDL; §5 reproduces only a read-subset), the search-relevant schema in §5, the graph tables in §6, the tenancy/governance tables in §7, and the sessions/facts/backfill tables in §8. Likewise the isolation primitives `ScopedDB` / `ScopedVectorize` / `ScopedR2` referenced as \"§5\" are specified in §7 (the auth/scoping spine) and consumed everywhere else.")
out.append("")
out.append("---")
out.append("")

for key in order:
    with open(f'{BASE}/{key}.md') as f:
        content = f.read().rstrip('\n')
    out.append(content)
    out.append("")
    krefs = refs.get(key, [])
    if krefs:
        out.append("#### Code references")
        out.append("")
        for r in krefs:
            out.append(f"- {r['project']}:{r['path']} — {r['whatToReuse']}")
        out.append("")
    out.append("---")
    out.append("")

# Appendix (open questions / residual issues) — appended after the numbered sections.
with open(f'{BASE}/appendix.md') as f:
    out.append(f.read().rstrip('\n'))
    out.append("")

result = "\n".join(out).rstrip("\n") + "\n"
with open(f'{ROOT}/PRD.md','w') as f:
    f.write(result)
print("PRD.md chars:", len(result))
print("lines:", result.count(chr(10)))

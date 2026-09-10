#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json, collections, re
from pathlib import Path

rows=[]
for f in Path("/opt/leadsniper-revalidate/data/revalidation/results").glob("*.json"):
  try: rows.append(json.loads(f.read_text()))
  except: pass

print("results", len(rows))
by_ps=collections.Counter(r.get("processingState") for r in rows)
by_rc=collections.Counter(r.get("reasonCode") for r in rows)
print("processingState", dict(by_ps))
print("reasonCode", dict(by_rc))

# sample evidence snippets for retry-like
for r in rows:
  if r.get("processingState") in ("RETRY_PENDING", None) or r.get("newVerdict") is None:
    ev=(r.get("fullEvidence") or r.get("evidence") or "")[:400]
    print("---", r.get("id") or r.get("leadId"), r.get("reasonCode"), r.get("processingState"), "wall", r.get("wallMs"))
    print(ev.replace("\n"," ")[:350])
    print()
PY

# frontier progress for in-progress lead
python3 - <<'PY'
import sqlite3
p="/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqkld5t300av108e5rrr47s9-1784581423685.sqlite"
c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
print("nodes", c.execute("select count(*) from CrawlFrontierNode").fetchone()[0])
print("by_status", c.execute("select status, count(*) from CrawlFrontierNode group by status").fetchall())
print("by_type", c.execute("select resourceType, count(*) from CrawlFrontierNode group by resourceType").fetchall())
print("evidence", c.execute("select count(*) from CrawlNodeEvidence").fetchone()[0])
print("run", c.execute("select * from CrawlRun").fetchall())
c.close()
PY
free -h | head -2
ps -o etime,pcpu,pmem -p 3495757 2>/dev/null || echo worker_done

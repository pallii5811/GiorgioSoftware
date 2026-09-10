#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
# Window since flock single-parent (~2026-07-20T22:12Z)
cut=datetime(2026,7,20,22,12,tzinfo=timezone.utc).timestamp()
log=Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log").read_bytes().replace(b"\x00",b"").decode("utf-8","replace")
import re
dones=[]
for line in log.splitlines():
  if '"event":"lead_done"' not in line: continue
  try:
    o=json.loads(line[line.find("{"):])
  except: continue
  dones.append(o)
# last 30 outcomes
last=dones[-30:]
term=sum(1 for o in last if o.get("kind")=="terminal")
retry=sum(1 for o in last if o.get("kind")=="retry")
print(json.dumps({
  "lead_done_total_in_log": len(dones),
  "last30_terminal": term,
  "last30_retry": retry,
  "last30_retry_rate": round(retry/max(1,len(last)),3),
  "last10": [{"id":o.get("id"),"ps":o.get("processingState"),"kind":o.get("kind"),"term":o.get("terminal")} for o in last[-10:]],
}, indent=2))
# CardioProgress
for f in Path("/opt/leadsniper-revalidate/data/revalidation/results").glob("*.json"):
  try: r=json.loads(f.read_text())
  except: continue
  if "cardio" in (r.get("companyName") or "").lower() or "cardioprogress" in (r.get("fullEvidence") or "").lower():
    print("CARDIO", r.get("id"), r.get("processingState"), r.get("reasonCode"), (r.get("fullEvidence") or "")[:180])
# PDF progress sample for 46-pdf site
import sqlite3, glob
fps=sorted(glob.glob("/opt/leadsniper-revalidate/data/revalidation/frontiers/*cmqkld5s3009z108e1yj01zqy*.sqlite"), key=lambda p: Path(p).stat().st_mtime, reverse=True)
if fps:
  c=sqlite3.connect(f"file:{fps[0]}?mode=ro", uri=True)
  print("pdf_site_frontier", Path(fps[0]).name)
  print("pdf", c.execute("select state,count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
  c.close()
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print("cp", {"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"inProgress":len(cp.get("inProgress")or{}), "tech":cp.get("stats",{}).get("tech")})
PY

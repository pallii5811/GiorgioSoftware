#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json, sqlite3, glob
from pathlib import Path
log=Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log").read_bytes().replace(b"\x00",b"").decode("utf-8","replace")
lines=log.splitlines()
# last start with terminal:4
idx=0
for i,l in enumerate(lines):
  if '"event":"revalidate_v3_start"' in l and '"terminal":4' in l:
    idx=i
chunk=lines[idx:]
dones=[]
resumes=0
for l in chunk:
  if '"event":"frontier_resume"' in l:
    resumes += 1
  if '"event":"lead_done"' not in l:
    continue
  try:
    dones.append(json.loads(l[l.find("{"):]))
  except Exception:
    pass
term=[d for d in dones if d.get("kind")=="terminal"]
retry=[d for d in dones if d.get("kind")=="retry"]
print(json.dumps({
  "since_resume_deploy": {
    "outcomes": len(dones),
    "terminal": len(term),
    "retry": len(retry),
    "retry_rate": round(len(retry)/max(1,len(dones)),3),
    "frontier_resume_events": resumes,
    "terminals": [(t.get("id"), t.get("processingState")) for t in term],
  }
}, indent=2))
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print(json.dumps({
  "checkpoint": {
    "terminal": len(cp.get("terminal") or {}),
    "retry": len(cp.get("retryQueue") or {}),
    "inProgress": len(cp.get("inProgress") or {}),
    "by_state": {k: sum(1 for v in (cp.get("terminal") or {}).values() if v.get("processingState")==k) for k in sorted({v.get("processingState") for v in (cp.get("terminal") or {}).values()})},
  }
}, indent=2))
# long OCR worker pdf states
for lid in list((cp.get("inProgress") or {}).keys())[:3]:
  fps=sorted(
    glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{lid}*.sqlite")
    + glob.glob(f"/opt/leadsniper-revalidate/app/data/revalidation/frontiers/*{lid}*.sqlite"),
    key=lambda p: Path(p).stat().st_mtime, reverse=True)
  if not fps: continue
  c=sqlite3.connect(f"file:{fps[0]}?mode=ro", uri=True)
  print(lid, "pdf", c.execute("select state,count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
  c.close()
# wall p50/p95 from recent results
walls=[]
for f in Path("/opt/leadsniper-revalidate/data/revalidation/results").glob("*.json"):
  try: r=json.loads(f.read_text())
  except: continue
  w=r.get("wallMs") or (r.get("pass1") or {}).get("wallMs")
  if isinstance(w,(int,float)) and w>0: walls.append(w)
walls.sort()
def pct(p):
  if not walls: return None
  i=min(len(walls)-1, int(round((p/100)*(len(walls)-1))))
  return walls[i]
print(json.dumps({"wall_ms":{"n":len(walls),"p50":pct(50),"p95":pct(95),"max":walls[-1] if walls else None}}, indent=2))
PY
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-v3.mjs /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs /opt/leadsniper-revalidate/app/src/lib/sanita/crawl-slice-runner.ts
systemctl is-active giorgio-revalidate
free -h | head -2

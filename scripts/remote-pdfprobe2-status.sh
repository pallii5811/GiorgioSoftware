#!/usr/bin/env bash
set -uo pipefail
LOG=$(ls -t /opt/leadsniper-revalidate/logs/probe-pdfprio2-*.log 2>/dev/null | head -1)
echo "log=$LOG size=$(wc -c < "$LOG" 2>/dev/null || echo 0)"
tail -n 25 "$LOG" 2>/dev/null | tr -d '\000'
python3 - <<'PY'
import json, sqlite3, glob
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print("term", len(cp.get("terminal") or {}), "retry", len(cp.get("retryQueue") or {}), "inprog", list((cp.get("inProgress") or {}).keys()))
ids=list((cp.get("inProgress") or {}).keys())
if not ids:
  ids=Path("/tmp/probe2-ids.txt").read_text().strip().split(",")[:1]
for ID in ids[:1]:
  fps=sorted(glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{ID}*.sqlite"), key=lambda x: Path(x).stat().st_mtime, reverse=True)
  print("ID", ID, "fp", fps[0] if fps else None)
  if not fps: continue
  c=sqlite3.connect(f"file:{fps[0]}?mode=ro", uri=True)
  print("pdf", c.execute("select state, count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
  print("html_done", c.execute("select count(*) from CrawlFrontierNode where resourceType='html' and state='COMPLETED'").fetchone()[0])
  print("hb", c.execute("select lastHeartbeatAt, lastHeartbeatNote from CrawlRun").fetchone())
  c.close()
PY
pgrep -af 'production-revalidate-sanita' | head -8 || echo no_procs
free -h | head -2

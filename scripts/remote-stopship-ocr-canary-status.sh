#!/usr/bin/env bash
set -euo pipefail
LOG=/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log
OUT=/tmp/stopship-ocr-diag

echo "=== OCR_RENDERER_MISSING ==="
grep -c OCR_RENDERER_MISSING "$LOG" || echo 0

echo "=== events ==="
grep -E '"event":"(frontier_resume|lead_|worker_|metrics|done|error|classified)' "$LOG" | tail -40 || true

echo "=== frontiers ==="
python3 - <<'PY'
import json, sqlite3
from pathlib import Path
ids = {
  "maione": "cmqkld5s700a8108eti0nofjv",
  "alba": "cmql46eia000ac9w78xh0rxdl",
}
base = Path("/opt/leadsniper-revalidate/app/data/revalidation/frontiers")
out = {}
for name, lid in ids.items():
  matches = sorted(base.glob(f"reval-p1-{lid}-*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)
  if not matches:
    out[name] = {"missing": True}
    continue
  fp = matches[0]
  c = sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
  by = dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
  pdf = c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode WHERE resourceType='pdf' OR canonicalUrl LIKE '%.pdf%' GROUP BY state").fetchall()
  run = c.execute("SELECT totalCompleted,totalPending,totalFailed,stopReason,state,currentCheckpoint FROM CrawlRun ORDER BY rowid DESC LIMIT 1").fetchone()
  ocr_ev = c.execute("SELECT COUNT(*) FROM CrawlNodeEvidence WHERE ocrStatus IS NOT NULL AND ocrStatus != ''").fetchone()[0] if True else 0
  try:
    ocr_ev = c.execute("SELECT ocrStatus, COUNT(*) FROM CrawlNodeEvidence WHERE ocrStatus IS NOT NULL GROUP BY ocrStatus").fetchall()
  except Exception as e:
    ocr_ev = str(e)
  out[name] = {"byState": by, "pdfByState": dict(pdf), "run": list(run) if run else None, "ocrEvidence": ocr_ev}
  c.close()
print(json.dumps(out, indent=2))
Path("/tmp/stopship-ocr-diag/canary-frontier-progress.json").write_text(json.dumps(out, indent=2))
PY

echo "=== results mtime ==="
ls -lt /opt/leadsniper-revalidate/data/revalidation/results/cmqkld5s700a8108eti0nofjv*.json /opt/leadsniper-revalidate/data/revalidation/results/cmql46eia000ac9w78xh0rxdl*.json 2>/dev/null || true

echo "=== checkpoint ==="
python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
for lid in ["cmqkld5s700a8108eti0nofjv","cmql46eia000ac9w78xh0rxdl"]:
  print(lid, {
    "inProgress": (c.get("inProgress") or {}).get(lid),
    "terminal": (c.get("terminal") or {}).get(lid),
    "retry": (c.get("retryQueue") or {}).get(lid),
  })
PY

echo "=== procs ==="
ps -eo pid,etime,cmd | grep -E 'revalidate-sanita' | grep -v grep | head -8 || echo none

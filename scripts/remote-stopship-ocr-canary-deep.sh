#!/usr/bin/env bash
set -euo pipefail
OUT=/tmp/stopship-ocr-diag
LOG=/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log
FP=/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite

echo "=== canary log since frontier_resume ==="
awk '/frontier_resume/,0' "$LOG" | tail -80

echo "=== worker open files (pdf/png/tess) ==="
WP=$(ps -eo pid,cmd | awk '/production-revalidate-sanita-worker.mjs/ && /node --require/ {print $1; exit}')
echo "worker_pid=$WP"
if [ -n "${WP:-}" ]; then
  ls -l /proc/$WP/fd 2>/dev/null | grep -E 'pdf|png|tess|frontier|sqlite|tmp' | head -40 || true
  tr '\0' '\n' < /proc/$WP/environ | grep -E '^(PDFTOPPM|OCR_|TESSDATA)=' || true
  # recent child procs
  ps --ppid $WP -o pid,etime,cmd 2>/dev/null || true
  pgrep -a pdftoppm || true
  pgrep -a tesseract || true
fi

echo "=== maione frontier node detail ==="
python3 - <<'PY'
import sqlite3, json
fp="/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite"
c=sqlite3.connect(fp)
print("tables", [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")])
# schema peek
for t in ("CrawlFrontierNode","CrawlRun"):
  try:
    cols=[r[1] for r in c.execute(f"PRAGMA table_info({t})")]
    print(t, cols)
  except Exception as e:
    print(t, e)
by=dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
print("byState", by)
# sample TECHNICAL_BLOCKED
rows=c.execute("SELECT id,url,state,lastError,attempts,contentType FROM CrawlFrontierNode WHERE state='TECHNICAL_BLOCKED' LIMIT 5").fetchall()
print("sample_blocked", rows)
# FETCHED/QUEUED
rows2=c.execute("SELECT id,url,state,lastError,attempts FROM CrawlFrontierNode WHERE state IN ('QUEUED','FETCHED','RUNNING','IN_PROGRESS') LIMIT 10").fetchall()
print("active", rows2)
run=c.execute("SELECT * FROM CrawlRun ORDER BY rowid DESC LIMIT 1").fetchone()
cols=[r[1] for r in c.execute("PRAGMA table_info(CrawlRun)")]
print("run", dict(zip(cols, run)) if run else None)
c.close()
PY

echo "=== checkpoint for 2 leads ==="
python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
for lid in ["cmqkld5s700a8108eti0nofjv","cmql46eia000ac9w78xh0rxdl"]:
  print(lid, {
    "inProgress": (c.get("inProgress") or {}).get(lid),
    "retry": (c.get("retryQueue") or {}).get(lid),
    "terminal": (c.get("terminal") or {}).get(lid),
    "attempts": (c.get("attempts") or {}).get(lid),
  })
print("inProgress_keys", list((c.get("inProgress") or {}).keys()))
PY

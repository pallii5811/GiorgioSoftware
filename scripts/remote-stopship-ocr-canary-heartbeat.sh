#!/usr/bin/env bash
set -euo pipefail
FP=/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite
python3 - <<'PY'
import sqlite3, time, json
fp="/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite"
c=sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
cols=[r[1] for r in c.execute("PRAGMA table_info(CrawlRun)")]
run=dict(zip(cols, c.execute("SELECT * FROM CrawlRun ORDER BY rowid DESC LIMIT 1").fetchone()))
print("run", {k:run[k] for k in ("state","startedAt","heartbeatAt","currentCheckpoint","stopReason","totalFailed","totalPending","totalCompleted","workerLock")})
pdf=c.execute("SELECT id,canonicalUrl,state,lastError,updatedAt,contentHash FROM CrawlFrontierNode WHERE resourceType='pdf' OR canonicalUrl LIKE '%.pdf%'").fetchall()
print("pdfs", json.dumps(pdf, indent=2))
by=dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
print("byState", by)
c.close()
print("now_iso", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
PY
echo "=== checkpoint inProgress ==="
python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
ip=(c.get("inProgress") or {}).get("cmqkld5s700a8108eti0nofjv")
print(json.dumps(ip, indent=2))
PY
echo "=== recent heartbeats / log growth ==="
wc -l /opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log
tail -n 20 /opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log
# worker children
WP=$(ps -eo pid,cmd | awk '/node --require/ && /production-revalidate-sanita-worker.mjs/ {print $1; exit}')
echo worker=$WP
ps --ppid "$WP" -o pid,etime,%cpu,cmd 2>/dev/null | head -10 || true
# pdftoppm running?
ps -eo pid,etime,cmd | grep -E 'pdftoppm|tesseract' | grep -v grep || echo 'no pdftoppm/tesseract'
# strace snapshot? skip — check /tmp for ocr
ls -lt /tmp 2>/dev/null | head -5
find /tmp -name '*.png' -mmin -30 2>/dev/null | head -10
find /tmp -name '*ocr*' -mmin -30 2>/dev/null | head -10

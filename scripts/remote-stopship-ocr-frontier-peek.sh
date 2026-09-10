#!/usr/bin/env bash
set -euo pipefail
FP=/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite
python3 - <<'PY'
import sqlite3, json
fp="/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite"
c=sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
by=dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
print("byState", by)
errs=c.execute("SELECT lastError, COUNT(*) FROM CrawlFrontierNode WHERE state='TECHNICAL_BLOCKED' GROUP BY lastError").fetchall()
print("blocked_errors", errs[:20])
pdfs=c.execute("SELECT state, resourceType, COUNT(*) FROM CrawlFrontierNode GROUP BY state, resourceType").fetchall()
print("byStateType", pdfs)
samples=c.execute("SELECT id, canonicalUrl, state, lastError, retryCount, resourceType FROM CrawlFrontierNode WHERE state='TECHNICAL_BLOCKED' LIMIT 8").fetchall()
print("samples", json.dumps(samples, indent=2))
active=c.execute("SELECT id, canonicalUrl, state, lastError, resourceType FROM CrawlFrontierNode WHERE state IN ('QUEUED','FETCHED','FETCHING','RETRY_PENDING')").fetchall()
print("active", json.dumps(active, indent=2))
run=dict(zip([r[1] for r in c.execute('PRAGMA table_info(CrawlRun)')], c.execute('SELECT * FROM CrawlRun ORDER BY rowid DESC LIMIT 1').fetchone()))
print("run_stop", run.get("stopReason"), run.get("state"), "failed", run.get("totalFailed"), "pending", run.get("totalPending"))
c.close()
PY
echo "=== worker still? ==="
ps -eo pid,etime,cmd | grep -E 'revalidate-sanita-worker.mjs' | grep -v grep | head -5
grep -c OCR_RENDERER_MISSING /opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log || true
tail -n 8 /opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log

#!/usr/bin/env bash
set -uo pipefail
LOG=$(ls -t /opt/leadsniper-revalidate/logs/probe-pdfprio-*.log 2>/dev/null | head -1)
echo "log=$LOG"
tail -n 30 "$LOG" 2>/dev/null | tr -d '\000'
echo "=== CP ==="
python3 -c 'import json;cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print(len(cp.get("terminal")or{}),len(cp.get("retryQueue")or{}),list((cp.get("inProgress")or{}).keys()))'
ID=$(python3 -c 'import json;cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print(list((cp.get("inProgress")or{}).keys())[0] if cp.get("inProgress") else "")')
echo "inprog=$ID"
if [ -n "$ID" ]; then
  FP=$(ls -t /opt/leadsniper-revalidate/data/revalidation/frontiers/*${ID}*.sqlite 2>/dev/null | head -1)
  echo "fp=$FP"
  python3 - <<PY
import sqlite3
p="$FP"
if not p: raise SystemExit
c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
print("pdf", c.execute("select state, count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
print("html completed", c.execute("select count(*) from CrawlFrontierNode where resourceType='html' and state='COMPLETED'").fetchone()[0])
print("heartbeat", c.execute("select lastHeartbeatAt, lastHeartbeatNote from CrawlRun").fetchone())
c.close()
PY
fi
free -h | head -2
pgrep -c -f chrome-headless-shell || echo chrome=0

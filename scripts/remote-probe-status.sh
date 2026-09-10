#!/usr/bin/env bash
set -uo pipefail
echo "=== PROCS ==="
pgrep -af 'production-revalidate|tsx' | head -30 || true
echo "=== MEM ==="
free -h
echo "=== LATEST PROBE LOG ==="
ls -lt /opt/leadsniper-revalidate/logs/probe-3-*.log 2>/dev/null | head -3
LOG=$(ls -t /opt/leadsniper-revalidate/logs/probe-3-*.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
  echo "log=$LOG size=$(wc -c < "$LOG")"
  tail -n 40 "$LOG" | tr -d '\000'
fi
echo "=== CP ==="
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print(json.dumps({
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": cp.get("inProgress") or {},
}, indent=2))
PY
echo "=== LOCKS ==="
ls /opt/leadsniper-revalidate/data/revalidation/locks 2>/dev/null | head
ls /opt/leadsniper-revalidate/app/data/revalidation/locks 2>/dev/null | head

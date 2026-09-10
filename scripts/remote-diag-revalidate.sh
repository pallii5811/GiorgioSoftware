#!/usr/bin/env bash
set -euo pipefail
echo "=== PID ==="
PIDFILE=/opt/leadsniper-revalidate/revalidate.pid
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  echo "pidfile=$PID"
  if kill -0 "$PID" 2>/dev/null; then
    echo "alive=1"
    ps -p "$PID" -o pid,etime,pcpu,pmem,cmd --no-headers || true
  else
    echo "alive=0"
  fi
else
  echo "pidfile=missing"
fi
echo "=== tsx processes ==="
pgrep -af 'production-revalidate|tsx.*revalidate' || echo none
echo "=== checkpoint ==="
python3 - <<'PY'
import json
p="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
try:
  cp=json.load(open(p))
  print(json.dumps({
    "done": len(cp.get("done") or {}),
    "stats": cp.get("stats"),
    "testedCodeSha": cp.get("testedCodeSha"),
    "updatedAt": cp.get("updatedAt"),
    "startedAt": cp.get("startedAt"),
  }, indent=2))
except Exception as e:
  print("err", e)
PY
echo "=== results count ==="
ls /opt/leadsniper-revalidate/data/revalidation/results 2>/dev/null | wc -l
echo "=== last log ==="
for f in /opt/leadsniper-revalidate/logs/revalidate*.log; do
  echo "-- $f --"
  tail -n 30 "$f" 2>/dev/null || true
done
echo "=== release sha ==="
cat /opt/leadsniper/RELEASE_SHA 2>/dev/null || true
cat /opt/leadsniper-green/RELEASE_SHA 2>/dev/null || true
echo "=== load ==="
uptime
free -m | head -2
df -h /opt | tail -1

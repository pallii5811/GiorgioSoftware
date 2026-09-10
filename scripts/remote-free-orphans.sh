#!/usr/bin/env bash
set -uo pipefail
# Stop green smoke instance; kill orphan chromium NOT in revalidate tree.
REVAL_PID=$(cat /opt/leadsniper-revalidate/revalidate.pid 2>/dev/null || true)
pm2 stop leadsniper-green 2>/dev/null || true
pm2 delete leadsniper-green 2>/dev/null || true

# Collect PIDs in reval process group
KEEP=""
if [ -n "$REVAL_PID" ] && kill -0 "$REVAL_PID" 2>/dev/null; then
  KEEP=$(pstree -p "$REVAL_PID" 2>/dev/null | grep -oE '[0-9]+' | sort -u | tr '\n' ' ')
fi
echo "KEEP_COUNT=$(echo $KEEP | wc -w)"

killed=0
for pid in $(pgrep -f 'chrome-headless-shell|chromium' || true); do
  skip=0
  for k in $KEEP; do
    if [ "$pid" = "$k" ]; then skip=1; break; fi
  done
  if [ "$skip" = "1" ]; then continue; fi
  # also keep children of current next-server briefly? kill orphans only if etime > 1 day
  etime=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$etime" ] && [ "$etime" -gt 3600 ]; then
    kill "$pid" 2>/dev/null || true
    killed=$((killed+1))
  fi
done
sleep 2
# force leftover orphans
for pid in $(pgrep -f 'chrome-headless-shell' || true); do
  skip=0
  for k in $KEEP; do
    if [ "$pid" = "$k" ]; then skip=1; break; fi
  done
  if [ "$skip" = "1" ]; then continue; fi
  etime=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$etime" ] && [ "$etime" -gt 3600 ]; then
    kill -9 "$pid" 2>/dev/null || true
    killed=$((killed+1))
  fi
done
echo "killed_orphans=$killed"
free -m | head -2
pgrep -c -f 'chrome-headless-shell' || echo chrome_count=0
pgrep -af 'production-revalidate' | head -5 || true

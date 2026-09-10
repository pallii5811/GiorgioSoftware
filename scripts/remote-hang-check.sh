#!/usr/bin/env bash
set -uo pipefail
echo "=== procs ==="
ps -eo pid,etime,pcpu,pmem,cmd --sort=-pcpu | head -20
echo "=== reval tree ==="
PID=$(cat /opt/leadsniper-revalidate/revalidate.pid 2>/dev/null || echo)
if [ -n "$PID" ]; then
  pstree -p "$PID" 2>/dev/null || ps --forest -g $(ps -o sid= -p "$PID") 2>/dev/null || true
fi
echo "=== open files / chrome ==="
pgrep -af 'chrome|chromium|playwright|pdftoppm|tesseract' | head -30 || true
echo "=== latest log tail ==="
LOG=$(ls -1t /opt/leadsniper-revalidate/logs/revalidate-*.log | head -1)
echo "LOG=$LOG"
tail -n 80 "$LOG"
echo "=== frontiers ==="
ls -lt /opt/leadsniper-revalidate/data/revalidation/frontiers 2>/dev/null | head -10
echo "=== results ==="
ls -lt /opt/leadsniper-revalidate/data/revalidation/results 2>/dev/null | head -10
echo "=== disk io ==="
iostat -x 1 2 2>/dev/null | tail -20 || true
